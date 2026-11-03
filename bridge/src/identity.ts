/** Bridge identity (PROTOCOL.md §4): P-256 keypair + roomSecret, stored 0600 in identity.json. */
import { randomBytes } from "node:crypto";
import { b64u, generateKeypair, hostIdOf, keypairFromPrivate, roomIdOf, unb64u } from "../../protocol/src/crypto.ts";
import { isRecord } from "./guards.ts";
import { paths } from "./config.ts";
import { readJsonIfExists, writePrivateFile } from "./safefs.ts";

export interface Identity {
	priv: Buffer;
	pub: Buffer;
	roomSecret: Buffer;
	hostId: string;
	roomId: string;
	/** base64url of the public key, as used in pairing links. */
	bpk: string;
	createdAt: number;
}

export function identityFrom(priv: Uint8Array, roomSecret: Uint8Array, createdAt: number): Identity {
	const kp = keypairFromPrivate(priv);
	return {
		priv: kp.priv,
		pub: kp.pub,
		roomSecret: Buffer.from(roomSecret),
		hostId: hostIdOf(kp.pub),
		roomId: roomIdOf(roomSecret),
		bpk: b64u(kp.pub),
		createdAt,
	};
}

export function loadIdentity(dir: string): Identity | null {
	const raw = readJsonIfExists(paths(dir).identity);
	if (raw === undefined) return null;
	if (!isRecord(raw) || raw.v !== 1 || typeof raw.priv !== "string" || typeof raw.pub !== "string" || typeof raw.roomSecret !== "string") {
		throw new Error("identity.json is malformed");
	}
	const priv = unb64u(raw.priv);
	const roomSecret = unb64u(raw.roomSecret);
	if (priv.length !== 32 || roomSecret.length !== 32) throw new Error("identity.json has wrong key lengths");
	const id = identityFrom(priv, roomSecret, typeof raw.createdAt === "number" ? raw.createdAt : 0);
	if (b64u(id.pub) !== raw.pub) throw new Error("identity.json public key does not match the private key");
	return id;
}

/** Creates a new identity. Refuses to overwrite an existing one unless `force`. */
export function createIdentity(dir: string, force = false): Identity {
	if (!force && loadIdentity(dir)) throw new Error("identity already exists (use --force to replace; this un-pairs every device)");
	const kp = generateKeypair();
	const id = identityFrom(kp.priv, randomBytes(32), Date.now());
	writePrivateFile(
		paths(dir).identity,
		`${JSON.stringify({ v: 1, priv: b64u(id.priv), pub: b64u(id.pub), roomSecret: b64u(id.roomSecret), createdAt: id.createdAt }, null, 2)}\n`,
	);
	return id;
}

export function loadOrCreateIdentity(dir: string): Identity {
	return loadIdentity(dir) ?? createIdentity(dir);
}
