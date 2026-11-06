import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { describe, it } from "node:test";
import { ecdh, fixed32, generateKeypair, keypairFromPrivate } from "../../protocol/src/crypto.ts";

describe("P-256 private keys are always 32 bytes", () => {
	it("pads a scalar whose leading bytes are zero, and refuses one that is too long", () => {
		const short = Buffer.from("00ff", "hex").subarray(1); // 1 byte: 0xff
		const padded = fixed32(short);
		assert.equal(padded.length, 32);
		assert.equal(padded[31], 0xff);
		assert.ok(padded.subarray(0, 31).every(x => x === 0));
		const full = Buffer.alloc(32, 7);
		assert.deepEqual(fixed32(full), full);
		assert.throws(() => fixed32(Buffer.alloc(33)), /longer than 32/);
	});

	it("Node really does return short private keys sometimes (why the padding exists)", () => {
		// A private scalar with leading zero bytes, set explicitly so the check is deterministic.
		const e = createECDH("prime256v1");
		const scalar = Buffer.alloc(32);
		scalar[31] = 5; // 0x00..05
		e.setPrivateKey(scalar);
		assert.equal(e.getPrivateKey().length < 32, true, "if this fails, Node changed and fixed32 is no longer needed");
		assert.equal(keypairFromPrivate(e.getPrivateKey()).priv.length, 32);
	});

	it("generateKeypair never returns a short key, and the key still works for ECDH", () => {
		// About 1 in 256 raw keys is short; 6000 draws make a pre-fix failure all but certain (1 - (255/256)^6000).
		for (let i = 0; i < 6000; i++) {
			const k = generateKeypair();
			assert.equal(k.priv.length, 32);
			assert.equal(k.pub.length, 65);
		}
		const a = generateKeypair();
		const b = generateKeypair();
		assert.deepEqual(ecdh(a.priv, b.pub), ecdh(b.priv, a.pub));
	});

	it("a padded private key reproduces the same public key", () => {
		const e = createECDH("prime256v1");
		const scalar = Buffer.alloc(32);
		scalar[30] = 1;
		scalar[31] = 2;
		e.setPrivateKey(scalar);
		const k = keypairFromPrivate(scalar);
		assert.deepEqual(k.pub, e.getPublicKey(null, "uncompressed"));
		assert.deepEqual(k.priv, scalar);
	});
});
