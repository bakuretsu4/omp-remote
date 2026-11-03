/**
 * omp collab link parsing (standalone port of omp's `parseCollabLink`; no omp imports).
 *
 * NOTE: the room secret here is omp's collab link secret. It has nothing to do with OMP Remote's own
 * crypto (`protocol/src/crypto.ts`): collab frames are sealed with the first 32 bytes of the link secret.
 *
 * Accepted forms (see omp docs/collab.md):
 *   <roomId>.<key>                         → default relay (wss://my.omp.sh); legacy `<roomId>#<key>`
 *   host[:port]/r/<roomId>.<key>           → custom relay, wss:// inferred; legacy `…/r/<roomId>#<key>`
 *   https://host[:port]/r/<roomId>.<key>   → normalized to wss://
 *   wss://host[:port]/r/<roomId>.<key>
 *   ws://localhost:7466/r/<roomId>.<key>   → plain ws, loopback only
 *   https://host/#<link>                   → browser deep link; the fragment wins when it is a complete link
 * `<key>` is base64url: 32 bytes (view-only) or 48 bytes (32-byte room key + 16-byte write token).
 */

export const DEFAULT_RELAY_URL = "wss://my.omp.sh";
export const ROOM_KEY_BYTES = 32;
export const WRITE_TOKEN_BYTES = 16;

export interface ParsedCollabLink {
	/** ws(s)://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	/** 32-byte AES-256-GCM room key. */
	key: Uint8Array;
	/** 16-byte write token from a full link; absent for view-only links. */
	writeToken?: Uint8Array;
}

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && LOCAL_HOSTNAMES[url.hostname] !== true) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Terminals that open OSC 8 links through strict URL stacks percent-encode the legacy second `#`.
	let text = link.trim().replace(/%23/gi, "#");
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: "Invalid collab link" };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1]!;
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) return { error: "Collab link is missing the <key> part" };
	const secret = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	return {
		wsUrl: `${normalized.origin}/r/${roomId}`,
		roomId,
		key: secret.subarray(0, ROOM_KEY_BYTES),
		writeToken: secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined,
	};
}

/**
 * Render a collab link the way omp does (`formatCollabLink`). Used by tests' fake host and by anything that
 * needs to hand a link to omp; the default relay collapses to `<roomId>.<key>`, loopback ws:// keeps its URL.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const secret = writeToken ? Buffer.concat([key, writeToken]) : Buffer.from(key);
	const keyText = secret.toString("base64url");
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://") ? normalized.origin.slice("wss://".length) : normalized.origin;
	return `${compact}/r/${roomId}.${keyText}`;
}
