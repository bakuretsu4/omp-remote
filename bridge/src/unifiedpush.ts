/**
 * UnifiedPush wake pushes (https://unifiedpush.org). The phone registers an endpoint URL that its distributor app
 * (for example ntfy) gave it; the bridge POSTs a content-free wake to that URL, the distributor hands it to the app, and
 * the app then connects over the encrypted channel and reads what happened. Nothing about a session reaches the push server.
 *
 * The endpoint URL comes from a paired phone, so the bridge treats it as untrusted input: https only, no credentials,
 * never a loopback / private / link-local address (checked on the literal and again on every address the name resolves to),
 * no redirects, short timeout.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { SendResult } from "./push.ts";

export interface UpTarget {
	did: string;
	endpoint: string;
}

export const MAX_ENDPOINT_LENGTH = 2048;
const TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 4;

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	NON_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses (IPv4-mapped IPv6 included). */
export function isNonPublicAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 0) return false;
	return NON_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Why an endpoint is not acceptable, or null when it is. Literal checks only; names are checked again when sending. */
export function endpointProblem(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length === 0) return "endpoint must be a non-empty string";
	if (raw.length > MAX_ENDPOINT_LENGTH) return "endpoint is too long";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "endpoint is not a valid URL";
	}
	if (url.protocol !== "https:") return "endpoint must use https";
	if (url.username || url.password) return "endpoint must not contain credentials";
	if (url.hash) return "endpoint must not contain a fragment";
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
		return "endpoint must point at a public host";
	}
	if (isIP(host) !== 0 && isNonPublicAddress(host)) return "endpoint must point at a public host";
	return null;
}

type Outcome = "sent" | "dead" | "failed";

export class UnifiedPushSender {
	readonly #hostId: string;
	readonly #fetch: typeof fetch;
	readonly #resolve: (host: string) => Promise<string[]>;
	readonly #log: (m: string) => void;

	constructor(opts: {
		hostId: string;
		fetch?: typeof fetch;
		/** Resolves a host name to its addresses; injectable for tests. */
		resolve?: (host: string) => Promise<string[]>;
		log?: (m: string) => void;
	}) {
		this.#hostId = opts.hostId;
		this.#fetch = opts.fetch ?? fetch;
		this.#resolve = opts.resolve ?? (async host => (await lookup(host, { all: true })).map(a => a.address));
		this.#log = opts.log ?? (() => {});
	}

	async send(targets: UpTarget[]): Promise<SendResult> {
		const result: SendResult = { sent: 0, failed: 0, dead: [] };
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < targets.length) {
				const t = targets[next++]!;
				let outcome: Outcome;
				try {
					outcome = await this.#sendOne(t.endpoint);
				} catch {
					outcome = "failed";
				}
				if (outcome === "sent") result.sent++;
				else if (outcome === "dead") result.dead.push(t.did);
				else result.failed++;
			}
		};
		await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, targets.length) }, worker));
		if (targets.length > 0) this.#log(`unifiedpush: sent=${result.sent} failed=${result.failed} dead=${result.dead.length}`);
		return result;
	}

	async #sendOne(endpoint: string): Promise<Outcome> {
		// A stored endpoint that would not be accepted today is dropped rather than called.
		if (endpointProblem(endpoint) !== null) return "dead";
		const url = new URL(endpoint);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (isIP(host) === 0) {
			const addresses = await this.#resolve(host);
			if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
				this.#log("unifiedpush: refused an endpoint that resolves to a non-public address");
				return "failed";
			}
		}
		const res = await this.#fetch(endpoint, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "Content-Type": "application/json", TTL: "60", Urgency: "high" },
			body: JSON.stringify({ w: "1", h: this.#hostId }),
		});
		await res.body?.cancel().catch(() => {});
		if (res.status >= 200 && res.status < 300) return "sent";
		if (res.status === 404 || res.status === 410) return "dead";
		return "failed";
	}
}
