/**
 * Contract between the bridge core (op dispatch, sessions registry) and the two session backends:
 *   - ManagedBackend (src/managed/)  : spawns `omp --mode rpc-ui`, speaks omp's RPC JSONL.
 *   - TuiBackend     (src/tui/)      : attaches to a live TUI as a collab guest (collab proto v3).
 * The dispatcher never knows which one it talks to; `summary().caps` tells the app what is allowed.
 */
import type {
	AttentionItem, Message, OpName, Ops, PromptArgs, SessionEvent, SessionSnapshot, SessionSummary, UiAnswer,
} from "../../protocol/src/index.ts";

/** An attachment the dispatcher has already resolved from an upload `ref`. */
export type ResolvedAttachment =
	| { kind: "image"; mimeType: string; dataBase64: string }
	| { kind: "file"; path: string; name: string };

/** Session-scoped ops a backend may implement. Anything missing → the dispatcher answers `unsupported`. */
export type SessionOpHandlers = {
	[K in Extract<
		OpName,
		| "session.queue.remove" | "session.queue.promote" | "session.btw" | "session.set" | "session.compact"
		| "session.goal" | "session.todos.set" | "subagent.cancel" | "subagent.steer"
		| "live.connect" | "live.stop" | "live.mute"
	>]?: (a: Ops[K]["a"]) => Promise<Ops[K]["d"]>;
};

export interface SessionBackend {
	readonly sid: string;
	readonly kind: "managed" | "tui";

	summary(): SessionSummary;
	snapshot(limit?: number): Promise<SessionSnapshot>;
	history(before: string | undefined, limit: number): Promise<{ messages: Message[]; hasMore: boolean }>;

	/** Live events. Index `n` is assigned by the dispatcher, not the backend. Returns an unsubscribe fn. */
	subscribe(listener: (e: SessionEvent) => void): () => void;

	prompt(a: PromptArgs, attachments: ResolvedAttachment[]): Promise<void>;
	abort(): Promise<{ restored?: { steering: string[]; followUp: string[] } }>;
	respondUi(reqId: string, answer: UiAnswer): Promise<void>;
	toolOutput(callId: string, off: number): Promise<{ text: string; next?: number }>;

	/** Optional: `sessions.rename`. Backends without it answer `unsupported`. */
	rename?(name: string): Promise<void>;
	/** Optional: `models.list {sid}`; the dispatcher falls back to any managed session or a probe process. */
	listModels?(): Promise<Ops["models.list"]["d"]["models"]>;
	/**
	 * Optional: `session.fork`. Leaves this session as it was and returns the persisted file of the new
	 * fork; the dispatcher opens that file as a new managed session.
	 */
	fork?(entryId?: string): Promise<{ sessionFile: string }>;
	/** Optional (tui): omp's own session id, used by `sessions.handover` to find the file and probe the lease. */
	ompSessionId?(): string | undefined;
	/** Optional session-scoped ops (see SessionOpHandlers). */
	readonly ops: SessionOpHandlers;

	/** Notified when an attention-worthy thing happens (approval/question/done/error/limit). */
	onAttention(listener: (item: Omit<AttentionItem, "id" | "ts" | "resolved">) => void): () => void;
	/** Fired when `summary()` may have changed (status, title, pendingUi, cost…). */
	onSummaryChanged(listener: () => void): () => void;
	/** Fired once when the backend ends (process exit, TUI gone, room closed). */
	onClosed(listener: (reason: string) => void): () => void;

	/** Stop the underlying process / leave the room. Idempotent. */
	close(): Promise<void>;
}

/** Image/blob store shared by backends. Implemented in src/normalize/blobs.ts (BridgeCore). */
export interface BlobStore {
	/** Registers raw bytes, returns an opaque `ref` (valid for the process lifetime, LRU-evicted). */
	put(bytes: Uint8Array, mimeType: string): string;
	get(ref: string): { bytes: Uint8Array; mimeType: string } | undefined;
}
