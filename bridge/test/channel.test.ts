import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import { b64u } from "../../protocol/src/crypto.ts";
import { DeviceStore } from "../src/devices.ts";
import { NonceCache, newPeerCounters } from "../src/channel.ts";
import { FakeApp, makeChannel, pairedDevice } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-chan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const store = (): DeviceStore => new DeviceStore(join(tmp, `d${n++}`));

function open() {
	const devices = store();
	const app = pairedDevice(devices);
	const c = makeChannel(devices);
	const h = app.hello();
	c.ch.receive(h.frame);
	app.finish(c.sent[0]!, h.eph, h.nonceA);
	return { devices, app, ...c };
}

describe("handshake", () => {
	it("opens, reports the host and lets both sides talk", () => {
		const { app, ch, sent, msgs } = open();
		assert.equal(ch.state, "open");
		ch.receive(app.data({ t: "req", id: 7, op: "host.info", a: {} }));
		assert.equal((msgs[0] as { id: number }).id, 7);
		ch.send({ t: "res", id: 7, ok: true, d: {} });
		const back = app.read(sent[1]!);
		assert.deepEqual(back, { q: 1, t: "res", id: 7, ok: true, d: {} });
	});

	it("gives silence to an unknown device and blocks the peer", () => {
		const devices = store();
		const stranger = new FakeApp({ did: randomBytes(8), kDev: randomBytes(32) });
		const { ch, sent, closed } = makeChannel(devices);
		ch.receive(stranger.hello().frame);
		assert.equal(sent.length, 0);
		assert.equal(ch.state, "blocked");
		assert.equal(closed.length, 1);
	});

	it("gives silence to a revoked device", () => {
		const devices = store();
		const app = pairedDevice(devices);
		devices.revoke(b64u(app.did));
		const { ch, sent } = makeChannel(devices);
		ch.receive(app.hello().frame);
		assert.equal(sent.length, 0);
		assert.equal(ch.state, "blocked");
	});

	it("rejects a HELLO sealed with the wrong key (no reply, blocked after 3)", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const wrong = new FakeApp({ did: app.did, kDev: randomBytes(32) });
		const { ch, sent } = makeChannel(devices);
		for (let i = 0; i < 3; i++) ch.receive(wrong.hello().frame);
		assert.equal(sent.length, 0);
		assert.equal(ch.state, "blocked");
		// even a correct HELLO afterwards is ignored
		ch.receive(app.hello().frame);
		assert.equal(sent.length, 0);
	});

	it("rejects a HELLO whose header did does not match the sealed AAD", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const other = pairedDevice(devices);
		const h = app.hello();
		const forged = Buffer.from(h.frame);
		other.did.copy(forged, 1); // claim to be `other`, sealed under `app`'s key
		const { ch, sent } = makeChannel(devices);
		ch.receive(forged);
		assert.equal(sent.length, 0);
		assert.notEqual(ch.state, "open");
	});
});

describe("DATA frames", () => {
	it("rejects replayed and out-of-order q, dropping after 3 failures", () => {
		const { app, ch, msgs, closed } = open();
		const f1 = app.data({ t: "req", id: 1, op: "host.info", a: {} }, 5);
		ch.receive(f1);
		assert.equal(msgs.length, 1);
		ch.receive(f1); // replay
		ch.receive(app.data({ t: "req", id: 2, op: "host.info", a: {} }, 3)); // out of order
		assert.equal(msgs.length, 1);
		assert.equal(ch.state, "open");
		ch.receive(app.data({ t: "req", id: 3, op: "host.info", a: {} }, 5)); // equal q
		assert.equal(ch.state, "blocked");
		assert.equal(closed.length, 1);
		ch.receive(app.data({ t: "req", id: 4, op: "host.info", a: {} }, 99));
		assert.equal(msgs.length, 1);
	});

	it("rejects a bridge→app frame reflected back (direction is in the AAD)", () => {
		const { app, ch, sent, msgs } = open();
		ch.send({ t: "ping" });
		const out = sent[sent.length - 1]!;
		ch.receive(out);
		assert.equal(msgs.length, 0);
		void app;
	});

	it("rejects tampered ciphertext", () => {
		const { app, ch, msgs } = open();
		const f = Buffer.from(app.data({ t: "req", id: 1, op: "host.info", a: {} }));
		f[f.length - 20]! ^= 1;
		ch.receive(f);
		assert.equal(msgs.length, 0);
	});

	it("answers ping with pong and ignores pong", () => {
		const { app, ch, sent } = open();
		const before = sent.length;
		ch.receive(app.data({ t: "ping" }));
		assert.deepEqual(app.read(sent[before]!), { q: 1, t: "pong" });
		ch.receive(app.data({ t: "pong" }));
		assert.equal(sent.length, before + 1);
	});

	it("stops accepting data once the device is revoked", () => {
		const { app, ch, msgs, devices } = open();
		devices.revoke(b64u(app.did));
		ch.receive(app.data({ t: "req", id: 1, op: "host.info", a: {} }));
		assert.equal(msgs.length, 0);
		assert.equal(ch.state, "blocked");
	});

	it("refuses to send frames over the 512 KiB plaintext limit", () => {
		const { ch } = open();
		assert.throws(() => ch.send({ t: "res", id: 1, ok: true, d: { big: "x".repeat(600 * 1024) } }), /too large/);
	});
});

describe("keepalive", () => {
	it("pings after 25 s of silence and closes after 70 s", () => {
		const devices = store();
		const app = pairedDevice(devices);
		let t = Date.now();
		const { ch, sent, closed } = makeChannel(devices, () => t);
		const h = app.hello();
		ch.receive(h.frame);
		app.finish(sent[0]!, h.eph, h.nonceA);
		ch.receive(app.data({ t: "pong" })); // first authenticated DATA: the channel is now live
		t += 26_000;
		ch.tick();
		assert.equal(app.read(sent[1]!).t, "ping");
		t += 45_000;
		ch.tick();
		assert.equal(ch.state, "closed");
		assert.deepEqual(closed, ["peer silent"]);
	});

	it("drops a peer that never completes a handshake", () => {
		let t = 0;
		const { ch, closed } = makeChannel(store(), () => t);
		t += 61_000;
		ch.tick();
		assert.deepEqual(closed, ["no handshake"]);
	});
});

describe("finding 3: HELLO replay and half-open channels", () => {
	const helloAt = (app: FakeApp, ts: number) => app.hello({ ts });

	it("rejects a HELLO older than 5 minutes and a HELLO from the future, with no reply", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const now = 5_000_000_000;
		const { ch, sent } = makeChannel(devices, () => now);
		ch.receive(helloAt(app, now - 5 * 60_000 - 1).frame);
		ch.receive(helloAt(app, now + 5 * 60_000 + 1).frame);
		assert.equal(sent.length, 0);
		assert.notEqual(ch.state, "open");
		ch.receive(helloAt(app, now - 60_000).frame);
		assert.equal(sent.length, 1, "a fresh HELLO within the window is answered");
	});

	it("rejects a replayed HELLO (same nonce) on the same channel and on another channel", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const nonces = new NonceCache();
		const a = makeChannel(devices, Date.now, nonces);
		const h = app.hello();
		a.ch.receive(h.frame);
		assert.equal(a.sent.length, 1);
		const b = makeChannel(devices, Date.now, nonces);
		b.ch.receive(h.frame); // attacker replays the captured bytes through a new relay peer
		assert.equal(b.sent.length, 0, "no hello-ok for a replay");
		assert.notEqual(b.ch.state, "open");
		a.ch.receive(h.frame); // and on the same channel
		assert.equal(a.sent.length, 1);
	});

	it("does not count a channel as connected (onOpen, isOpen, lastSeen) until the first authenticated DATA frame", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const before = devices.get(b64u(app.did))!.lastSeen;
		const c = makeChannel(devices);
		const h = app.hello();
		c.ch.receive(h.frame);
		assert.equal(c.ch.state, "open");
		assert.equal(c.sent.length, 1, "hello-ok still goes out immediately");
		assert.equal(c.ch.isOpen, false);
		assert.equal(c.opened.length, 0);
		assert.equal(devices.get(b64u(app.did))!.lastSeen, before);
		app.finish(c.sent[0]!, h.eph, h.nonceA);
		c.ch.receive(app.data({ t: "garbage-but-authenticated" }));
		assert.equal(c.ch.isOpen, true);
		assert.equal(c.opened.length, 1);
		c.ch.receive(app.data({ t: "ping" }));
		assert.equal(c.opened.length, 1, "onOpen fires once");
	});

	it("drops a channel that never sends DATA after the handshake", () => {
		const devices = store();
		const app = pairedDevice(devices);
		let t = Date.now();
		const c = makeChannel(devices, () => t);
		c.ch.receive(app.hello().frame);
		t += 61_000;
		c.ch.tick();
		assert.deepEqual(c.closed, ["no data after handshake"]);
	});

	it("ignores a HELLO for a different device on an open channel, accepts a fresh one for the same device", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const other = pairedDevice(devices);
		const c = makeChannel(devices);
		const h = app.hello();
		c.ch.receive(h.frame);
		app.finish(c.sent[0]!, h.eph, h.nonceA);
		c.ch.receive(other.hello().frame);
		assert.equal(c.sent.length, 1, "no reply to the other device");
		assert.equal(c.ch.did, b64u(app.did));
		const h2 = app.hello();
		c.ch.receive(h2.frame);
		assert.equal(c.sent.length, 2, "same device may re-key");
	});

	it("NonceCache is bounded and expires entries", () => {
		let t = 0;
		const cache = new NonceCache(3, 1000, () => t);
		const n = (i: number) => Buffer.alloc(16, i);
		assert.equal(cache.add("d", n(1)), true);
		assert.equal(cache.add("d", n(1)), false);
		cache.add("d", n(2));
		cache.add("d", n(3));
		cache.add("d", n(4));
		assert.ok(cache.size <= 3, "bounded");
		t += 1001;
		assert.equal(cache.add("d", n(4)), true, "expired entries are forgotten");
	});
});

describe("finding 14: peer-controlled labels are sanitised", () => {
	it("strips control, bidi and format characters from the HELLO label", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const c = makeChannel(devices);
		c.ch.receive(app.hello({ label: "Pi\u202Exel\u0000 \u2066 8\n\n  Pro\u200B", app: "1.0\u0007" }).frame);
		assert.ok(!/[\p{C}\u202A-\u202E\u2066-\u2069]/u.test(c.ch.label), JSON.stringify(c.ch.label));
		assert.ok(c.ch.label.startsWith("Pi") && c.ch.label.includes("Pro"));
		assert.ok(!/\s{2}/.test(c.ch.label));
		assert.equal(c.ch.app, "1.0");
	});

	it("caps the length", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const c = makeChannel(devices);
		c.ch.receive(app.hello({ label: "x".repeat(500) }).frame);
		assert.equal(c.ch.label.length, 64);
	});
});

describe("finding 7: failure counters survive channel re-creation", () => {
	it("a peer blocked once stays blocked when a new Channel object is made for it", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const counters = newPeerCounters();
		const wrong = new FakeApp({ did: app.did, kDev: randomBytes(32) });
		const first = makeChannel(devices, Date.now, undefined, counters);
		for (let i = 0; i < 3; i++) first.ch.receive(wrong.hello().frame);
		assert.equal(counters.blocked, true);
		const second = makeChannel(devices, Date.now, undefined, counters);
		assert.equal(second.ch.state, "blocked");
		second.ch.receive(app.hello().frame);
		assert.equal(second.sent.length, 0, "even a valid HELLO gets nothing from a blocked peer");
	});

	it("failures accumulate across channels instead of resetting", () => {
		const devices = store();
		const app = pairedDevice(devices);
		const counters = newPeerCounters();
		const wrong = new FakeApp({ did: app.did, kDev: randomBytes(32) });
		makeChannel(devices, Date.now, undefined, counters).ch.receive(wrong.hello().frame);
		makeChannel(devices, Date.now, undefined, counters).ch.receive(wrong.hello().frame);
		assert.equal(counters.blocked, false);
		makeChannel(devices, Date.now, undefined, counters).ch.receive(wrong.hello().frame);
		assert.equal(counters.blocked, true);
	});

	it("rate-limits the log lines (one per 5 s, rest counted)", () => {
		const devices = store();
		const app = pairedDevice(devices);
		let t = Date.now();
		const lines: string[] = [];
		const counters = newPeerCounters();
		const wrong = new FakeApp({ did: app.did, kDev: randomBytes(32) });
		const c = makeChannel(devices, () => t, undefined, counters, m => lines.push(m));
		c.ch.receive(wrong.hello().frame);
		c.ch.receive(wrong.hello().frame);
		assert.equal(lines.filter(l => l.includes("failed authentication")).length, 1);
		t += 6000;
		const c2 = makeChannel(devices, () => t, undefined, newPeerCounters(), m => lines.push(m));
		c2.ch.receive(wrong.hello().frame);
		assert.equal(lines.filter(l => l.includes("failed authentication")).length, 2);
	});
});
