import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ServiceAccount {
	client_email: string;
	private_key: string;
	project_id: string;
	token_uri?: string;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const MAX_CONCURRENCY = 4;

export function loadServiceAccount(path: string): ServiceAccount {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(`cannot read service account file: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("service account file is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("service account file must contain a JSON object");
	}
	const o = parsed as Record<string, unknown>;
	for (const field of ["client_email", "private_key", "project_id"] as const) {
		if (typeof o[field] !== "string" || o[field] === "") {
			throw new Error(`service account is missing required field: ${field}`);
		}
	}
	if (o.token_uri !== undefined && (typeof o.token_uri !== "string" || o.token_uri === "")) {
		throw new Error("service account field token_uri must be a non-empty string");
	}
	const sa: ServiceAccount = {
		client_email: o.client_email as string,
		private_key: o.private_key as string,
		project_id: o.project_id as string,
	};
	if (o.token_uri !== undefined) sa.token_uri = o.token_uri as string;
	return sa;
}

function b64url(data: string | Buffer): string {
	return Buffer.from(data).toString("base64url");
}

export function buildServiceAccountJwt(sa: ServiceAccount, nowSec: number): string {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = b64url(
		JSON.stringify({
			iss: sa.client_email,
			scope: FCM_SCOPE,
			aud: sa.token_uri ?? DEFAULT_TOKEN_URI,
			iat: nowSec,
			exp: nowSec + 3600,
		}),
	);
	const input = `${header}.${claims}`;
	const signer = createSign("RSA-SHA256");
	signer.update(input);
	return `${input}.${signer.sign(sa.private_key).toString("base64url")}`;
}

export function buildFcmMessage(token: string, hostId: string): object {
	return {
		message: {
			token,
			data: { w: "1", h: hostId },
			android: { priority: "HIGH", ttl: "60s" },
		},
	};
}

export interface PushTarget {
	did: string;
	token: string;
}

export interface SendResult {
	sent: number;
	failed: number;
	/** dids whose token FCM reports gone */
	dead: string[];
}

type Outcome = "sent" | "dead" | "failed";

interface CachedToken {
	value: string;
	expiresAtMs: number;
}

export class PushSender {
	readonly enabled: boolean;
	private readonly sa: ServiceAccount | undefined;
	private readonly hostId: string;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly log: (m: string) => void;
	private cached: CachedToken | undefined;
	private inflight: Promise<string> | undefined;

	constructor(opts: {
		serviceAccountPath?: string;
		hostId: string;
		fetch?: typeof fetch;
		now?: () => number;
		log?: (m: string) => void;
	}) {
		this.hostId = opts.hostId;
		this.fetchFn = opts.fetch ?? fetch;
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		let sa: ServiceAccount | undefined;
		if (opts.serviceAccountPath) {
			try {
				sa = loadServiceAccount(opts.serviceAccountPath);
			} catch (e) {
				this.log(`push disabled: ${(e as Error).message}`);
			}
		}
		this.sa = sa;
		this.enabled = sa !== undefined;
	}

	async send(targets: PushTarget[]): Promise<SendResult> {
		const result: SendResult = { sent: 0, failed: 0, dead: [] };
		if (!this.enabled || targets.length === 0) {
			result.failed = this.enabled ? 0 : targets.length;
			return result;
		}
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < targets.length) {
				const t = targets[next++]!;
				let outcome: Outcome;
				try {
					outcome = await this.sendOne(t.token);
				} catch {
					outcome = "failed";
				}
				if (outcome === "sent") result.sent++;
				else if (outcome === "dead") result.dead.push(t.did);
				else result.failed++;
			}
		};
		const n = Math.min(MAX_CONCURRENCY, targets.length);
		await Promise.all(Array.from({ length: n }, worker));
		this.log(`push: sent=${result.sent} failed=${result.failed} dead=${result.dead.length}`);
		return result;
	}

	private async sendOne(deviceToken: string): Promise<Outcome> {
		for (let attempt = 0; attempt < 2; attempt++) {
			let access: string;
			try {
				access = await this.getAccessToken();
			} catch (e) {
				this.log(`push: token exchange failed: ${(e as Error).message}`);
				return "failed";
			}
			let res: Response;
			try {
				res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.sa!.project_id}/messages:send`, {
					method: "POST",
					headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
					body: JSON.stringify(buildFcmMessage(deviceToken, this.hostId)),
				});
			} catch {
				this.log("push: network error");
				return "failed";
			}
			if (res.status === 200) return "sent";
			if (res.status === 401 && attempt === 0) {
				this.cached = undefined;
				continue;
			}
			if (res.status === 404) return "dead";
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				body = undefined;
			}
			if (isDeadResponse(res.status, body)) return "dead";
			this.log(`push: FCM HTTP ${res.status}`);
			return "failed";
		}
		return "failed";
	}

	private getAccessToken(): Promise<string> {
		const c = this.cached;
		if (c && this.now() < c.expiresAtMs) return Promise.resolve(c.value);
		if (this.inflight) return this.inflight;
		const p = this.exchange().finally(() => {
			if (this.inflight === p) this.inflight = undefined;
		});
		this.inflight = p;
		return p;
	}

	private async exchange(): Promise<string> {
		const sa = this.sa!;
		const nowMs = this.now();
		const jwt = buildServiceAccountJwt(sa, Math.floor(nowMs / 1000));
		const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`;
		const res = await this.fetchFn(sa.token_uri ?? DEFAULT_TOKEN_URI, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
		if (typeof json.access_token !== "string" || json.access_token === "") {
			throw new Error("response lacks access_token");
		}
		const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
		const value = json.access_token;
		this.cached = { value, expiresAtMs: nowMs + Math.max(0, expiresIn - 60) * 1000 };
		return value;
	}
}

function isDeadResponse(status: number, body: unknown): boolean {
	const err = (body as { error?: { message?: unknown; details?: unknown } } | undefined)?.error;
	if (!err || typeof err !== "object") return false;
	const details = Array.isArray(err.details) ? (err.details as Record<string, unknown>[]) : [];
	const codes = details.map((d) => d?.errorCode);
	if (codes.includes("UNREGISTERED")) return true;
	if (status === 400 && codes.includes("INVALID_ARGUMENT")) {
		const text = `${typeof err.message === "string" ? err.message : ""} ${JSON.stringify(details)}`;
		return /token/i.test(text);
	}
	return false;
}
