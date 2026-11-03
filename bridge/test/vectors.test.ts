/** Reproduces every vector of protocol/test-vectors.json through the bridge's own identity/pairing/channel code. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { aad, b64u, packEnvelope, sasOf, unb64u, unpackEnvelope, open, pairKeyFrom } from "../../protocol/src/crypto.ts";
import type { HostInfo } from "../../protocol/src/index.ts";
import { Channel } from "../src/channel.ts";
import { DeviceStore } from "../src/devices.ts";
import { identityFrom } from "../src/identity.ts";
import { PairingManager } from "../src/pairing.ts";

const V = JSON.parse(readFileSync(new URL("../../protocol/test-vectors.json", import.meta.url), "utf8"));
const hex = (s: string): Buffer => Buffer.from(s, "hex");
const tmp = mkdtempSync(join(tmpdir(), "ompr-vec-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const identity = identityFrom(hex(V.keys.bridgePriv), hex(V.inputs.roomSecret), 0);

describe("identity", () => {
	it("derives the vector bridge public key, hostId and roomId", () => {
		assert.equal(identity.pub.toString("hex"), V.keys.bridgePub);
		assert.equal(identity.bpk, V.derived.bridgePub_b64u);
		assert.equal(identity.hostId, V.derived.hostId);
		assert.equal(identity.roomId, V.derived.roomId);
	});
});

describe("SAS (finding 1)", () => {
	it("sasOf reproduces the vector", () => {
		assert.equal(sasOf(hex(V.inputs.pairingToken), hex(V.keys.devicePub), hex(V.keys.bridgePub)), V.derived.sas);
		assert.equal(V.derived.sas, "230 428");
	});
	it("changes when the device key, the bridge key or the token changes", () => {
		const base = sasOf(hex(V.inputs.pairingToken), hex(V.keys.devicePub), hex(V.keys.bridgePub));
		assert.notEqual(sasOf(hex(V.inputs.pairingToken), hex(V.keys.ephAPub), hex(V.keys.bridgePub)), base);
		assert.notEqual(sasOf(hex(V.inputs.pairingToken), hex(V.keys.devicePub), hex(V.keys.ephBPub)), base);
		assert.notEqual(sasOf(Buffer.alloc(32, 9), hex(V.keys.devicePub), hex(V.keys.bridgePub)), base);
	});
});

describe("relay envelope", () => {
	it("packs and unpacks like the vector", () => {
		const packed = packEnvelope(V.envelope.peerId, hex(V.envelope.payloadHex));
		assert.equal(packed.toString("hex"), V.envelope.packedHex);
		const u = unpackEnvelope(packed)!;
		assert.equal(u.peerId, V.envelope.peerId);
		assert.equal(u.payload.toString("hex"), V.envelope.payloadHex);
	});
});

describe("pairing → K_dev", () => {
	it("accepts the vector pair-req and stores the vector K_dev", async () => {
		const dir = join(tmp, "pair");
		const devices = new DeviceStore(dir);
		const logs: string[] = [];
		const iv = hex(V.frames.pair.iv);
		const replyIv = Buffer.from("00112233445566778899aabb", "hex");
		const pm = new PairingManager({
			identity,
			devices,
			hostName: "vec-host",
			log: m => logs.push(m),
			now: () => 1700000000000,
			random: { token: () => Buffer.from(hex(V.inputs.pairingToken)), did: () => hex(V.inputs.did), iv: () => replyIv },
		});
		let seenSas = "";
		const session = pm.begin({ relays: ["wss://relay.example"], confirm: async (_label, sas) => ((seenSas = sas), true) });
		const u = new URL(session.link.replace("ompr://", "https://"));
		assert.equal(u.searchParams.get("pt"), b64u(hex(V.inputs.pairingToken)));
		assert.equal(u.searchParams.get("bpk"), V.derived.bridgePub_b64u);
		assert.equal(u.searchParams.get("v"), "2");
		assert.equal(u.searchParams.get("rid"), V.derived.roomId, "finding 8: the link carries the derived roomId");
		assert.equal(u.searchParams.get("rs"), null, "finding 8: the permanent roomSecret never leaves the bridge");
		assert.ok(!session.link.includes(b64u(hex(V.inputs.roomSecret))));
		assert.deepEqual(u.searchParams.getAll("r"), ["wss://relay.example"]);
		void iv;

		const reply = await pm.handle(hex(V.frames.pair.payload));
		assert.equal(seenSas, V.derived.sas, "finding 1: the code the PC shows is the vector SAS");
		assert.ok(reply, "bridge must reply pair-ok");
		const plain = JSON.parse(open(pairKeyFrom(hex(V.inputs.pairingToken)), reply.subarray(1), aad(0x00, "B")).toString());
		assert.deepEqual(plain, { t: "pair-ok", did: b64u(hex(V.inputs.did)), hostId: V.derived.hostId, name: "vec-host" });
		const dev = devices.get(b64u(hex(V.inputs.did)))!;
		assert.equal(Buffer.from(unb64u(dev.kDev)).toString("hex"), V.derived.kDev);
		assert.equal(dev.dpk, V.derived.devicePub_b64u);
		assert.equal(dev.label, "Pixel 8");
		assert.equal(pm.activeCount, 0, "token is single use");
		assert.equal(await pm.handle(hex(V.frames.pair.payload)), null, "replayed pair-req gets silence");
		assert.ok(!logs.join("\n").includes(V.inputs.pairingToken));
	});
});

describe("channel handshake + data", () => {
	it("reproduces hello-ok and the b2c data frame byte for byte, and accepts the c2b data frame", () => {
		const dir = join(tmp, "chan");
		const devices = new DeviceStore(dir);
		devices.add({ did: b64u(hex(V.inputs.did)), label: "Pixel 8", dpk: V.derived.devicePub_b64u, kDev: b64u(hex(V.derived.kDev)) });
		const sent: Buffer[] = [];
		const ivs = [hex(V.frames.helloOk.iv), hex(V.frames.dataB2C.iv)];
		const msgs: unknown[] = [];
		const host: HostInfo = { proto: 1, hostId: V.derived.hostId } as HostInfo;
		const ch = new Channel({
			id: "vec#1",
			devices,
			hostInfo: () => host,
			send: p => sent.push(p),
			onPair: async () => null,
			onOpen: () => {},
			onMessage: (_c, m) => msgs.push(m),
			onClosed: () => {},
			log: () => {},
			now: () => 1700000000000, // the vector HELLO is timestamped 1700000000000
			random: {
				ephemeral: () => ({ priv: hex(V.keys.ephBPriv), pub: hex(V.keys.ephBPub) }),
				nonce: () => hex(V.inputs.nonceB),
				iv: () => ivs.shift()!,
			},
		});
		ch.receive(hex(V.frames.hello.payload));
		assert.equal(ch.state, "open");
		assert.equal(ch.did, b64u(hex(V.inputs.did)));
		assert.deepEqual(ch.caps, ["location", "notify"]);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.toString("hex"), V.frames.helloOk.payload);

		ch.receive(hex(V.frames.dataC2B.payload));
		assert.deepEqual(msgs, [{ q: 1, t: "req", id: 1, op: "host.info", a: {} }]);

		ch.send({ t: "res", id: 1, ok: true, d: { proto: 1 } });
		assert.equal(sent.length, 2);
		assert.equal(sent[1]!.toString("hex"), V.frames.dataB2C.payload);
	});
});
