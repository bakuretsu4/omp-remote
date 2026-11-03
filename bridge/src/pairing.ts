/**
 * Pairing (PROTOCOL.md §4): single-use, 10-minute tokens held in memory only, pair handshake over PAIR
 * frames sealed with the token-derived pairKey, optional interactive confirmation.
 *
 * Anything that does not authenticate under an active token gets silence.
 */
import { randomBytes } from "node:crypto";
import {
	aad, b64u, deviceKeyFrom, ecdh, open, pairKeyFrom, sasOf, seal, unb64u,
} from "../../protocol/src/crypto.ts";
import { FRAME_PAIR, type PairReq, type PairRes } from "../../protocol/src/index.ts";
import type { DeviceStore, Device } from "./devices.ts";
import { isRecord } from "./guards.ts";
import { cleanLabel } from "./sanitize.ts";
import type { Identity } from "./identity.ts";

export const PAIR_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export interface PairBegin {
	/**
	 * Ask a human before accepting; `sas` is the 6-digit code ("230 428") the phone must be showing too.
	 * Resolve true to accept. Absent → accept automatically (anyone holding the link can pair).
	 */
	confirm?: (label: string, sas: string) => Promise<boolean>;
	onPaired?: (device: Device) => void;
	onDenied?: (reason: string) => void;
	relays: string[];
	ttlMs?: number;
}

export interface PairSession {
	link: string;
	expiresAt: number;
	cancel(): void;
}

interface ActiveToken {
	pt: Buffer;
	pairKey: Buffer;
	expiresAt: number;
	/** A pair-req for this token is awaiting confirmation. */
	pending: boolean;
	opts: PairBegin;
	timer: NodeJS.Timeout;
}

export interface PairingOptions {
	identity: Identity;
	devices: DeviceStore;
	hostName: string;
	log: (m: string) => void;
	now?: () => number;
	/** Injectable randomness (test vectors). */
	random?: { token?: () => Buffer; did?: () => Buffer; iv?: () => Buffer };
}

/**
 * Pairing link v2. The permanent roomSecret never leaves the bridge: the phone only learns the derived roomId.
 * `ompr://pair?v=2&name=…&rid=<22-char roomId>&bpk=…&pt=…&r=<relay>[&r=…]`
 */
export function buildPairLink(id: Identity, name: string, pt: Uint8Array, relays: string[]): string {
	const q = [
		"v=2",
		`name=${encodeURIComponent(name)}`,
		`rid=${id.roomId}`,
		`bpk=${id.bpk}`,
		`pt=${b64u(pt)}`,
		...relays.map(r => `r=${encodeURIComponent(r)}`),
	];
	return `ompr://pair?${q.join("&")}`;
}

export class PairingManager {
	readonly #o: PairingOptions;
	readonly #now: () => number;
	readonly #active = new Set<ActiveToken>();

	constructor(o: PairingOptions) {
		this.#o = o;
		this.#now = o.now ?? Date.now;
	}

	get activeCount(): number {
		return this.#active.size;
	}

	begin(opts: PairBegin): PairSession {
		const pt = this.#o.random?.token?.() ?? randomBytes(32);
		const ttl = opts.ttlMs ?? PAIR_TTL_MS;
		const expiresAt = this.#now() + ttl;
		const tok: ActiveToken = {
			pt,
			pairKey: pairKeyFrom(pt),
			expiresAt,
			pending: false,
			opts,
			timer: setTimeout(() => this.#drop(tok, "expired"), ttl),
		};
		tok.timer.unref();
		this.#active.add(tok);
		return {
			link: buildPairLink(this.#o.identity, this.#o.hostName, pt, opts.relays),
			expiresAt,
			cancel: () => this.#drop(tok, "cancelled"),
		};
	}

	#drop(tok: ActiveToken, reason: string): void {
		if (!this.#active.delete(tok)) return;
		clearTimeout(tok.timer);
		tok.pt.fill(0);
		tok.pairKey.fill(0);
		if (reason !== "paired") tok.opts.onDenied?.(reason);
	}

	/** Handles one PAIR frame payload. Resolves to the reply frame payload, or null for silence. */
	async handle(payload: Buffer): Promise<Buffer | null> {
		if (payload[0] !== FRAME_PAIR || this.#active.size === 0) return null;
		const sealed = payload.subarray(1);
		let tok: ActiveToken | undefined;
		let req: unknown;
		for (const t of this.#active) {
			if (this.#now() >= t.expiresAt) continue;
			try {
				req = JSON.parse(open(t.pairKey, sealed, aad(FRAME_PAIR, "C")).toString("utf8"));
				tok = t;
				break;
			} catch {
				// wrong token: try the next one
			}
		}
		if (!tok) return null;
		if (tok.pending) return this.#reply(tok, { t: "pair-no", reason: "busy" });
		if (!isRecord(req) || req.t !== "pair-req" || typeof req.dpk !== "string" || typeof req.ts !== "number") return null;
		const pr = req as unknown as PairReq;
		const dpk = unb64u(pr.dpk);
		if (dpk.length !== 65 || dpk[0] !== 0x04) return this.#finish(tok, { t: "pair-no", reason: "bad device key" });
		if (Math.abs(this.#now() - pr.ts) > CLOCK_SKEW_MS) return this.#finish(tok, { t: "pair-no", reason: "clock skew" });
		const label = cleanLabel(pr.label);
		const sas = sasOf(tok.pt, dpk, this.#o.identity.pub);

		let shared: Buffer;
		try {
			shared = ecdh(this.#o.identity.priv, dpk);
		} catch {
			return this.#finish(tok, { t: "pair-no", reason: "bad device key" });
		}

		if (tok.opts.confirm) {
			tok.pending = true;
			let ok = false;
			try {
				ok = await tok.opts.confirm(label, sas);
			} catch {
				ok = false;
			}
			if (!this.#active.has(tok)) return null; // expired or cancelled while asking
			if (!ok) return this.#finish(tok, { t: "pair-no", reason: "denied" });
		}

		const did = this.#o.random?.did?.() ?? randomBytes(8);
		const kDev = deviceKeyFrom(shared, tok.pt);
		const device = this.#o.devices.add({ did: b64u(did), label, dpk: pr.dpk, kDev: b64u(kDev) });
		kDev.fill(0);
		shared.fill(0);
		this.#o.log(`paired device ${device.did} (${label})`);
		const reply = this.#reply(tok, { t: "pair-ok", did: device.did, hostId: this.#o.identity.hostId, name: this.#o.hostName });
		this.#drop(tok, "paired");
		tok.opts.onPaired?.(device);
		return reply;
	}

	/** A denial or protocol failure burns the token (single use). */
	#finish(tok: ActiveToken, res: PairRes): Buffer {
		const reply = this.#reply(tok, res);
		this.#drop(tok, res.t === "pair-no" ? res.reason : "failed");
		return reply;
	}

	#reply(tok: ActiveToken, res: PairRes): Buffer {
		const sealed = seal(tok.pairKey, Buffer.from(JSON.stringify(res), "utf8"), aad(FRAME_PAIR, "B"), this.#o.random?.iv?.());
		return Buffer.concat([Buffer.from([FRAME_PAIR]), sealed]);
	}
}
