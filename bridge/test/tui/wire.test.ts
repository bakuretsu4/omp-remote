import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { formatCollabLink, parseCollabLink } from "../../src/tui/collab-link.ts";
import { COLLAB_PROTO, openFrame, openText, packEnvelope, sealFrame, sealText, unpackEnvelope } from "../../src/tui/collab-wire.ts";

const ROOM = "AbCdEfGhIjKlMnOpQrStUv";
const key = randomBytes(32);
const token = randomBytes(16);
const full = Buffer.concat([key, token]).toString("base64url");
const view = key.toString("base64url");

test("parseCollabLink accepts every documented form", () => {
	const forms: [string, string][] = [
		[`${ROOM}.${full}`, "wss://my.omp.sh/r/" + ROOM],
		[`${ROOM}#${full}`, "wss://my.omp.sh/r/" + ROOM],
		[`relay.example.com/r/${ROOM}.${full}`, "wss://relay.example.com/r/" + ROOM],
		[`relay.example.com:8443/r/${ROOM}#${full}`, "wss://relay.example.com:8443/r/" + ROOM],
		[`https://relay.example.com/r/${ROOM}.${full}`, "wss://relay.example.com/r/" + ROOM],
		[`wss://relay.example.com/r/${ROOM}.${full}`, "wss://relay.example.com/r/" + ROOM],
		[`ws://127.0.0.1:7466/r/${ROOM}.${full}`, "ws://127.0.0.1:7466/r/" + ROOM],
		[`ws://localhost:7475/r/${ROOM}#${full}`, "ws://localhost:7475/r/" + ROOM],
		[`https://my.omp.sh/#${ROOM}.${full}`, "wss://my.omp.sh/r/" + ROOM],
		[`https://web.example/collab/#relay.example.com/r/${ROOM}.${full}`, "wss://relay.example.com/r/" + ROOM],
		[`https://my.omp.sh/#${ROOM}%23${full}`, "wss://my.omp.sh/r/" + ROOM],
		[`  ${ROOM}.${full}\n`, "wss://my.omp.sh/r/" + ROOM],
	];
	for (const [input, wsUrl] of forms) {
		const parsed = parseCollabLink(input);
		assert.ok(!("error" in parsed), `${input}: ${"error" in parsed ? parsed.error : ""}`);
		assert.equal(parsed.wsUrl, wsUrl, input);
		assert.equal(parsed.roomId, ROOM);
		assert.deepEqual(Buffer.from(parsed.key), key);
		assert.deepEqual(Buffer.from(parsed.writeToken ?? []), token);
	}
});

test("parseCollabLink: view links carry no write token; bad links are rejected", () => {
	const parsed = parseCollabLink(`${ROOM}.${view}`);
	assert.ok(!("error" in parsed));
	assert.equal(parsed.writeToken, undefined);
	assert.equal(parsed.key.byteLength, 32);

	for (const bad of [
		"",
		"not a link",
		`ws://evil.example.com/r/${ROOM}.${full}`, // plain ws only for loopback
		`relay.example.com/r/${ROOM}`, // missing key
		`relay.example.com/r/${ROOM}.${Buffer.alloc(31).toString("base64url")}`, // wrong key length
		`relay.example.com/x/${ROOM}.${full}`,
		`ftp://relay.example.com/r/${ROOM}.${full}`,
	]) {
		assert.ok("error" in parseCollabLink(bad), `expected error for ${JSON.stringify(bad)}`);
	}
});

test("formatCollabLink round-trips through parseCollabLink", () => {
	for (const relay of ["wss://my.omp.sh", "wss://relay.example.com:9443", "ws://127.0.0.1:7466"]) {
		const text = formatCollabLink(relay, ROOM, key, token);
		const parsed = parseCollabLink(text);
		assert.ok(!("error" in parsed));
		assert.equal(parsed.roomId, ROOM);
		assert.deepEqual(Buffer.from(parsed.writeToken!), token);
	}
	assert.equal(formatCollabLink("wss://my.omp.sh", ROOM, key), `${ROOM}.${view}`);
});

test("sealing is AES-256-GCM [IV][ct][tag] and interoperates with WebCrypto (what omp itself uses)", async () => {
	const text = JSON.stringify({ t: "prompt", text: "héllo ✓" });
	const sealed = sealText(key, text);
	assert.equal(sealed.byteLength, 12 + Buffer.byteLength(text) + 16);

	// node → WebCrypto
	const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(sealed.subarray(0, 12)) }, ck, new Uint8Array(sealed.subarray(12)));
	assert.equal(new TextDecoder().decode(plain), text);

	// WebCrypto → node
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(text)));
	const fromWeb = Buffer.concat([iv, ct]);
	assert.equal(openText(key, fromWeb), text);
});

test("open rejects tampering, wrong keys and truncation; IVs are fresh", () => {
	const sealed = sealText(key, "x".repeat(100));
	const tampered = Buffer.from(sealed);
	tampered[20]! ^= 1;
	assert.throws(() => openText(key, tampered));
	assert.throws(() => openText(randomBytes(32), sealed));
	assert.throws(() => openText(key, sealed.subarray(0, 20)));
	assert.throws(() => openText(key, Buffer.alloc(5)));
	assert.notDeepEqual(sealText(key, "a").subarray(0, 12), sealText(key, "a").subarray(0, 12));
});

test("frames and relay envelope", () => {
	const hello = { t: "hello", proto: COLLAB_PROTO, name: "ompr-bridge", writeToken: token.toString("base64url") } as const;
	const sealed = sealFrame(key, hello);
	const env = packEnvelope(0, sealed);
	assert.equal(env.readUInt32BE(0), 0);
	const un = unpackEnvelope(env);
	assert.ok(un);
	assert.deepEqual(openFrame(key, un.payload), hello);
	assert.equal(packEnvelope(0x01020304, sealed).readUInt32BE(0), 0x01020304);
	assert.equal(unpackEnvelope(new Uint8Array(3)), null);
	assert.throws(() => openFrame(key, sealText(key, "[1,2]")), /malformed/);
	assert.throws(() => openFrame(key, sealText(key, "not json")));
});
