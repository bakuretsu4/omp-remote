/**
 * Bridge side of one L1 secure channel (one relay peer): HELLO handshake (PROTOCOL.md §5), DATA frames with
 * per-direction `q` replay protection, ping/pong. Transport-agnostic: the caller feeds frame payloads in
 * (`receive`) and supplies a `send` for raw payloads.
 *
 * Unknown/revoked devices and failed authentication get silence: nothing is ever sent back.
 */
import { randomBytes } from "node:crypto";
import {
	aad, b64u, ecdh, generateKeypair, open, seal, sessionKeys, unb64u,
} from "../../protocol/src/crypto.ts";
import {
	FRAME_DATA, FRAME_HELLO, FRAME_PAIR, MAX_PLAINTEXT,
	type AppToBridge, type BridgeToApp, type DeviceCap, type HostInfo,
} from "../../protocol/src/index.ts";
import type { DeviceStore } from "./devices.ts";
import { isRecord } from "./guards.ts";
import { cleanLabel } from "./sanitize.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A bridge→app message before the channel stamps its `q`. */
export type Outgoing = DistributiveOmit<BridgeToApp, "q">;

export type ChannelState = "new" | "open" | "blocked" | "closed";

export interface ChannelRandom {
	ephemeral(): { priv: Buffer; pub: Buffer };
	nonce(): Buffer;
	iv(): Buffer;
}

const defaultRandom: ChannelRandom = {
	ephemeral: generateKeypair,
	nonce: () => randomBytes(16),
	iv: () => randomBytes(12),
};

/** Failure bookkeeping for one relay peer. Owned by the caller so it survives Channel re-creation. */
export interface PeerCounters {
	/** Invalid DATA frames. */
	frames: number;
	/** Failed HELLOs. */
	hello: number;
	/** PAIR frames seen. */
	pair: number;
	/** Exceeded a threshold: every later frame from this peer is dropped without any work. */
	blocked: boolean;
	lastLog: number;
}

export const newPeerCounters = (): PeerCounters => ({ frames: 0, hello: 0, pair: 0, blocked: false, lastLog: 0 });

/**
 * HELLO nonces seen recently (shared by every channel). A captured HELLO cannot be replayed: its nonceA is remembered
 * for `ttlMs` (> the ±5 min timestamp window). Bounded: the oldest entries are evicted at `max`.
 */
export class NonceCache {
	readonly #seen = new Map<string, number>();
	readonly #max: number;
	readonly #ttl: number;
	readonly #now: () => number;
	constructor(max = 4096, ttlMs = 10 * 60_000, now: () => number = Date.now) {
		this.#max = max;
		this.#ttl = ttlMs;
		this.#now = now;
	}
	/** Records the nonce; false when it was already seen (replay). */
	add(did: string, nonce: Uint8Array): boolean {
		const now = this.#now();
		for (const [k, exp] of this.#seen) {
			if (exp > now) break; // insertion order == expiry order
			this.#seen.delete(k);
		}
		const key = `${did}:${Buffer.from(nonce).toString("base64url")}`;
		if (this.#seen.has(key)) return false;
		while (this.#seen.size >= this.#max) this.#seen.delete(this.#seen.keys().next().value!);
		this.#seen.set(key, now + this.#ttl);
		return true;
	}
	get size(): number {
		return this.#seen.size;
	}
}

export const PING_AFTER_MS = 25_000;
export const DEAD_AFTER_MS = 70_000;
const HANDSHAKE_DEADLINE_MS = 60_000;
const HELLO_SKEW_MS = 5 * 60_000;
const LOG_EVERY_MS = 5000;
const MAX_FAILURES = 3;
const MAX_PAIR_ATTEMPTS = 5;
const KNOWN_CAPS: readonly DeviceCap[] = ["location", "clipboard", "notify", "camera", "voice"];

export interface ChannelOptions {
	/** Diagnostic id, e.g. `r0#5`. */
	id: string;
	devices: DeviceStore;
	hostInfo: () => HostInfo;
	/** Writes one raw frame payload to the relay peer. */
	send: (payload: Buffer) => void;
	/**
	 * PAIR frames are handled by the pairing manager; resolve to the reply payload, or null for silence.
	 * `canDeliver` is true while this channel can still send the reply.
	 */
	onPair: (payload: Buffer, canDeliver: () => boolean) => Promise<Buffer | null>;
	onOpen: (ch: Channel) => void;
	onMessage: (ch: Channel, msg: AppToBridge) => void;
	/** Fired once: the channel was closed, blocked, or timed out. */
	onClosed: (ch: Channel, reason: string) => void;
	log: (m: string) => void;
	now?: () => number;
	random?: Partial<ChannelRandom>;
	/** Shared HELLO replay cache (the daemon passes one for all channels). */
	nonces?: NonceCache;
	/** Shared failure counters for this relay peer. */
	counters?: PeerCounters;
}

export class Channel {
	readonly id: string;
	state: ChannelState = "new";
	did: string | undefined;
	label = "";
	app = "";
	caps: DeviceCap[] = [];
	connectedAt: number;
	/** Ms timestamp of the last authenticated frame received. */
	lastRecv: number;

	readonly #o: ChannelOptions;
	readonly #rand: ChannelRandom;
	readonly #now: () => number;
	#c2b: Buffer | undefined;
	#b2c: Buffer | undefined;
	readonly #nonces: NonceCache;
	readonly #c: PeerCounters;
	#recvQ = 0;
	#sendQ = 0;
	#lastSent: number;
	#closedFired = false;
	/** First authenticated DATA frame seen: only now is the peer "connected". */
	#confirmed = false;
	#helloAt = 0;
	#suppressed = 0;

	constructor(o: ChannelOptions) {
		this.#o = o;
		this.id = o.id;
		this.#rand = { ...defaultRandom, ...o.random };
		this.#now = o.now ?? Date.now;
		this.#nonces = o.nonces ?? new NonceCache(4096, 10 * 60_000, this.#now);
		this.#c = o.counters ?? newPeerCounters();
		if (this.#c.blocked) this.state = "blocked";
		this.connectedAt = this.#now();
		this.lastRecv = this.connectedAt;
		this.#lastSent = this.connectedAt;
	}

	/**
	 * Authenticated and live: the handshake completed AND at least one authenticated DATA frame arrived. A replayed or
	 * half-finished HELLO never makes a channel "open" (push suppression, host-tool routing, status all key off this).
	 */
	get isOpen(): boolean {
		return this.state === "open" && this.#confirmed;
	}

	/** Feed one frame payload (the bytes after the relay's 4-byte peer id). */
	receive(payload: Buffer): void {
		if (this.#c.blocked || this.state === "blocked" || this.state === "closed" || payload.length === 0) return;
		switch (payload[0]) {
			case FRAME_PAIR:
				if (this.state !== "new") return;
				this.#onPair(payload);
				return;
			case FRAME_HELLO:
				this.#onHello(payload);
				return;
			case FRAME_DATA:
				this.#onData(payload);
				return;
			default:
				return;
		}
	}

	/** Seals and sends one application message. Throws when the plaintext exceeds MAX_PLAINTEXT. */
	send(msg: Outgoing): void {
		if (this.state !== "open" || !this.#b2c) throw new Error("channel is not open");
		const q = ++this.#sendQ;
		const plain = Buffer.from(JSON.stringify({ q, ...msg }), "utf8");
		if (plain.byteLength > MAX_PLAINTEXT) {
			this.#sendQ--;
			throw new Error(`frame too large (${plain.byteLength} > ${MAX_PLAINTEXT})`);
		}
		const sealed = seal(this.#b2c, plain, aad(FRAME_DATA, "B"), this.#rand.iv());
		this.#lastSent = this.#now();
		this.#o.send(Buffer.concat([Buffer.from([FRAME_DATA]), sealed]));
	}

	/** Housekeeping; call every few seconds. */
	tick(): void {
		const now = this.#now();
		if (this.state === "new") {
			if (now - this.connectedAt >= HANDSHAKE_DEADLINE_MS) this.close("no handshake");
			return;
		}
		if (this.state !== "open") return;
		if (!this.#confirmed && now - this.#helloAt >= HANDSHAKE_DEADLINE_MS) {
			this.close("no data after handshake");
			return;
		}
		if (now - this.lastRecv >= DEAD_AFTER_MS) {
			this.close("peer silent");
			return;
		}
		if (now - Math.max(this.lastRecv, this.#lastSent) >= PING_AFTER_MS) this.send({ t: "ping" });
	}

	/** Drops the session. The relay peer may linger, but all its frames are ignored. */
	close(reason: string): void {
		this.#teardown("closed", reason);
	}

	#block(reason: string): void {
		this.#c.blocked = true;
		this.#o.log(`[${this.id}] blocked: ${reason}`);
		this.#teardown("blocked", reason);
	}

	#teardown(state: "blocked" | "closed", reason: string): void {
		if (this.state === "closed" || this.state === "blocked") return;
		this.state = state;
		this.#c2b?.fill(0);
		this.#b2c?.fill(0);
		this.#c2b = undefined;
		this.#b2c = undefined;
		if (!this.#closedFired) {
			this.#closedFired = true;
			this.#o.onClosed(this, reason);
		}
	}

	/** At most one log line per 5 s per peer; the rest are counted. */
	#warn(msg: string): void {
		const now = this.#now();
		if (now - this.#c.lastLog < LOG_EVERY_MS) {
			this.#suppressed++;
			return;
		}
		this.#c.lastLog = now;
		this.#o.log(`[${this.id}] ${msg}${this.#suppressed ? ` (+${this.#suppressed} similar suppressed)` : ""}`);
		this.#suppressed = 0;
	}

	#fail(why: string): void {
		this.#warn(`bad frame: ${why}`);
		if (++this.#c.frames >= MAX_FAILURES) this.#block("too many invalid frames");
	}

	#onPair(payload: Buffer): void {
		if (++this.#c.pair > MAX_PAIR_ATTEMPTS) {
			this.#block("too many pairing attempts");
			return;
		}
		this.#o.onPair(payload, () => this.state !== "closed" && this.state !== "blocked").then(
			reply => {
				if (reply && this.state !== "closed" && this.state !== "blocked") this.#o.send(reply);
			},
			e => this.#warn(`pairing error: ${(e as Error).message}`),
		);
	}

	#onHello(payload: Buffer): void {
		if (payload.length < 1 + 8 + 12 + 16) {
			this.#helloFailed("short HELLO");
			return;
		}
		const did = payload.subarray(1, 9);
		const didStr = b64u(did);
		if (this.state === "open" && this.did !== didStr) {
			this.#helloFailed("HELLO for a different device on an open channel");
			return;
		}
		const dev = this.#o.devices.get(didStr);
		if (!dev || dev.kDev.length === 0) {
			this.#warn(`HELLO from unknown or revoked device ${didStr}: ignored`);
			this.#block("unknown or revoked device");
			return;
		}
		const kDev = unb64u(dev.kDev);
		let hello: unknown;
		try {
			hello = JSON.parse(open(kDev, payload.subarray(9), aad(FRAME_HELLO, "C", did)).toString("utf8"));
		} catch {
			this.#helloFailed("HELLO failed authentication");
			return;
		}
		if (!isRecord(hello) || hello.t !== "hello" || typeof hello.eph !== "string" || typeof hello.n !== "string") {
			this.#helloFailed("malformed HELLO");
			return;
		}
		const ephA = unb64u(hello.eph);
		const nonceA = unb64u(hello.n);
		if (ephA.length !== 65 || nonceA.length !== 16) {
			this.#helloFailed("bad HELLO key/nonce size");
			return;
		}
		if (typeof hello.ts !== "number" || !Number.isFinite(hello.ts) || Math.abs(this.#now() - hello.ts) > HELLO_SKEW_MS) {
			this.#helloFailed("stale or clock-skewed HELLO");
			return;
		}
		if (!this.#nonces.add(didStr, nonceA)) {
			this.#helloFailed("replayed HELLO");
			return;
		}
		const ephB = this.#rand.ephemeral();
		const nonceB = this.#rand.nonce();
		let keys: { c2b: Buffer; b2c: Buffer };
		try {
			keys = sessionKeys(ecdh(ephB.priv, ephA), kDev, nonceA, nonceB);
		} catch {
			this.#helloFailed("invalid ephemeral public key");
			return;
		}
		this.#c2b = keys.c2b;
		this.#b2c = keys.b2c;
		this.#recvQ = 0;
		this.#sendQ = 0;
		this.did = didStr;
		this.label = cleanLabel(hello.label, dev.label);
		this.app = cleanLabel(hello.app, "", 32);
		this.caps = Array.isArray(hello.caps) ? (hello.caps.filter(c => KNOWN_CAPS.includes(c as DeviceCap)) as DeviceCap[]) : [];
		this.state = "open";
		this.#helloAt = this.#now();
		this.lastRecv = this.#helloAt;

		const okPlain = Buffer.from(JSON.stringify({ t: "hello-ok", eph: b64u(ephB.pub), n: b64u(nonceB), host: this.#o.hostInfo() }), "utf8");
		const sealed = seal(kDev, okPlain, aad(FRAME_HELLO, "B"), this.#rand.iv());
		this.#lastSent = this.#now();
		this.#o.send(Buffer.concat([Buffer.from([FRAME_HELLO]), sealed]));
	}

	#helloFailed(why: string): void {
		this.#warn(why);
		if (++this.#c.hello >= MAX_FAILURES) this.#block("too many failed handshakes");
	}

	#onData(payload: Buffer): void {
		if (this.state !== "open" || !this.#c2b || !this.did) return;
		if (!this.#o.devices.get(this.did)) {
			this.#block("device revoked");
			return;
		}
		let msg: unknown;
		try {
			msg = JSON.parse(open(this.#c2b, payload.subarray(1), aad(FRAME_DATA, "C")).toString("utf8"));
		} catch {
			this.#fail("DATA failed authentication");
			return;
		}
		if (!isRecord(msg) || typeof msg.t !== "string" || typeof msg.q !== "number" || !Number.isSafeInteger(msg.q)) {
			this.#fail("DATA is not a q-stamped object");
			return;
		}
		if (msg.q <= this.#recvQ) {
			this.#fail(`replayed or out-of-order q=${msg.q} (last ${this.#recvQ})`);
			return;
		}
		this.#recvQ = msg.q;
		this.lastRecv = this.#now();
		if (!this.#confirmed) {
			this.#confirmed = true;
			this.#o.devices.touch(this.did);
			this.#o.onOpen(this);
		}
		switch (msg.t) {
			case "ping":
				this.send({ t: "pong" });
				return;
			case "pong":
				return;
			case "req":
				if (typeof msg.id !== "number" || typeof msg.op !== "string") {
					this.#fail("malformed req");
					return;
				}
				this.#o.onMessage(this, { q: msg.q, t: "req", id: msg.id, op: msg.op, a: msg.a ?? {} } as AppToBridge);
				return;
			default:
				return;
		}
	}
}
