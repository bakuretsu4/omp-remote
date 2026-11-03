import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { aad, b64u, generateKeypair, open, pairKeyFrom, sasOf, seal, unb64u } from "../../protocol/src/crypto.ts";
import { DeviceStore } from "../src/devices.ts";
import { createIdentity } from "../src/identity.ts";
import { PairingManager } from "../src/pairing.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-pair-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup(now = () => Date.now()) {
	const dir = join(tmp, `p${n++}`);
	const identity = createIdentity(dir);
	const devices = new DeviceStore(dir);
	const pm = new PairingManager({ identity, devices, hostName: "h", log: () => {}, now });
	return { dir, identity, devices, pm };
}

function ptOf(link: string): Buffer {
	return unb64u(new URL(link.replace("ompr://", "https://")).searchParams.get("pt")!);
}

function req(pt: Buffer, over: Record<string, unknown> = {}, dpk = generateKeypair().pub): Buffer {
	const body = JSON.stringify({ t: "pair-req", dpk: b64u(dpk), label: "Phone", ts: Date.now(), ...over });
	return Buffer.concat([Buffer.from([0]), seal(pairKeyFrom(pt), Buffer.from(body), aad(0, "C"))]);
}

const decode = (pt: Buffer, reply: Buffer): Record<string, unknown> => JSON.parse(open(pairKeyFrom(pt), reply.subarray(1), aad(0, "B")).toString());

describe("pairing", () => {
	it("creates identity.json with mode 0600 in a 0700 dir", () => {
		const { dir } = setup();
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(dir, "identity.json")).mode & 0o777, 0o600);
	});

	it("pairs once, stores the device (0600) and burns the token", async () => {
		const { pm, devices, dir } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		const pt = ptOf(s.link);
		const reply = (await pm.handle(req(pt)))!;
		const ok = decode(pt, reply);
		assert.equal(ok.t, "pair-ok");
		assert.equal(devices.list().length, 1);
		assert.equal(statSync(join(dir, "devices.json")).mode & 0o777, 0o600);
		assert.equal(await pm.handle(req(pt)), null);
	});

	it("gives silence for an unknown token", async () => {
		const { pm } = setup();
		pm.begin({ relays: ["ws://a"] });
		assert.equal(await pm.handle(req(Buffer.alloc(32, 1))), null);
	});

	it("expires tokens", async () => {
		let t = 1_000_000;
		const { pm, devices } = setup(() => t);
		const s = pm.begin({ relays: ["ws://a"] });
		t += 10 * 60_000 + 1;
		assert.equal(await pm.handle(req(ptOf(s.link), { ts: t })), null);
		assert.equal(devices.list().length, 0);
		s.cancel();
	});

	it("rejects clock skew over 5 minutes and burns the token", async () => {
		const { pm, devices } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		const pt = ptOf(s.link);
		const reply = (await pm.handle(req(pt, { ts: Date.now() - 6 * 60_000 })))!;
		assert.deepEqual(decode(pt, reply), { t: "pair-no", reason: "clock skew" });
		assert.equal(devices.list().length, 0);
		assert.equal(await pm.handle(req(pt)), null);
	});

	it("rejects a malformed device key", async () => {
		const { pm } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		const pt = ptOf(s.link);
		const reply = (await pm.handle(req(pt, {}, Buffer.alloc(65, 7))))!;
		assert.equal(decode(pt, reply).t, "pair-no");
	});

	it("asks for confirmation and honours a denial", async () => {
		const { pm, devices } = setup();
		let asked = "";
		const s = pm.begin({ relays: ["ws://a"], confirm: async label => ((asked = label), false) });
		const pt = ptOf(s.link);
		const reply = (await pm.handle(req(pt, { label: "Evil\nPhone" })))!;
		assert.deepEqual(decode(pt, reply), { t: "pair-no", reason: "denied" });
		assert.equal(asked, "Evil Phone");
		assert.equal(devices.list().length, 0);
	});

	it("honours an approval", async () => {
		const { pm, devices } = setup();
		const s = pm.begin({ relays: ["ws://a"], confirm: async () => true });
		const pt = ptOf(s.link);
		assert.equal(decode(pt, (await pm.handle(req(pt)))!).t, "pair-ok");
		assert.equal(devices.list().length, 1);
	});

	it("revoking wipes K_dev and persists", async () => {
		const { pm, devices, dir } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		const pt = ptOf(s.link);
		const did = (decode(pt, (await pm.handle(req(pt)))!) as { did: string }).did;
		assert.ok(devices.get(did));
		assert.equal(devices.revoke(did), true);
		assert.equal(devices.get(did), undefined);
		const reloaded = new DeviceStore(dir);
		assert.equal(reloaded.list()[0]!.kDev, "");
		assert.equal(reloaded.list()[0]!.revoked, true);
	});
});

describe("finding 1: SAS and token burning", () => {
	it("passes the 6-digit SAS to the confirmation and it matches sasOf(pt, dpk, bpk)", async () => {
		const { pm, identity } = setup();
		let seen = "";
		const s = pm.begin({ relays: ["ws://a"], confirm: async (_l, sas) => ((seen = sas), true) });
		const pt = ptOf(s.link);
		const dev = generateKeypair();
		await pm.handle(req(pt, {}, dev.pub));
		assert.match(seen, /^\d{3} \d{3}$/);
		assert.equal(seen, sasOf(pt, dev.pub, identity.pub));
	});

	it("a different device key (MITM swapping dpk) yields a different SAS", async () => {
		const { pm } = setup();
		const codes: string[] = [];
		for (let i = 0; i < 2; i++) {
			const s = pm.begin({ relays: ["ws://a"], confirm: async (_l, sas) => (codes.push(sas), false) });
			const pt = Buffer.from(ptOf(s.link));
			await pm.handle(req(pt, {}, generateKeypair().pub));
		}
		assert.notEqual(codes[0], codes[1]);
	});

	it("unauthenticated, garbage and malformed frames do NOT burn the token", async () => {
		const { pm, devices } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		const pt = ptOf(s.link);
		assert.equal(await pm.handle(Buffer.from([0])), null);
		assert.equal(await pm.handle(Buffer.concat([Buffer.from([0]), Buffer.alloc(80, 3)])), null, "random bytes");
		assert.equal(await pm.handle(req(Buffer.alloc(32, 5))), null, "wrong token");
		const body = Buffer.from("not json at all");
		const authenticatedGarbage = Buffer.concat([Buffer.from([0]), seal(pairKeyFrom(pt), body, aad(0, "C"))]);
		assert.equal(await pm.handle(authenticatedGarbage), null, "AEAD-valid but not a pair-req → silence, not a denial");
		const wrongType = Buffer.concat([Buffer.from([0]), seal(pairKeyFrom(pt), Buffer.from(JSON.stringify({ t: "other" })), aad(0, "C"))]);
		assert.equal(await pm.handle(wrongType), null);
		assert.equal(pm.activeCount, 1, "token still alive");
		const ok = decode(pt, (await pm.handle(req(pt)))!);
		assert.equal(ok.t, "pair-ok");
		assert.equal(devices.list().length, 1);
	});

	it("a second authenticated request while one awaits confirmation gets `busy` and does not disturb the first", async () => {
		const { pm, devices } = setup();
		let release!: (ok: boolean) => void;
		const s = pm.begin({ relays: ["ws://a"], confirm: () => new Promise<boolean>(r => (release = r)) });
		const pt = ptOf(s.link);
		const first = pm.handle(req(pt, { label: "first" }));
		await Promise.resolve();
		const second = decode(pt, (await pm.handle(req(pt, { label: "second" })))!);
		assert.deepEqual(second, { t: "pair-no", reason: "busy" });
		assert.equal(pm.activeCount, 1);
		release(true);
		assert.equal(decode(pt, (await first)!).t, "pair-ok");
		assert.equal(devices.list().length, 1);
		assert.equal(devices.list()[0]!.label, "first");
	});

	it("without a confirm callback anyone with the link pairs (this is what --no-confirm means)", async () => {
		const { pm, devices } = setup();
		const s = pm.begin({ relays: ["ws://a"] });
		await pm.handle(req(ptOf(s.link)));
		assert.equal(devices.list().length, 1);
	});
});

describe("finding 8: link v2 has no roomSecret", () => {
	it("carries rid, not rs, and is v=2", () => {
		const { pm, identity } = setup();
		const link = pm.begin({ relays: ["ws://a", "wss://b"] }).link;
		const u = new URL(link.replace("ompr://", "https://"));
		assert.equal(u.searchParams.get("v"), "2");
		assert.equal(u.searchParams.get("rid"), identity.roomId);
		assert.equal(u.searchParams.has("rs"), false);
		assert.ok(!link.includes(b64u(identity.roomSecret)));
		assert.deepEqual(u.searchParams.getAll("r"), ["ws://a", "wss://b"]);
	});
});

describe("finding 14: pair-req labels", () => {
	it("strips bidi/control characters and caps length before the label reaches the prompt or the store", async () => {
		const { pm, devices } = setup();
		let asked = "";
		const s = pm.begin({ relays: ["ws://a"], confirm: async l => ((asked = l), true) });
		const pt = ptOf(s.link);
		await pm.handle(req(pt, { label: `Trusted\u202E\u0000 Phone\n\u2066${"x".repeat(200)}` }));
		assert.ok(!/[\p{C}\u202A-\u202E\u2066-\u2069]/u.test(asked));
		assert.ok(asked.length <= 64);
		assert.equal(devices.list()[0]!.label, asked);
	});
});
