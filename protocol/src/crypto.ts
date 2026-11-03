/**
 * Reference implementation of the OMP Remote L1 primitives (docs/PROTOCOL.md §3–§5).
 * Node only (node:crypto). The Android app must reproduce `protocol/test-vectors.json` byte for byte.
 */
import {
	createCipheriv, createDecipheriv, createECDH, createHash, createHmac,
	hkdfSync, randomBytes,
} from "node:crypto";

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

export type Dir = "C" | "B";

export function hkdf(ikm: Uint8Array, salt: Uint8Array | string, info: string, length: number): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/** P-256 keypair as raw bytes: 32-byte private scalar, 65-byte uncompressed public point. */
export function generateKeypair(): { priv: Buffer; pub: Buffer } {
	const e = createECDH("prime256v1");
	e.generateKeys();
	return { priv: e.getPrivateKey(), pub: e.getPublicKey(null, "uncompressed") };
}

export function keypairFromPrivate(priv: Uint8Array): { priv: Buffer; pub: Buffer } {
	const e = createECDH("prime256v1");
	e.setPrivateKey(Buffer.from(priv));
	return { priv: Buffer.from(priv), pub: e.getPublicKey(null, "uncompressed") };
}

/** 32-byte X coordinate of the shared point. */
export function ecdh(priv: Uint8Array, peerPub: Uint8Array): Buffer {
	const e = createECDH("prime256v1");
	e.setPrivateKey(Buffer.from(priv));
	return e.computeSecret(Buffer.from(peerPub));
}

export function aad(type: number, dir: Dir, did?: Uint8Array): Buffer {
	const parts = [Buffer.from("ompr1", "ascii"), Buffer.from([type, dir.charCodeAt(0)])];
	if (type === 0x01 && dir === "C" && did) parts.push(Buffer.from(did));
	return Buffer.concat(parts);
}

/** `IV ‖ ciphertext ‖ tag`. `iv` is injectable only for test vectors. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aadBytes: Uint8Array, iv: Uint8Array = randomBytes(12)): Buffer {
	const c = createCipheriv("aes-256-gcm", key, iv);
	c.setAAD(Buffer.from(aadBytes));
	const ct = Buffer.concat([c.update(plaintext), c.final()]);
	return Buffer.concat([Buffer.from(iv), ct, c.getAuthTag()]);
}

export function open(key: Uint8Array, sealed: Uint8Array, aadBytes: Uint8Array): Buffer {
	if (sealed.byteLength < 12 + 16) throw new Error("sealed frame too short");
	const iv = sealed.subarray(0, 12);
	const tag = sealed.subarray(sealed.byteLength - 16);
	const ct = sealed.subarray(12, sealed.byteLength - 16);
	const d = createDecipheriv("aes-256-gcm", key, iv);
	d.setAAD(Buffer.from(aadBytes));
	d.setAuthTag(Buffer.from(tag));
	return Buffer.concat([d.update(ct), d.final()]);
}

export const pairKeyFrom = (pt: Uint8Array): Buffer => hkdf(pt, "ompr/v1/pair", "pair", 32);
export const deviceKeyFrom = (shared: Uint8Array, pt: Uint8Array): Buffer => hkdf(shared, pt, "ompr/v1/device", 32);

export function sessionKeys(sharedEph: Uint8Array, kDev: Uint8Array, nonceA: Uint8Array, nonceB: Uint8Array): { c2b: Buffer; b2c: Buffer } {
	const okm = hkdf(sharedEph, Buffer.concat([Buffer.from(kDev), Buffer.from(nonceA), Buffer.from(nonceB)]), "ompr/v1/session", 64);
	return { c2b: okm.subarray(0, 32), b2c: okm.subarray(32, 64) };
}

export const hostIdOf = (bpk: Uint8Array): string => b64u(createHash("sha256").update(bpk).digest()).slice(0, 11);
export const roomIdOf = (roomSecret: Uint8Array): string =>
	b64u(createHmac("sha256", roomSecret).update("ompr/v1/room").digest()).slice(0, 22);

/** Relay envelope: `[4B uint32 BE peerId][payload]`. */
export function packEnvelope(peerId: number, payload: Uint8Array): Buffer {
	const h = Buffer.alloc(4);
	h.writeUInt32BE(peerId, 0);
	return Buffer.concat([h, Buffer.from(payload)]);
}
export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Buffer } | null {
	if (data.byteLength < 4) return null;
	const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return { peerId: b.readUInt32BE(0), payload: b.subarray(4) };
}

/**
 * Short authentication string shown on BOTH the PC prompt and the phone during pairing (PROTOCOL.md §4). It binds the
 * pairing token, the requesting device key and the bridge key, so a requester who only has the link (and therefore
 * must use its own device key) cannot produce the code the real phone shows. Format: `123 456`.
 */
export function sasOf(pt: Uint8Array, dpk: Uint8Array, bpk: Uint8Array): string {
	const salt = Buffer.concat([createHash("sha256").update(dpk).digest(), Buffer.from(bpk)]);
	const n = hkdf(pt, salt, "ompr/v1/sas", 4).readUInt32BE(0) % 1_000_000;
	const s = String(n).padStart(6, "0");
	return `${s.slice(0, 3)} ${s.slice(3)}`;
}
