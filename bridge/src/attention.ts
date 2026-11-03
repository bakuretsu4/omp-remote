/** Attention inbox (PROTOCOL.md §6.4): last 200 items, persisted to attention.json (0600). */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { AttentionItem, AttentionKind } from "../../protocol/src/index.ts";
import { isRecord } from "./guards.ts";
import { paths } from "./config.ts";
import { readJsonIfExists, writePrivateFile } from "./safefs.ts";

export const INBOX_LIMIT = 200;
const SAVE_DEBOUNCE_MS = 500;
const ERROR_DEDUPE_MS = 60_000;

export type NewAttention = Omit<AttentionItem, "id" | "ts" | "resolved">;

const KINDS: readonly AttentionKind[] = ["approval", "question", "done", "error", "limit"];

function parseItem(raw: unknown): AttentionItem | null {
	if (!isRecord(raw)) return null;
	const { id, ts, sid, sessionTitle, kind, summary, resolved } = raw;
	if (typeof id !== "string" || typeof ts !== "number" || typeof sid !== "string" || typeof sessionTitle !== "string") return null;
	if (typeof summary !== "string" || typeof resolved !== "boolean" || !KINDS.includes(kind as AttentionKind)) return null;
	const item: AttentionItem = { id, ts, sid, sessionTitle, kind: kind as AttentionKind, summary, resolved };
	if (typeof raw.uiReqId === "string") item.uiReqId = raw.uiReqId;
	return item;
}

/** Events: `item(AttentionItem)` when created, `resolved(AttentionItem)` when resolved. */
export class AttentionInbox extends EventEmitter {
	readonly #file: string | undefined;
	#items: AttentionItem[] = [];
	#lastTs = 0;
	#timer: NodeJS.Timeout | undefined;
	readonly #now: () => number;

	/** `dir` undefined → memory only (tests). */
	constructor(dir?: string, now: () => number = Date.now) {
		super();
		this.#now = now;
		if (!dir) return;
		this.#file = paths(dir).attention;
		const raw = readJsonIfExists(this.#file);
		if (isRecord(raw) && Array.isArray(raw.items)) {
			for (const r of raw.items) {
				const it = parseItem(r);
				if (it) this.#items.push(it);
			}
			this.#items = this.#items.slice(-INBOX_LIMIT);
			this.#lastTs = this.#items.reduce((m, i) => Math.max(m, i.ts), 0);
		}
	}

	/**
	 * Rules: approvals and questions always create an item. A new `done`/`error`/`limit` item supersedes older
	 * unresolved ones of the same kind for that session, and identical errors within a minute collapse.
	 */
	add(n: NewAttention): AttentionItem | null {
		const now = this.#now();
		if (n.kind === "error" || n.kind === "limit") {
			const dup = this.#items.find(i => !i.resolved && i.sid === n.sid && i.kind === n.kind && i.summary === n.summary && now - i.ts < ERROR_DEDUPE_MS);
			if (dup) return null;
		}
		if (n.kind === "done" || n.kind === "error" || n.kind === "limit") {
			for (const i of this.#items) if (!i.resolved && i.sid === n.sid && i.kind === n.kind) this.#resolve(i);
		}
		const ts = Math.max(now, this.#lastTs + 1);
		this.#lastTs = ts;
		const item: AttentionItem = { id: `a_${randomBytes(6).toString("hex")}`, ts, resolved: false, ...n };
		this.#items.push(item);
		if (this.#items.length > INBOX_LIMIT) this.#items.splice(0, this.#items.length - INBOX_LIMIT);
		this.#saveSoon();
		this.emit("item", item);
		return item;
	}

	list(since = 0): AttentionItem[] {
		return this.#items.filter(i => i.ts > since);
	}

	get(id: string): AttentionItem | undefined {
		return this.#items.find(i => i.id === id);
	}

	resolve(id: string): boolean {
		const it = this.get(id);
		return it ? this.#resolve(it) : false;
	}

	/** Resolves unresolved items of `sid` matching `kinds` (all kinds when omitted); `uiReqId` narrows further. */
	resolveSession(sid: string, kinds?: readonly AttentionKind[], uiReqId?: string): number {
		let n = 0;
		for (const i of this.#items) {
			if (i.resolved || i.sid !== sid) continue;
			if (kinds && !kinds.includes(i.kind)) continue;
			if (uiReqId !== undefined && i.uiReqId !== uiReqId) continue;
			if (this.#resolve(i)) n++;
		}
		return n;
	}

	#resolve(it: AttentionItem): boolean {
		if (it.resolved) return false;
		it.resolved = true;
		this.#saveSoon();
		this.emit("resolved", it);
		return true;
	}

	flush(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#save();
	}

	#saveSoon(): void {
		if (!this.#file || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#save();
		}, SAVE_DEBOUNCE_MS);
		this.#timer.unref();
	}

	#save(): void {
		if (!this.#file) return;
		writePrivateFile(this.#file, `${JSON.stringify({ v: 1, items: this.#items })}\n`);
	}
}
