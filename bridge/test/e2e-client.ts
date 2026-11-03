/**
 * Node reference *app* for OMP Remote: pairing + handshake + req/res/ev over a relay, written against
 * protocol/src/crypto.ts only (no bridge code). Used by the hermetic daemon test and e2e/live.ts, and a
 * working model for the Android implementation.
 */
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
	aad, b64u, deviceKeyFrom, ecdh, generateKeypair, open, packEnvelope, pairKeyFrom, sasOf, seal, sessionKeys,
	unb64u, unpackEnvelope,
} from "../../protocol/src/crypto.ts";
import {
	FRAME_DATA, FRAME_HELLO, FRAME_PAIR,
	type DeviceCap, type HostEvent, type HostInfo, type OpName, type Ops, type PairRes, type SessionEvent, type WireError,
} from "../../protocol/src/index.ts";

export interface PairingLink {
	name: string;
	roomId: string;
	bpk: Buffer;
	pt: Buffer;
	relays: string[];
}

/** What the app persists after pairing (K_dev must be Keystore-wrapped on a phone). */
export interface PairedHost {
	hostId: string;
	name: string;
	/** The phone only ever learns the derived room id; the permanent roomSecret stays on the bridge. */
	roomId: string;
	bpk: string;
	did: string;
	kDev: string;
	relays: string[];
}

export function parseLink(link: string): PairingLink {
	const u = new URL(link.trim().replace(/^ompr:\/\//, "https://"));
	if (u.hostname !== "pair" || u.searchParams.get("v") !== "2") throw new Error("not an ompr v2 pairing link (v=1 links are rejected)");
	const rid = u.searchParams.get("rid") ?? "";
	if (!/^[A-Za-z0-9_-]{22}$/.test(rid)) throw new Error("pairing link has no valid rid");
	return {
		name: u.searchParams.get("name") ?? "",
		roomId: rid,
		bpk: unb64u(u.searchParams.get("bpk") ?? ""),
		pt: unb64u(u.searchParams.get("pt") ?? ""),
		relays: u.searchParams.getAll("r"),
	};
}

function openSocket(url: string): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(url, { perMessageDeflate: false });
	ws.once("open", () => resolve(ws));
	ws.once("error", reject);
	ws.once("close", c => reject(new Error(`relay closed the socket (${c})`)));
	return promise;
}

const roomUrl = (relay: string, roomId: string): string => `${relay.replace(/\/+$/, "")}/r/${roomId}?role=guest`;

/** Runs the pairing handshake (PROTOCOL.md §4). `relay` overrides the link's relay list. */
export async function pair(link: string, opts: { relay?: string; label?: string; timeoutMs?: number; onSas?: (sas: string) => void } = {}): Promise<PairedHost> {
	const l = parseLink(link);
	const relay = opts.relay ?? l.relays[0];
	if (!relay) throw new Error("no relay to connect to");
	const ws = await openSocket(roomUrl(relay, l.roomId));
	try {
		const pairKey = pairKeyFrom(l.pt);
		const dev = generateKeypair();
		opts.onSas?.(sasOf(l.pt, dev.pub, l.bpk)); // shown on the phone while it waits for pair-ok
		const body = JSON.stringify({ t: "pair-req", dpk: b64u(dev.pub), label: opts.label ?? "e2e-client", ts: Date.now() });
		const frame = Buffer.concat([Buffer.from([FRAME_PAIR]), seal(pairKey, Buffer.from(body), aad(FRAME_PAIR, "C"))]);
		const { promise, resolve, reject } = Promise.withResolvers<PairRes>();
		const timer = setTimeout(() => reject(new Error("pairing timed out (no reply: bad token, expired, or the bridge is waiting for confirmation)")), opts.timeoutMs ?? 120_000);
		ws.on("message", (data: Buffer) => {
			const env = unpackEnvelope(data);
			if (!env || env.payload[0] !== FRAME_PAIR) return;
			try {
				resolve(JSON.parse(open(pairKey, env.payload.subarray(1), aad(FRAME_PAIR, "B")).toString()));
			} catch (e) {
				reject(e as Error);
			}
		});
		ws.once("close", () => reject(new Error("socket closed during pairing")));
		ws.send(packEnvelope(0, frame));
		const res = await promise.finally(() => clearTimeout(timer));
		if (res.t !== "pair-ok") throw new Error(`pairing refused: ${res.reason}`);
		const kDev = deviceKeyFrom(ecdh(dev.priv, l.bpk), l.pt);
		return {
			hostId: res.hostId, name: res.name, roomId: l.roomId, bpk: b64u(l.bpk), did: res.did, kDev: b64u(kDev),
			relays: opts.relay ? [opts.relay] : l.relays,
		};
	} finally {
		ws.removeAllListeners();
		ws.on("error", () => {});
		ws.close();
	}
}

export class RpcFailure extends Error {
	readonly code: WireError["code"];
	constructor(e: WireError) {
		super(e.message);
		this.code = e.code;
	}
}

type EvRecord = { sid: string; n: number; e: SessionEvent };

const isEv = (r: EvRecord | HostEvent): r is EvRecord => "n" in r && "e" in r;

export class OmprClient {
	readonly host: PairedHost;
	readonly events: EvRecord[] = [];
	readonly hevs: HostEvent[] = [];
	hostInfo!: HostInfo;
	closed = false;
	readonly #ws: WebSocket;
	readonly #kDev: Buffer;
	readonly #did: Buffer;
	#c2b!: Buffer;
	#b2c!: Buffer;
	#q = 0;
	#lastIn = 0;
	#nextId = 0;
	readonly #pending = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
	readonly #waiters: { pred: (r: EvRecord | HostEvent) => boolean; resolve: (r: EvRecord | HostEvent) => void }[] = [];

	private constructor(host: PairedHost, ws: WebSocket) {
		this.host = host;
		this.#ws = ws;
		this.#kDev = unb64u(host.kDev);
		this.#did = unb64u(host.did);
	}

	/** Connects to `relay` (default: first of the paired relays) and performs the HELLO handshake. */
	static async connect(host: PairedHost, o: { relay?: string; caps?: DeviceCap[]; label?: string; timeoutMs?: number } = {}): Promise<OmprClient> {
		const relay = o.relay ?? host.relays[0];
		if (!relay) throw new Error("no relay");
		const ws = await openSocket(roomUrl(relay, host.roomId));
		const c = new OmprClient(host, ws);
		await c.#handshake(o.caps ?? [], o.label ?? "e2e-client", o.timeoutMs ?? 15_000);
		return c;
	}

	async #handshake(caps: DeviceCap[], label: string, timeoutMs: number): Promise<void> {
		const eph = generateKeypair();
		const nonceA = randomBytes(16);
		const hello = JSON.stringify({ t: "hello", eph: b64u(eph.pub), n: b64u(nonceA), ts: Date.now(), caps, app: "0.1.0", label });
		const frame = Buffer.concat([Buffer.from([FRAME_HELLO]), this.#did, seal(this.#kDev, Buffer.from(hello), aad(FRAME_HELLO, "C", this.#did))]);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new Error("handshake timed out (silence: unknown/revoked device or wrong room)")), timeoutMs);
		this.#ws.on("message", (data: Buffer) => {
			const env = unpackEnvelope(data);
			if (!env || env.payload.length === 0) return;
			try {
				if (env.payload[0] === FRAME_HELLO && !this.#b2c) {
					const ok = JSON.parse(open(this.#kDev, env.payload.subarray(1), aad(FRAME_HELLO, "B")).toString());
					const keys = sessionKeys(ecdh(eph.priv, unb64u(ok.eph)), this.#kDev, nonceA, unb64u(ok.n));
					this.#c2b = keys.c2b;
					this.#b2c = keys.b2c;
					this.hostInfo = ok.host;
					resolve();
				} else if (env.payload[0] === FRAME_DATA && this.#b2c) {
					this.#onData(env.payload);
				}
			} catch (e) {
				if (!this.#b2c) reject(e as Error);
			}
		});
		this.#ws.once("close", () => {
			this.closed = true;
			reject(new Error("socket closed"));
			for (const p of this.#pending.values()) p.reject(new Error("connection closed"));
			this.#pending.clear();
		});
		this.#ws.send(packEnvelope(0, frame));
		await promise.finally(() => clearTimeout(timer));
	}

	#onData(payload: Buffer): void {
		const msg = JSON.parse(open(this.#b2c, payload.subarray(1), aad(FRAME_DATA, "B")).toString());
		if (typeof msg.q !== "number" || msg.q <= this.#lastIn) throw new Error(`replayed or out-of-order q ${msg.q}`);
		this.#lastIn = msg.q;
		switch (msg.t) {
			case "res": {
				const p = this.#pending.get(msg.id);
				if (!p) return;
				this.#pending.delete(msg.id);
				if (msg.ok) p.resolve(msg.d);
				else p.reject(new RpcFailure(msg.e));
				return;
			}
			case "ev": {
				const r: EvRecord = { sid: msg.sid, n: msg.n, e: msg.e };
				this.events.push(r);
				this.#notify(r);
				return;
			}
			case "hev":
				this.hevs.push(msg.e);
				this.#notify(msg.e);
				return;
			case "ping":
				this.#send({ t: "pong" });
				return;
			default:
				return;
		}
	}

	#notify(r: EvRecord | HostEvent): void {
		for (const w of [...this.#waiters]) {
			if (w.pred(r)) {
				this.#waiters.splice(this.#waiters.indexOf(w), 1);
				w.resolve(r);
			}
		}
	}

	#send(msg: Record<string, unknown>): void {
		const plain = Buffer.from(JSON.stringify({ q: ++this.#q, ...msg }));
		this.#ws.send(packEnvelope(0, Buffer.concat([Buffer.from([FRAME_DATA]), seal(this.#c2b, plain, aad(FRAME_DATA, "C"))])));
	}

	/** Sends a req and resolves with `d`; rejects with `RpcFailure` on `ok:false`. */
	req<K extends OpName>(op: K, a: Ops[K]["a"], timeoutMs = 60_000): Promise<Ops[K]["d"]> {
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`${op} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject });
		this.#send({ t: "req", id, op, a });
		return promise.finally(() => clearTimeout(timer)) as Promise<Ops[K]["d"]>;
	}

	/** Resolves true when NOTHING comes back within `ms` (revoked-device silence); false when a reply arrives. */
	async expectSilence(op: OpName, a: unknown, ms: number): Promise<boolean> {
		if (this.closed) return true;
		const id = ++this.#nextId;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.#pending.set(id, { resolve: () => resolve(false), reject: () => resolve(false) });
		const timer = setTimeout(() => resolve(true), ms);
		try {
			this.#send({ t: "req", id, op, a });
		} catch {
			return true;
		}
		const r = await promise;
		clearTimeout(timer);
		this.#pending.delete(id);
		return r;
	}

	/** Waits for a session event (already received ones count) or a host event matching `pred`. */
	waitEvent(pred: (e: SessionEvent, r: EvRecord) => boolean, timeoutMs = 120_000, what = "event"): Promise<EvRecord> {
		const hit = this.events.find(r => pred(r.e, r));
		if (hit) return Promise.resolve(hit);
		const { promise, resolve, reject } = Promise.withResolvers<EvRecord | HostEvent>();
		const w = { pred: (r: EvRecord | HostEvent) => isEv(r) && pred(r.e, r), resolve };
		this.#waiters.push(w);
		const timer = setTimeout(() => {
			this.#waiters.splice(this.#waiters.indexOf(w), 1);
			reject(new Error(`timed out waiting for ${what}`));
		}, timeoutMs);
		return (promise as Promise<EvRecord>).finally(() => clearTimeout(timer));
	}

	waitHostEvent(pred: (e: HostEvent) => boolean, timeoutMs = 60_000, what = "host event"): Promise<HostEvent> {
		const hit = this.hevs.find(pred);
		if (hit) return Promise.resolve(hit);
		const { promise, resolve, reject } = Promise.withResolvers<EvRecord | HostEvent>();
		const w = { pred: (r: EvRecord | HostEvent) => !isEv(r) && pred(r as HostEvent), resolve };
		this.#waiters.push(w);
		const timer = setTimeout(() => {
			this.#waiters.splice(this.#waiters.indexOf(w), 1);
			reject(new Error(`timed out waiting for ${what}`));
		}, timeoutMs);
		return (promise as Promise<HostEvent>).finally(() => clearTimeout(timer));
	}

	/** Resolves when the relay socket closes (e.g. the bridge dropped us). */
	get whenClosed(): Promise<void> {
		if (this.closed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ws.once("close", () => resolve());
		return promise;
	}

	close(): void {
		this.closed = true;
		this.#ws.removeAllListeners("message");
		this.#ws.on("error", () => {});
		this.#ws.close();
	}
}
