/**
 * omp AgentMessage (or collab WireMessage of the same shape) → protocol `Message` (PROTOCOL.md §6.3).
 * Shared by the managed and TUI backends.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Block, Message } from "../../../protocol/src/index.ts";
import type { BlobStore } from "../backend.ts";
import { isRecord } from "../guards.ts";

export { normalizeUiRequest, uiAnswerToResponse } from "./ui.ts";

/** Tool output per `tool.update` / `tool.end` / toolResult text block (PROTOCOL.md §6.3). */
export const TOOL_OUTPUT_LIMIT = 32 * 1024;
/** Assistant/user text and thinking blocks. */
export const TEXT_BLOCK_LIMIT = 64 * 1024;
/** Strings inside tool-call arguments (e.g. the content of a `write`). */
export const ARG_STRING_LIMIT = 4 * 1024;

export interface NormalizeOptions {
	blobs: BlobStore;
	/** Message id; defaults to raw `id`/`entryId`/`messageId`, else a generated `n_…`. */
	id?: string;
	/** Sets `from` (collab guest or phone). */
	from?: string;
	/** Resolves persisted `blob:sha256:…` image references; unresolved images are replaced by a text note. */
	resolveBlob?: (ref: string, mimeType: string) => { bytes: Uint8Array; mimeType: string } | undefined;
}

let generated = 0;

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number = TOOL_OUTPUT_LIMIT): { text: string; truncated: boolean } {
	// A UTF-16 code unit encodes to at most 3 bytes, so this is a safe upper bound.
	if (text.length * 3 <= maxBytes) return { text, truncated: false };
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	return { text: buf.toString("utf8", 0, end), truncated: true };
}

/** Plain text of an omp tool-result `content` array (images become `[image: mime]`). */
export function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!isRecord(b)) continue;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "image") parts.push(`[image: ${typeof b.mimeType === "string" ? b.mimeType : "unknown"}]`);
	}
	return parts.join("\n");
}

/** Text + truncation flag for a tool update/result object (`{content:[…]}`) or bare string. */
export function toolOutput(result: unknown): { text: string; truncated: boolean } {
	const full = isRecord(result) ? toolResultText(result.content) : toolResultText(result);
	return truncateUtf8(full, TOOL_OUTPUT_LIMIT);
}

/** Deep-copy `value` shrinking long strings and big containers so tool-call arguments stay small. */
export function shrinkArguments(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		if (value.length <= ARG_STRING_LIMIT) return value;
		const { text } = truncateUtf8(value, ARG_STRING_LIMIT);
		return `${text}… [+${value.length - text.length} chars]`;
	}
	if (Array.isArray(value)) {
		if (depth > 6) return "[…]";
		const out = value.slice(0, 50).map(v => shrinkArguments(v, depth + 1));
		if (value.length > 50) out.push(`[+${value.length - 50} more]`);
		return out;
	}
	if (isRecord(value)) {
		if (depth > 6) return "{…}";
		const out: Record<string, unknown> = {};
		let n = 0;
		for (const [k, v] of Object.entries(value)) {
			if (n++ >= 50) {
				out["…"] = `+${Object.keys(value).length - 50} more keys`;
				break;
			}
			out[k] = shrinkArguments(v, depth + 1);
		}
		return out;
	}
	return value;
}

function resolveOmpBlob(ref: string, mimeType: string): { bytes: Uint8Array; mimeType: string } | undefined {
	const m = /^blob:sha256:([0-9a-f]{64})$/.exec(ref);
	if (!m) return undefined;
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
	try {
		return { bytes: readFileSync(join(dir, "blobs", m[1]!)), mimeType };
	} catch {
		return undefined;
	}
}

function imageBlock(b: Record<string, unknown>, opts: NormalizeOptions): Block | { type: "text"; text: string } {
	const mimeType = typeof b.mimeType === "string" ? b.mimeType : "image/png";
	const data = b.data;
	if (typeof data === "string" && data.startsWith("blob:")) {
		const resolved = (opts.resolveBlob ?? resolveOmpBlob)(data, mimeType);
		if (resolved) return { type: "image", ref: opts.blobs.put(resolved.bytes, resolved.mimeType), mimeType: resolved.mimeType, bytes: resolved.bytes.byteLength };
		return { type: "text", text: `[image unavailable: ${mimeType}]` };
	}
	if (typeof data !== "string" || data.length === 0) return { type: "text", text: `[image unavailable: ${mimeType}]` };
	const bytes = Buffer.from(data, "base64");
	return { type: "image", ref: opts.blobs.put(bytes, mimeType), mimeType, bytes: bytes.byteLength };
}

function textBlock(text: string, limit: number): Block {
	const t = truncateUtf8(text, limit);
	return t.truncated ? { type: "text", text: t.text, truncated: true } : { type: "text", text: t.text };
}

function normalizeBlocks(content: unknown, role: Message["role"], opts: NormalizeOptions): Block[] {
	const limit = role === "toolResult" ? TOOL_OUTPUT_LIMIT : TEXT_BLOCK_LIMIT;
	if (typeof content === "string") return content.length ? [textBlock(content, limit)] : [];
	if (!Array.isArray(content)) return [];
	const out: Block[] = [];
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		switch (raw.type) {
			case "text":
				if (typeof raw.text === "string" && raw.text.length) out.push(textBlock(raw.text, limit));
				break;
			case "thinking": {
				const s = typeof raw.thinking === "string" ? raw.thinking : "";
				if (!s.length) break;
				const t = truncateUtf8(s, TEXT_BLOCK_LIMIT);
				out.push(t.truncated ? { type: "thinking", thinking: t.text, truncated: true } : { type: "thinking", thinking: t.text });
				break;
			}
			case "toolCall": {
				if (typeof raw.id !== "string" || typeof raw.name !== "string") break;
				const args = shrinkArguments(isRecord(raw.arguments) ? raw.arguments : {}) as Record<string, unknown>;
				const block: Block = { type: "toolCall", id: raw.id, name: raw.name, arguments: args };
				if (typeof raw.intent === "string") block.intent = raw.intent;
				out.push(block);
				break;
			}
			case "image":
				out.push(imageBlock(raw, opts) as Block);
				break;
			default:
				break;
		}
	}
	return out;
}

function timestampOf(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const t = Date.parse(v);
		if (!Number.isNaN(t)) return t;
	}
	return Date.now();
}

function usageOf(u: unknown): Message["usage"] | undefined {
	if (!isRecord(u)) return undefined;
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	const cost = isRecord(u.cost) ? n(u.cost.total) : n(u.cost);
	return { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), costUsd: cost };
}

/** Developer-style text for omp's non-LLM roles (bash executions, summaries, custom messages). */
function syntheticText(raw: Record<string, unknown>): string | undefined {
	const role = raw.role;
	if (role === "bashExecution") {
		const cmd = typeof raw.command === "string" ? raw.command : "";
		const output = typeof raw.output === "string" ? raw.output : "";
		const code = typeof raw.exitCode === "number" ? ` (exit ${raw.exitCode})` : "";
		return `$ ${cmd}${code}${output ? `\n${output}` : ""}`;
	}
	if (role === "branchSummary" || role === "compactionSummary") {
		const label = role === "branchSummary" ? "Branch summary" : "Compaction summary";
		return typeof raw.summary === "string" ? `${label}:\n${raw.summary}` : label;
	}
	const c = raw.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const t = toolResultText(c);
		return t.length ? t : undefined;
	}
	return undefined;
}

/**
 * Returns null for messages that are not meant to be displayed (custom messages with `display:false`,
 * unknown roles without text).
 */
export function normalizeMessage(raw: unknown, opts: NormalizeOptions): Message | null {
	if (!isRecord(raw)) return null;
	const role = raw.role;
	const id = opts.id
		?? (typeof raw.id === "string" ? raw.id : undefined)
		?? (typeof raw.entryId === "string" ? raw.entryId : undefined)
		?? (typeof raw.messageId === "string" ? raw.messageId : undefined)
		?? `n_${Date.now().toString(36)}${(generated++).toString(36)}`;
	const timestamp = timestampOf(raw.timestamp);

	let msg: Message;
	if (role === "user") {
		msg = { id, role: "user", content: normalizeBlocks(raw.content, "user", opts), timestamp };
		if (raw.attribution === "agent" && !opts.from) msg.from = "agent";
	} else if (role === "assistant") {
		msg = { id, role: "assistant", content: normalizeBlocks(raw.content, "assistant", opts), timestamp };
		if (typeof raw.model === "string") msg.model = raw.model;
		if (typeof raw.stopReason === "string") msg.stopReason = raw.stopReason;
		if (typeof raw.errorMessage === "string") msg.errorMessage = truncateUtf8(raw.errorMessage, 4096).text;
		const usage = usageOf(raw.usage);
		if (usage) msg.usage = usage;
	} else if (role === "toolResult") {
		msg = { id, role: "toolResult", content: normalizeBlocks(raw.content, "toolResult", opts), timestamp };
		if (typeof raw.toolCallId === "string") msg.toolCallId = raw.toolCallId;
		if (typeof raw.toolName === "string") msg.toolName = raw.toolName;
		if (typeof raw.isError === "boolean") msg.isError = raw.isError;
	} else if (role === "developer") {
		msg = { id, role: "developer", content: normalizeBlocks(raw.content, "developer", opts), timestamp };
	} else {
		if (raw.display === false) return null;
		const text = syntheticText(raw);
		if (!text) return null;
		msg = { id, role: "developer", content: [textBlock(text, TEXT_BLOCK_LIMIT)], timestamp };
	}
	if (opts.from) msg.from = opts.from;
	return msg;
}

export function normalizeMessages(raws: unknown[], opts: NormalizeOptions): Message[] {
	const out: Message[] = [];
	for (const r of raws) {
		const m = normalizeMessage(r, { ...opts, id: undefined });
		if (m) out.push(m);
	}
	return out;
}
