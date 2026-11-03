/**
 * Generates protocol/test-vectors.json (deterministic) and self-checks it.
 *   node protocol/gen-vectors.ts          # regenerate + verify
 * Both the bridge test-suite and the Android unit tests MUST reproduce every field.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as C from "./src/crypto.ts";
import assert from "node:assert/strict";

const det = (label: string, n: number): Buffer => createHash("sha256").update(`ompr-vector:${label}`).digest().subarray(0, n);
const detScalar = (label: string): Buffer => createHash("sha256").update(`ompr-vector:${label}`).digest(); // valid P-256 scalar for these labels
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const bridge = C.keypairFromPrivate(detScalar("bridge-priv"));
const device = C.keypairFromPrivate(detScalar("device-priv"));
const ephA = C.keypairFromPrivate(detScalar("ephA-priv"));
const ephB = C.keypairFromPrivate(detScalar("ephB-priv"));
const pt = det("pairing-token", 32);
const roomSecret = det("room-secret", 32);
const did = det("device-id", 8);
const nonceA = det("nonceA", 16);
const nonceB = det("nonceB", 16);

const pairKey = C.pairKeyFrom(pt);
const sharedDev = C.ecdh(device.priv, bridge.pub);
assert.equal(hex(sharedDev), hex(C.ecdh(bridge.priv, device.pub)));
const kDev = C.deviceKeyFrom(sharedDev, pt);
const sharedEph = C.ecdh(ephA.priv, ephB.pub);
assert.equal(hex(sharedEph), hex(C.ecdh(ephB.priv, ephA.pub)));
const { c2b, b2c } = C.sessionKeys(sharedEph, kDev, nonceA, nonceB);

const pairReq = JSON.stringify({ t: "pair-req", dpk: C.b64u(device.pub), label: "Pixel 8", ts: 1700000000000 });
const helloPlain = JSON.stringify({ t: "hello", eph: C.b64u(ephA.pub), n: C.b64u(nonceA), ts: 1700000000000, caps: ["location", "notify"], app: "0.1.0", label: "Pixel 8" });
const helloOkPlain = JSON.stringify({ t: "hello-ok", eph: C.b64u(ephB.pub), n: C.b64u(nonceB), host: { proto: 1, hostId: C.hostIdOf(bridge.pub) } });
const dataC = JSON.stringify({ q: 1, t: "req", id: 1, op: "host.info", a: {} });
const dataB = JSON.stringify({ q: 1, t: "res", id: 1, ok: true, d: { proto: 1 } });

const iv = (l: string) => det(`iv:${l}`, 12);
const sealedPair = C.seal(pairKey, Buffer.from(pairReq), C.aad(0x00, "C"), iv("pair"));
const sealedHello = C.seal(kDev, Buffer.from(helloPlain), C.aad(0x01, "C", did), iv("hello"));
const sealedHelloOk = C.seal(kDev, Buffer.from(helloOkPlain), C.aad(0x01, "B"), iv("helloOk"));
const sealedDataC = C.seal(c2b, Buffer.from(dataC), C.aad(0x02, "C"), iv("dataC"));
const sealedDataB = C.seal(b2c, Buffer.from(dataB), C.aad(0x02, "B"), iv("dataB"));

// round-trip self-check
assert.equal(C.open(pairKey, sealedPair, C.aad(0x00, "C")).toString(), pairReq);
assert.equal(C.open(kDev, sealedHello, C.aad(0x01, "C", did)).toString(), helloPlain);
assert.equal(C.open(c2b, sealedDataC, C.aad(0x02, "C")).toString(), dataC);
assert.throws(() => C.open(c2b, sealedDataC, C.aad(0x02, "B")), "reflection must fail (AAD dir)");

const vectors = {
	_doc: "All byte strings are lowercase hex unless the key ends in _b64u. IVs are fixed for the vector only; production IVs are random.",
	keys: {
		bridgePriv: hex(bridge.priv), bridgePub: hex(bridge.pub), devicePriv: hex(device.priv), devicePub: hex(device.pub),
		ephAPriv: hex(ephA.priv), ephAPub: hex(ephA.pub), ephBPriv: hex(ephB.priv), ephBPub: hex(ephB.pub),
	},
	inputs: { pairingToken: hex(pt), roomSecret: hex(roomSecret), did: hex(did), nonceA: hex(nonceA), nonceB: hex(nonceB) },
	derived: {
		pairKey: hex(pairKey), sharedDevice: hex(sharedDev), kDev: hex(kDev), sharedEph: hex(sharedEph),
		kC2B: hex(c2b), kB2C: hex(b2c), hostId: C.hostIdOf(bridge.pub), roomId: C.roomIdOf(roomSecret),
		bridgePub_b64u: C.b64u(bridge.pub), devicePub_b64u: C.b64u(device.pub),
		sas: C.sasOf(pt, device.pub, bridge.pub),
	},
	frames: {
		pair: { aad: hex(C.aad(0x00, "C")), iv: hex(iv("pair")), plaintext: pairReq, payload: hex(Buffer.concat([Buffer.from([0x00]), sealedPair])) },
		hello: { aad: hex(C.aad(0x01, "C", did)), iv: hex(iv("hello")), plaintext: helloPlain, payload: hex(Buffer.concat([Buffer.from([0x01]), did, sealedHello])) },
		helloOk: { aad: hex(C.aad(0x01, "B")), iv: hex(iv("helloOk")), plaintext: helloOkPlain, payload: hex(Buffer.concat([Buffer.from([0x01]), sealedHelloOk])) },
		dataC2B: { aad: hex(C.aad(0x02, "C")), iv: hex(iv("dataC")), plaintext: dataC, payload: hex(Buffer.concat([Buffer.from([0x02]), sealedDataC])) },
		dataB2C: { aad: hex(C.aad(0x02, "B")), iv: hex(iv("dataB")), plaintext: dataB, payload: hex(Buffer.concat([Buffer.from([0x02]), sealedDataB])) },
	},
	envelope: { peerId: 7, payloadHex: "0200ff", packedHex: hex(C.packEnvelope(7, Buffer.from([0x02, 0x00, 0xff]))) },
};
writeFileSync(new URL("./test-vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
console.log("test-vectors.json written; round-trips OK");
console.log("roomId", vectors.derived.roomId, "hostId", vectors.derived.hostId);
