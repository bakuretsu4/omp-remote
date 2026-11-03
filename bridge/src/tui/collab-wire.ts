/**
 * omp collab wire (proto v3): frame types, AES-256-GCM sealing and the relay envelope.
 * Standalone — mirrors omp's `@oh-my-pi/pi-wire` grammar and `collab/crypto.ts` without importing omp.
 *
 * Sealed layout: `[12B IV][ciphertext][16B GCM tag]`, key = the room key (first 32 bytes of the link secret).
 * Relay envelope: `[4B uint32 BE peerId][sealed payload]`; guest→relay always uses peerId 0.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const COLLAB_PROTO = 3;
export const ENVELOPE_HEADER_LENGTH = 4;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ───────────────────────────── wire shapes (host → guest) ─────────────────────────────

export interface WireImage { type: "image"; data: string; mimeType: string }

export interface WireModel { id: string; name: string; provider: string; contextWindow: number | null }

export interface WireParticipant { name: string; role: "host" | "guest"; readOnly?: boolean }

export interface WireState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	cwd: string;
	model?: WireModel;
	thinkingLevel?: string;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
	participants: WireParticipant[];
	isAborting?: boolean;
}

export interface WireAgent {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: string;
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

export interface WireHeader { type: "session"; id: string; title?: string; timestamp: string; cwd: string }

/** A replicated session entry. Only the fields the bridge reads are typed; unknown `type`s are skipped by callers. */
export interface WireEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	// message
	message?: Record<string, unknown>;
	// custom_message
	customType?: string;
	content?: unknown;
	details?: unknown;
	display?: boolean;
	// compaction / branch_summary
	summary?: string;
	shortSummary?: string;
	tokensBefore?: number;
	// model_change / thinking_level_change
	model?: string;
	thinkingLevel?: string | null;
}

/** An agent session event; the shape is the omp AgentEvent subset. Callers discriminate on `type`. */
export interface WireEvent { type: string; [key: string]: unknown }

export type WireUiOption = string | { label: string; description?: string };

export type WireUiRequest =
	| {
			reqId: number;
			kind: "select";
			title: string;
			options: WireUiOption[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| { reqId: number; kind: "editor"; title: string; prefill?: string };

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: WireHeader;
			state: WireState;
			agents: WireAgent[];
			entryCount: number;
			readOnly?: boolean;
	  }
	| { t: "snapshot-chunk"; entries: WireEntry[]; final: boolean }
	| { t: "entry"; entry: WireEntry }
	| { t: "event"; event: WireEvent }
	| { t: "state"; state: WireState }
	| { t: "bus"; channel: string; data: unknown }
	| { t: "agents"; agents: WireAgent[] }
	| { t: "ui-request"; request: WireUiRequest }
	| { t: "ui-request-end"; reqId: number }
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

// ───────────────────────────── wire shapes (guest → host) ─────────────────────────────

export type GuestFrame =
	| { t: "hello"; proto: number; name: string; writeToken?: string }
	| { t: "prompt"; text: string; images?: WireImage[] }
	| { t: "ui-response"; reqId: number; value?: string }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

// ───────────────────────────── crypto ─────────────────────────────

/** Seal a UTF-8 JSON string: `[IV][ciphertext][tag]`. */
export function sealText(key: Uint8Array, text: string): Buffer {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** Inverse of {@link sealText}. Throws on malformed input or authentication failure. */
export function openText(key: Uint8Array, data: Uint8Array): string {
	if (data.byteLength <= IV_LENGTH + TAG_LENGTH) throw new Error("sealed frame too short");
	const iv = data.subarray(0, IV_LENGTH);
	const tag = data.subarray(data.byteLength - TAG_LENGTH);
	const ct = data.subarray(IV_LENGTH, data.byteLength - TAG_LENGTH);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function sealFrame(key: Uint8Array, frame: GuestFrame | HostFrame): Buffer {
	return sealText(key, JSON.stringify(frame));
}

export function openFrame(key: Uint8Array, data: Uint8Array): HostFrame | GuestFrame {
	const parsed: unknown = JSON.parse(openText(key, data));
	if (typeof parsed !== "object" || parsed === null || !("t" in parsed) || typeof parsed.t !== "string") {
		throw new Error("malformed collab frame");
	}
	return parsed as HostFrame | GuestFrame;
}

// ───────────────────────────── relay envelope ─────────────────────────────

export function packEnvelope(peerId: number, sealed: Uint8Array): Buffer {
	const out = Buffer.allocUnsafe(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	out.writeUInt32BE(peerId, 0);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}
