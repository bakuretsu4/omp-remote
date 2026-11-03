/**
 * Registry of live session backends (managed + tui). Assigns the per-session event index `n`, feeds the
 * attention inbox and the sleep inhibitor, and announces changes.
 */
import { EventEmitter } from "node:events";
import type { SessionEvent, SessionSummary } from "../../protocol/src/index.ts";
import type { SessionBackend } from "./backend.ts";
import type { AttentionInbox } from "./attention.ts";
import type { SleepInhibitor } from "./inhibit.ts";

interface Entry {
	backend: SessionBackend;
	/** Index of the last event emitted for this session. */
	seq: number;
	unsubs: (() => void)[];
	removed: boolean;
}

/** Events: `event(sid, seq, SessionEvent)`, `changed()`, `removed(sid)`. */
export class SessionRegistry extends EventEmitter {
	readonly #entries = new Map<string, Entry>();
	readonly #inbox: AttentionInbox;
	readonly #inhibitor: SleepInhibitor | undefined;
	readonly #log: (m: string) => void;
	#changedTimer: NodeJS.Timeout | undefined;

	constructor(o: { inbox: AttentionInbox; inhibitor?: SleepInhibitor; log: (m: string) => void }) {
		super();
		this.#inbox = o.inbox;
		this.#inhibitor = o.inhibitor;
		this.#log = o.log;
	}

	add(backend: SessionBackend): void {
		const existing = this.#entries.get(backend.sid);
		if (existing?.backend === backend) return;
		if (existing) this.remove(backend.sid);
		const sid = backend.sid;
		const entry: Entry = { backend, seq: 0, unsubs: [], removed: false };
		this.#entries.set(sid, entry);
		entry.unsubs.push(
			backend.subscribe(e => this.#onEvent(entry, e)),
			backend.onAttention(item => {
				this.#inbox.add(item);
			}),
			backend.onSummaryChanged(() => this.#changed()),
			backend.onClosed(() => this.remove(sid, entry)),
		);
		this.#changed();
	}

	/** Idempotent. When `only` is given, removes the entry only if it is that exact entry (late close callbacks). */
	remove(sid: string, only?: Entry): void {
		const entry = this.#entries.get(sid);
		if (!entry || entry.removed || (only && only !== entry)) return;
		entry.removed = true;
		this.#entries.delete(sid);
		for (const u of entry.unsubs) u();
		this.#inbox.resolveSession(sid);
		this.emit("removed", sid);
		this.#changed();
	}

	get(sid: string): SessionBackend | undefined {
		return this.#entries.get(sid)?.backend;
	}

	/** Index of the last event for `sid` (what `session.open` returns as `n`). */
	seq(sid: string): number {
		return this.#entries.get(sid)?.seq ?? 0;
	}

	backends(): SessionBackend[] {
		return [...this.#entries.values()].map(e => e.backend);
	}

	list(): SessionSummary[] {
		return this.backends().map(b => b.summary());
	}

	managedCount(): number {
		return this.backends().filter(b => b.kind === "managed").length;
	}

	/** Absolute session files of live sessions (excluded from the `recent` listing). */
	liveFiles(): Set<string> {
		const out = new Set<string>();
		for (const s of this.list()) if (s.sessionFile) out.add(s.sessionFile);
		return out;
	}

	async closeAll(): Promise<void> {
		await Promise.all(this.backends().filter(b => b.kind === "managed").map(b => b.close().catch(() => {})));
		for (const b of this.backends()) this.remove(b.sid);
		this.#inhibitor?.close();
		clearTimeout(this.#changedTimer);
	}

	#onEvent(entry: Entry, e: SessionEvent): void {
		const sid = entry.backend.sid;
		switch (e.k) {
			case "ui.end":
				this.#inbox.resolveSession(sid, ["approval", "question"], e.reqId);
				break;
			case "agent.start":
				this.#inbox.resolveSession(sid, ["done", "error", "limit"]);
				break;
			default:
				break;
		}
		const seq = ++entry.seq;
		this.emit("event", sid, seq, e);
		if (e.k === "agent.start" || e.k === "agent.end" || e.k === "ui.request" || e.k === "ui.end" || e.k === "compaction") this.#changed();
	}

	/** Sessions that are mid-turn or waiting on the phone keep the PC awake. */
	#updateInhibitor(): void {
		if (!this.#inhibitor) return;
		const busy = this.list().some(s => s.kind === "managed" && (s.status === "working" || s.status === "waiting"));
		this.#inhibitor.setBusy(busy);
	}

	#changed(): void {
		this.#updateInhibitor();
		if (this.#changedTimer) return;
		this.#changedTimer = setTimeout(() => {
			this.#changedTimer = undefined;
			this.emit("changed");
		}, 100);
		this.#changedTimer.unref();
	}
}
