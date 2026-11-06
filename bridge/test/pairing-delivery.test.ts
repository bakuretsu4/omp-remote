import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { aad, b64u, generateKeypair, open, pairKeyFrom, seal, unb64u } from "../../protocol/src/crypto.ts";
import type { HostInfo } from "../../protocol/src/index.ts";
import { Channel } from "../src/channel.ts";
import { DeviceStore } from "../src/devices.ts";
import { createIdentity } from "../src/identity.ts";
import { PairingManager } from "../src/pairing.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-pairdel-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup() {
	const dir = join(tmp, `p${n++}`);
	const identity = createIdentity(dir);
	const devices = new DeviceStore(dir);
	const pm = new PairingManager({ identity, devices, hostName: "h", log: () => {} });
	return { devices, pm };
}

const ptOf = (link: string): Buffer => unb64u(new URL(link.replace("ompr://", "https://")).searchParams.get("pt")!);

function req(pt: Buffer): Buffer {
	const body = JSON.stringify({ t: "pair-req", dpk: b64u(generateKeypair().pub), label: "Phone", ts: Date.now() });
	return Buffer.concat([Buffer.from([0]), seal(pairKeyFrom(pt), Buffer.from(body), aad(0, "C"))]);
}

const decode = (pt: Buffer, reply: Buffer): Record<string, unknown> => JSON.parse(open(pairKeyFrom(pt), reply.subarray(1), aad(0, "B")).toString());

/** A real Channel wired to a real PairingManager exactly as the daemon does it. */
function channelFor(pm: PairingManager, devices: DeviceStore) {
	const sent: Buffer[] = [];
	const ch = new Channel({
		id: "t#1",
		devices,
		hostInfo: () => ({ proto: 1, hostId: "h" }) as HostInfo,
		send: p => sent.push(p),
		onPair: (payload, canDeliver) => pm.handle(payload, canDeliver),
		onOpen: () => {},
		onMessage: () => {},
		onClosed: () => {},
		log: () => {},
	});
	return { ch, sent };
}

describe("a phone that drops while the PC is asking", () => {
	it("is not saved, and the CLI is told why", async () => {
		const { devices, pm } = setup();
		let open = true;
		let release!: (ok: boolean) => void;
		const ended: string[] = [];
		const s = pm.begin({ relays: ["ws://a"], confirm: () => new Promise<boolean>(r => (release = r)), onDenied: r => ended.push(r) });
		const pending = pm.handle(req(ptOf(s.link)), () => open);
		await Promise.resolve();
		open = false; // the phone's socket drops while the human is deciding
		release(true); // and the human approves anyway
		assert.equal(await pending, null);
		assert.equal(devices.list().length, 0, "no device may be recorded for a phone that cannot receive its key");
		assert.equal(pm.activeCount, 0);
		assert.match(ended[0] ?? "", /disconnected before pairing finished/);
	});

	it("through a real channel: closed during the prompt leaves no device and sends nothing", async () => {
		const { devices, pm } = setup();
		let release!: (ok: boolean) => void;
		const s = pm.begin({ relays: ["ws://a"], confirm: () => new Promise<boolean>(r => (release = r)) });
		const { ch, sent } = channelFor(pm, devices);
		ch.receive(req(ptOf(s.link)));
		await new Promise(r => setImmediate(r));
		ch.close("peer left");
		release(true);
		await new Promise(r => setImmediate(r));
		assert.equal(devices.list().length, 0);
		assert.equal(sent.length, 0);
	});

	it("through a real channel: still open when approved pairs normally", async () => {
		const { devices, pm } = setup();
		let release!: (ok: boolean) => void;
		const s = pm.begin({ relays: ["ws://a"], confirm: () => new Promise<boolean>(r => (release = r)) });
		const { ch, sent } = channelFor(pm, devices);
		ch.receive(req(ptOf(s.link)));
		await new Promise(r => setImmediate(r));
		release(true);
		await new Promise(r => setImmediate(r));
		assert.equal(devices.list().length, 1);
		assert.equal(sent.length, 1);
		assert.equal(decode(ptOf(s.link), sent[0]!).t, "pair-ok");
	});
});
