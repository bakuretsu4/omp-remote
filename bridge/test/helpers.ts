/** Test helpers: a reference *app side* of the L1 channel (HELLO + DATA) driving a bridge `Channel` in-process. */
import {
	aad, b64u, ecdh, generateKeypair, open, seal, sessionKeys, unb64u,
} from "../../protocol/src/crypto.ts";
import { FRAME_DATA, FRAME_HELLO, type HostInfo } from "../../protocol/src/index.ts";
import { Channel, type NonceCache, type PeerCounters } from "../src/channel.ts";
import type { DeviceStore } from "../src/devices.ts";
import { randomBytes } from "node:crypto";

export interface AppSide {
	did: Buffer;
	kDev: Buffer;
}

export class FakeApp {
	readonly did: Buffer;
	readonly kDev: Buffer;
	c2b!: Buffer;
	b2c!: Buffer;
	q = 0;
	constructor(side: AppSide) {
		this.did = side.did;
		this.kDev = side.kDev;
	}

	hello(extra: Record<string, unknown> = {}): { frame: Buffer; eph: { priv: Buffer; pub: Buffer }; nonceA: Buffer } {
		const eph = generateKeypair();
		const nonceA = randomBytes(16);
		const plain = JSON.stringify({ t: "hello", eph: b64u(eph.pub), n: b64u(nonceA), ts: Date.now(), caps: [], app: "test", label: "Test", ...extra });
		const sealed = seal(this.kDev, Buffer.from(plain), aad(FRAME_HELLO, "C", this.did));
		return { frame: Buffer.concat([Buffer.from([FRAME_HELLO]), this.did, sealed]), eph, nonceA };
	}

	/** Completes the handshake from the bridge's HELLO reply. */
	finish(reply: Buffer, eph: { priv: Buffer; pub: Buffer }, nonceA: Buffer): { eph: string; n: string; host: HostInfo } {
		const ok = JSON.parse(open(this.kDev, reply.subarray(1), aad(FRAME_HELLO, "B")).toString());
		const keys = sessionKeys(ecdh(eph.priv, unb64u(ok.eph)), this.kDev, nonceA, unb64u(ok.n));
		this.c2b = keys.c2b;
		this.b2c = keys.b2c;
		this.q = 0;
		return ok;
	}

	data(msg: Record<string, unknown>, q?: number): Buffer {
		const plain = Buffer.from(JSON.stringify({ q: q ?? ++this.q, ...msg }));
		return Buffer.concat([Buffer.from([FRAME_DATA]), seal(this.c2b, plain, aad(FRAME_DATA, "C"))]);
	}

	read(frame: Buffer): Record<string, unknown> {
		return JSON.parse(open(this.b2c, frame.subarray(1), aad(FRAME_DATA, "B")).toString());
	}
}

export function makeChannel(devices: DeviceStore, now: () => number = Date.now, nonces?: NonceCache, counters?: PeerCounters, log: (m: string) => void = () => {}): {
	ch: Channel; sent: Buffer[]; msgs: unknown[]; closed: string[]; opened: number[];
} {
	const sent: Buffer[] = [];
	const msgs: unknown[] = [];
	const closed: string[] = [];
	const opened: number[] = [];
	const ch = new Channel({
		id: "t#1",
		devices,
		hostInfo: () => ({ proto: 1, hostId: "h" }) as HostInfo,
		send: p => sent.push(p),
		onPair: async () => null,
		onOpen: () => opened.push(1),
		onMessage: (_c, m) => msgs.push(m),
		onClosed: (_c, r) => closed.push(r),
		log,
		now,
		nonces,
		counters,
	});
	return { ch, sent, msgs, closed, opened };
}

export function pairedDevice(devices: DeviceStore): FakeApp {
	const did = randomBytes(8);
	const kDev = randomBytes(32);
	devices.add({ did: b64u(did), label: "Test", dpk: "x", kDev: b64u(kDev) });
	return new FakeApp({ did, kDev });
}
