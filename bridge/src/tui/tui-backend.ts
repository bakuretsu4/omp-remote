/**
 * TuiBackend — attaches to a live omp TUI as a collab guest (collab proto v3) and exposes it as a `kind:"tui"`
 * session. The host machine runs the agent; this backend only mirrors it and relays what a collab guest may do:
 * prompt, abort, answer host dialogs, chat with / kill subagents. `steer` is host-only and never advertised.
 *
 * Message identity: committed messages come from replicated `entry` frames (stable omp entry ids). A streaming
 * assistant message is emitted from `event` frames under a bridge-assigned live id; when the matching entry lands
 * the stored copy takes the entry id and the live id becomes an alias (so `history({before})` accepts either).
 */
import { basename } from "node:path";
import type {
	AttentionItem, Cap, Message, PromptArgs, SessionEvent, SessionSnapshot, SessionState, SessionStatus, SessionSummary,
	SubagentInfo, TodoPhase, UiAnswer, UiRequest,
} from "../../../protocol/src/index.ts";
import type { BlobStore, ResolvedAttachment, SessionBackend, SessionOpHandlers } from "../backend.ts";
import { OpError } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { normalizeMessage, shrinkArguments, toolOutput, toolResultText, truncateUtf8 } from "../normalize/message.ts";
import {
	CollabGuestClient, type CollabClientOptions, type LiveFrame, type SnapshotData,
} from "./collab-client.ts";
import type { ParsedCollabLink } from "./collab-link.ts";
import type { WireAgent, WireEntry, WireEvent, WireHeader, WireImage, WireState, WireUiRequest } from "./collab-wire.ts";
import {
	COLLAB_PROMPT_TYPE, entryToMessage, messageCost, modelRef, progressInfoOf, thinkingLevelOf, toSessionState, toSubagents,
	type AgentProgressInfo,
} from "./convert.ts";
import { AskDriver, describeUiRequest, planAnswer, toUiRequest } from "./ui-map.ts";

/** What `omp collab list --json` reports for a host; folded into summaries as live fallback data. */
export interface RegistryHost {
	instanceId: string;
	generation: number;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy: boolean | null;
	access: "view" | "control";
}

export interface TuiBackendOptions {
	sid: string;
	link: ParsedCollabLink;
	blobs: BlobStore;
	host?: RegistryHost;
	log?: (message: string) => void;
	/** Guest display name. Default `ompr-bridge`. */
	name?: string;
	/** Retained messages (oldest dropped). Default 2000. */
	maxMessages?: number;
	client?: Partial<Omit<CollabClientOptions, "link" | "name" | "log">>;
}

const WRITE_CAPS: Cap[] = ["prompt", "abort", "ui", "images", "files", "subagents", "stats"];
const READ_CAPS: Cap[] = ["stats"];

const STREAM_EMIT_MS = 125; // ≤8 `msg` events/second (PROTOCOL.md §6.3)
const TOOL_UPDATE_EMIT_MS = 150;
const SUBAGENT_EMIT_MS = 500;
const MAX_AWAITING_GHOSTS = 8;
const AWAITING_GHOST_TTL_MS = 15_000;
const MAX_RUNNING_TOOLS = 256;
const MAX_TOOL_OUTPUTS = 64;
const MAX_TOOL_OUTPUT_CHARS = 1024 * 1024;
const TOOL_OUTPUT_PAGE_BYTES = 256 * 1024;
const MAX_PROGRESS_ENTRIES = 128;
const MAX_ALIASES = 512;
const ASK_STEP_TIMEOUT_MS = 10_000;
const STALE_UI_GRACE_MS = 2_000;
const LIMIT_RE = /usage limit|rate.?limit|quota|insufficient (?:credit|funds)|credit balance|too many requests|\b429\b/i;

interface Ghost {
	liveId: string;
	entryId?: string;
	raw: Record<string, unknown>;
	lastEmit: number;
	dirty: boolean;
	timer?: NodeJS.Timeout;
	endedAt?: number;
	timestamp?: number;
}

interface PendingUi {
	wire: WireUiRequest;
	request: UiRequest;
	/** Consumed by an {@link AskDriver}: not shown to the phone. */
	hidden: boolean;
	stale: boolean;
}

interface RunningTool {
	callId: string;
	tool: string;
	args: unknown;
	intent?: string;
	startedAt: number;
	lastEmit: number;
	pendingOutput?: string;
	pendingTruncated?: boolean;
	timer?: NodeJS.Timeout;
}

interface ActiveDriver {
	driver: AskDriver;
	timer: NodeJS.Timeout | undefined;
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function textOfMessage(message: Message | undefined): string {
	if (!message) return "";
	return message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
}

export class TuiBackend implements SessionBackend {
	readonly sid: string;
	readonly kind = "tui" as const;
	get ops(): SessionOpHandlers {
		return this.#readOnly ? {} : this.#subagentOps;
	}

	readonly #blobs: BlobStore;
	readonly #log: (message: string) => void;
	readonly #maxMessages: number;
	readonly #client: CollabGuestClient;
	readonly #eventListeners = new Set<(e: SessionEvent) => void>();
	readonly #attentionListeners = new Set<(item: Omit<AttentionItem, "id" | "ts" | "resolved">) => void>();
	readonly #summaryListeners = new Set<() => void>();
	readonly #closedListeners = new Set<(reason: string) => void>();

	#host: RegistryHost | undefined;
	#header: WireHeader | undefined;
	#state: WireState | undefined;
	#lastStateJson = "";
	#agents: WireAgent[] = [];
	readonly #progress = new Map<string, AgentProgressInfo>();
	#messages: Message[] = [];
	readonly #aliases = new Map<string, string>();
	#costUsd = 0;
	#working = false;
	#compacting = false;
	#lastActivity = Date.now();
	#readOnly = true;
	#closed = false;
	#endedByHost = false;
	#ready = false;
	#readyWaiter: { resolve: () => void; reject: (err: Error) => void } | undefined;

	#liveSeq = 0;
	#ghost: Ghost | null = null;
	readonly #awaiting: Ghost[] = [];
	readonly #running = new Map<string, RunningTool>();
	readonly #toolOutputs = new Map<string, string>();
	readonly #pendingUi = new Map<number, PendingUi>();
	#driver: ActiveDriver | null = null;
	#staleTimer: NodeJS.Timeout | undefined;
	#summaryTimer: NodeJS.Timeout | undefined;
	#lastSummaryJson = "";
	#subagentTimer: NodeJS.Timeout | undefined;
	#lastAssistantText = "";

	private constructor(opts: TuiBackendOptions) {
		this.sid = opts.sid;
		this.#blobs = opts.blobs;
		this.#host = opts.host;
		this.#maxMessages = opts.maxMessages ?? 2000;
		this.#log = opts.log ?? (() => {});
		this.#client = new CollabGuestClient(
			{ ...opts.client, link: opts.link, name: opts.name, log: opts.log },
			{
				onSnapshot: (snapshot, resync) => this.#onSnapshot(snapshot, resync),
				onFrame: frame => this.#onFrame(frame),
				onClose: (reason, willReconnect) => this.#onClientClose(reason, willReconnect),
				onBye: reason => {
					this.#endedByHost = true;
					this.#shutdown(reason.length > 0 ? `host ended the session: ${reason}` : "host ended the session");
				},
			},
		);
	}

	/**
	 * Join the room and resolve once the welcome + snapshot are assembled.
	 * Rejects (and leaves the room) if the join fails or times out.
	 */
	static async attach(opts: TuiBackendOptions): Promise<TuiBackend> {
		const backend = new TuiBackend(opts);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		backend.#readyWaiter = { resolve, reject };
		backend.#client.connect();
		try {
			await promise;
		} catch (err) {
			await backend.close();
			throw err;
		}
		return backend;
	}

	// ───────────────────────────── discovery feed ─────────────────────────────

	/** Fold fresher registry data (`omp collab list`) into the summary. */
	updateHost(host: RegistryHost): void {
		if (this.#closed) return;
		const prev = this.#host;
		this.#host = host;
		if (this.#readOnly && host.inputRequired && !prev?.inputRequired && this.#pendingUi.size === 0) {
			this.#attention("question", "Waiting for input on the PC (this session is attached read-only)");
		}
		this.#summaryChanged();
	}

	/** True when the TUI host said goodbye (session switched or sharing stopped) as opposed to a transport failure. */
	get endedByHost(): boolean {
		return this.#endedByHost;
	}

	/** omp's own session id of the hosted conversation (registry value; the replicated header id as fallback). */
	ompSessionId(): string | undefined {
		return this.#host?.sessionId ?? this.#header?.id;
	}

	// ───────────────────────────── SessionBackend ─────────────────────────────

	summary(): SessionSummary {
		const state = this.#state;
		const host = this.#host;
		const cwd = state?.cwd ?? this.#header?.cwd ?? host?.cwd ?? "";
		const model = modelRef(state?.model) ?? (host?.model ? { provider: host.model.provider, id: host.model.id } : undefined);
		const summary: SessionSummary = {
			sid: this.sid,
			kind: "tui",
			title: this.#title(cwd),
			cwd,
			status: this.#status(),
			contextPercent: state?.contextUsage?.percent ?? null,
			costUsd: this.#costUsd,
			lastActivity: this.#lastActivity,
			pendingUi: this.#surfacedUi().length,
			caps: this.#readOnly ? [...READ_CAPS] : [...WRITE_CAPS],
		};
		if (model) summary.model = model;
		const thinking = thinkingLevelOf(state?.thinkingLevel);
		if (thinking) summary.thinkingLevel = thinking;
		if (host?.pid !== undefined) summary.pid = host.pid;
		return summary;
	}

	async snapshot(limit = 200): Promise<SessionSnapshot> {
		const live = this.#ghost ? this.#renderGhost(this.#ghost) : undefined;
		const all = live ? [...this.#messages, live] : this.#messages;
		const messages = limit > 0 ? all.slice(-limit) : [];
		return {
			summary: this.summary(),
			state: this.#sessionState(),
			messages,
			hasMore: all.length > messages.length,
			queue: { steering: [], followUp: [] },
			todos: [] satisfies TodoPhase[],
			goal: null,
			pendingUi: this.#surfacedUi(),
			subagents: this.#subagents(),
			runningTools: [...this.#running.values()].map(t => ({
				callId: t.callId, tool: t.tool, args: t.args, ...(t.intent ? { intent: t.intent } : {}), startedAt: t.startedAt,
			})),
		};
	}

	async history(before: string | undefined, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
		let end = this.#messages.length;
		if (before !== undefined) {
			const id = this.#aliases.get(before) ?? before;
			const idx = this.#messages.findIndex(m => m.id === id);
			if (idx < 0) throw new OpError("not_found", "unknown message id");
			end = idx;
		}
		const start = Math.max(0, end - Math.max(0, limit));
		return { messages: this.#messages.slice(start, end), hasMore: start > 0 };
	}

	subscribe(listener: (e: SessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	async prompt(a: PromptArgs, attachments: ResolvedAttachment[]): Promise<void> {
		this.#requireLive();
		let text = a.message;
		const images: WireImage[] = [];
		for (const att of attachments) {
			if (att.kind === "image") images.push({ type: "image", data: att.dataBase64, mimeType: att.mimeType });
			else text += `\n\n[Attached file: ${att.path}]`;
		}
		if (text.trim().length === 0 && images.length === 0) throw new OpError("invalid", "empty prompt");
		// A collab prompt that arrives while the agent runs is queued by the host as steering; there is no
		// follow-up/steer choice for guests, so `a.behavior` has no effect here.
		this.#client.sendPrompt(text, images);
		this.#lastActivity = Date.now();
	}

	async abort(): Promise<{ restored?: { steering: string[]; followUp: string[] } }> {
		this.#requireLive();
		this.#client.sendAbort();
		return {};
	}

	async respondUi(reqId: string, answer: UiAnswer): Promise<void> {
		this.#requireLive();
		const id = Number(reqId);
		const pending = Number.isInteger(id) ? this.#pendingUi.get(id) : undefined;
		if (!pending || pending.hidden) throw new OpError("not_found", "no such pending request (already answered?)");
		const action = planAnswer(pending.wire, answer);
		if (action.kind === "respond") {
			this.#client.sendUiResponse(id, action.value);
			return;
		}
		this.#startDriver(new AskDriver(action.plan), pending);
	}

	async toolOutput(callId: string, off: number): Promise<{ text: string; next?: number }> {
		const full = this.#toolOutputs.get(callId);
		if (full === undefined) throw new OpError("not_found", "no retained output for this tool call");
		const bytes = Buffer.from(full, "utf8");
		let start = Math.max(0, Math.min(off, bytes.byteLength));
		while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
		let end = Math.min(bytes.byteLength, start + TOOL_OUTPUT_PAGE_BYTES);
		while (end < bytes.byteLength && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
		const text = bytes.toString("utf8", start, end);
		return end < bytes.byteLength ? { text, next: end } : { text };
	}

	onAttention(listener: (item: Omit<AttentionItem, "id" | "ts" | "resolved">) => void): () => void {
		this.#attentionListeners.add(listener);
		return () => this.#attentionListeners.delete(listener);
	}

	onSummaryChanged(listener: () => void): () => void {
		this.#summaryListeners.add(listener);
		return () => this.#summaryListeners.delete(listener);
	}

	onClosed(listener: (reason: string) => void): () => void {
		this.#closedListeners.add(listener);
		return () => this.#closedListeners.delete(listener);
	}

	async close(): Promise<void> {
		this.#shutdown("closed by the bridge");
	}

	// ───────────────────────────── lifecycle ─────────────────────────────

	#shutdown(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#client.close();
		this.#clearTimers();
		this.#abortDriver(false);
		const waiter = this.#readyWaiter;
		this.#readyWaiter = undefined;
		waiter?.reject(new OpError("session_closed", reason));
		this.#pendingUi.clear();
		this.#emit({ k: "closed", reason });
		for (const l of [...this.#closedListeners]) this.#safe(() => l(reason));
		this.#eventListeners.clear();
		this.#summaryListeners.clear();
		this.#attentionListeners.clear();
		this.#closedListeners.clear();
	}

	#clearTimers(): void {
		clearTimeout(this.#summaryTimer);
		clearTimeout(this.#subagentTimer);
		clearTimeout(this.#staleTimer);
		for (const g of [this.#ghost, ...this.#awaiting]) clearTimeout(g?.timer);
		for (const t of this.#running.values()) clearTimeout(t.timer);
	}

	#onClientClose(reason: string, willReconnect: boolean): void {
		if (!willReconnect) {
			this.#shutdown(reason);
			return;
		}
		this.#log(`tui ${this.sid}: connection lost (${reason}); reconnecting`);
		this.#emit({ k: "notice", level: "warning", message: `Connection to the TUI session lost (${reason}); reconnecting…` });
		this.#summaryChanged();
	}

	// ───────────────────────────── snapshot / resync ─────────────────────────────

	#onSnapshot(snapshot: SnapshotData, resync: boolean): void {
		const previousIds = new Set(this.#messages.map(m => m.id));
		this.#header = snapshot.header;
		this.#state = snapshot.state;
		this.#lastStateJson = JSON.stringify(snapshot.state);
		this.#agents = snapshot.agents;
		this.#readOnly = snapshot.readOnly;
		this.#working = snapshot.state.isStreaming === true;
		this.#compacting = false;
		this.#resetLive();

		this.#messages = [];
		this.#aliases.clear();
		this.#costUsd = 0;
		for (const entry of snapshot.entries) this.#ingestEntry(entry, false);
		if (this.#messages.length > this.#maxMessages) this.#messages.splice(0, this.#messages.length - this.#maxMessages);
		const last = this.#messages.at(-1);
		const startedAt = Date.parse(snapshot.header.timestamp);
		this.#lastActivity = last?.timestamp ?? (Number.isNaN(startedAt) ? Date.now() : startedAt);
		this.#lastAssistantText = textOfMessage([...this.#messages].reverse().find(m => m.role === "assistant"));

		// Requests the host re-sends after a rejoin keep their ids; mark the old ones stale and sweep after a grace.
		for (const p of this.#pendingUi.values()) p.stale = true;
		clearTimeout(this.#staleTimer);
		this.#staleTimer = setTimeout(() => this.#sweepStaleUi(), STALE_UI_GRACE_MS);

		if (!this.#ready) {
			this.#ready = true;
			this.#readyWaiter?.resolve();
			this.#readyWaiter = undefined;
		} else if (resync) {
			this.#emit({ k: "notice", level: "info", message: "Reconnected to the TUI session" });
			this.#emit({ k: "state", state: this.#sessionState() });
			for (const m of this.#messages) if (!previousIds.has(m.id)) this.#emit({ k: "msg", message: m, final: true });
			this.#emit({ k: "subagents", subagents: this.#subagents() });
		}
		this.#summaryChanged();
	}

	/** Drop in-flight streaming bookkeeping that a fresh snapshot supersedes. */
	#resetLive(): void {
		for (const g of [this.#ghost, ...this.#awaiting]) clearTimeout(g?.timer);
		this.#ghost = null;
		this.#awaiting.length = 0;
		for (const t of this.#running.values()) clearTimeout(t.timer);
		this.#running.clear();
	}

	#sweepStaleUi(): void {
		for (const [id, p] of [...this.#pendingUi]) {
			if (!p.stale) continue;
			this.#pendingUi.delete(id);
			if (!p.hidden) this.#emit({ k: "ui.end", reqId: p.request.reqId });
		}
		this.#summaryChanged();
	}

	// ───────────────────────────── live frames ─────────────────────────────

	#onFrame(frame: LiveFrame): void {
		if (this.#closed) return;
		this.#lastActivity = Date.now();
		switch (frame.t) {
			case "entry":
				this.#ingestEntry(frame.entry, true);
				break;
			case "event":
				if (isRecord(frame.event)) this.#onEvent(frame.event);
				break;
			case "state":
				this.#onState(frame.state);
				break;
			case "agents":
				this.#agents = Array.isArray(frame.agents) ? frame.agents : [];
				this.#scheduleSubagents();
				break;
			case "bus":
				this.#onBus(frame.channel, frame.data);
				break;
			case "ui-request":
				this.#onUiRequest(frame.request);
				break;
			case "ui-request-end":
				this.#onUiEnd(frame.reqId);
				break;
			case "error":
				this.#emit({ k: "notice", level: "error", message: clip(String(frame.message ?? "host error"), 500) });
				break;
		}
	}

	#onState(state: WireState): void {
		this.#state = state;
		const streaming = state.isStreaming === true;
		if (streaming) this.#working = true;
		else if (this.#running.size === 0 && !this.#ghost) this.#working = false;
		const json = JSON.stringify(state);
		if (json !== this.#lastStateJson) {
			this.#lastStateJson = json;
			this.#emit({ k: "state", state: this.#sessionState() });
		}
		this.#summaryChanged();
	}

	#onBus(channel: string, data: unknown): void {
		if (channel !== "task:subagent:progress") return;
		const parsed = progressInfoOf(data);
		if (!parsed) return;
		this.#progress.delete(parsed.id);
		this.#progress.set(parsed.id, parsed.info);
		while (this.#progress.size > MAX_PROGRESS_ENTRIES) this.#progress.delete(this.#progress.keys().next().value as string);
		this.#scheduleSubagents();
	}

	#scheduleSubagents(): void {
		if (this.#subagentTimer) return;
		this.#subagentTimer = setTimeout(() => {
			this.#subagentTimer = undefined;
			this.#emit({ k: "subagents", subagents: this.#subagents() });
		}, SUBAGENT_EMIT_MS);
		this.#subagentTimer.unref();
	}

	// ───────────────────────────── entries ─────────────────────────────

	#ingestEntry(entry: WireEntry, live: boolean): void {
		if (!isRecord(entry) || typeof entry.id !== "string") return;
		if (live && this.#messages.some(m => m.id === entry.id)) return;
		const message = entryToMessage(entry, this.#blobs);
		if (entry.type === "message" && isRecord(entry.message)) this.#costUsd += messageCost(entry.message);
		if (!message) return;
		if (message.role === "toolResult" && message.toolCallId && !this.#toolOutputs.has(message.toolCallId)) {
			if (isRecord(entry.message)) this.#retainToolOutput(message.toolCallId, toolResultText(entry.message.content));
		}
		if (!live) {
			this.#messages.push(message);
			return;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error" && message.errorMessage) this.#attention(LIMIT_RE.test(message.errorMessage) ? "limit" : "error", clip(message.errorMessage, 140));
			const text = textOfMessage(message);
			if (text) this.#lastAssistantText = text;
			if (this.#adoptEntryForGhost(entry, message)) {
				this.#trimMessages();
				this.#summaryChanged();
				return;
			}
		}
		this.#messages.push(message);
		this.#trimMessages();
		this.#emit({ k: "msg", message, final: true });
		this.#summaryChanged();
	}

	/** An assistant entry that belongs to a streamed ghost completes it instead of announcing a new message. */
	#adoptEntryForGhost(entry: WireEntry, message: Message): boolean {
		const ts = isRecord(entry.message) && typeof entry.message.timestamp === "number" ? entry.message.timestamp : undefined;
		const now = Date.now();
		for (let i = this.#awaiting.length - 1; i >= 0; i--) {
			if (now - (this.#awaiting[i]!.endedAt ?? now) > AWAITING_GHOST_TTL_MS) this.#awaiting.splice(i, 1);
		}
		const matches = (g: Ghost): boolean => ts === undefined || g.timestamp === undefined || g.timestamp === ts;
		const idx = this.#awaiting.findIndex(matches);
		if (idx >= 0) {
			const [ghost] = this.#awaiting.splice(idx, 1);
			const at = this.#messages.findIndex(m => m.id === ghost!.liveId);
			if (at >= 0) this.#messages[at] = message;
			else this.#messages.push(message);
			this.#alias(ghost!.liveId, entry.id);
			return true;
		}
		const ghost = this.#ghost;
		if (ghost && ghost.entryId === undefined && (ts === undefined || ghost.timestamp === undefined || ghost.timestamp === ts)) {
			// Entry-first ordering: the entry lands before `message_end`; the end event will find `entryId` set.
			ghost.entryId = entry.id;
			this.#messages.push(message);
			this.#alias(ghost.liveId, entry.id);
			return true;
		}
		return false;
	}

	#alias(liveId: string, entryId: string): void {
		this.#aliases.set(liveId, entryId);
		while (this.#aliases.size > MAX_ALIASES) this.#aliases.delete(this.#aliases.keys().next().value as string);
	}

	#trimMessages(): void {
		if (this.#messages.length > this.#maxMessages) this.#messages.splice(0, this.#messages.length - this.#maxMessages);
	}

	// ───────────────────────────── events ─────────────────────────────

	#onEvent(event: WireEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#working = true;
				this.#emit({ k: "agent.start" });
				this.#summaryChanged();
				return;
			case "agent_end": {
				this.#working = false;
				this.#flushGhostAsFinal();
				this.#running.clear();
				const terminal = event.isTerminal !== false;
				const yielded = typeof event.yielded === "boolean" ? event.yielded : terminal;
				const settled = terminal && event.awaitingAsyncWork !== true;
				this.#emit({ k: "agent.end", yielded, settled });
				if (yielded) this.#attention("done", clip(this.#lastAssistantText || "Finished", 140));
				this.#summaryChanged();
				return;
			}
			case "message_start":
			case "message_update":
				if (isRecord(event.message) && event.message.role === "assistant") this.#ghostUpdate(event.message, event.type === "message_start");
				return;
			case "message_end":
				if (isRecord(event.message) && event.message.role === "assistant") this.#ghostEnd(event.message);
				return;
			case "tool_execution_start":
				this.#toolStart(event);
				return;
			case "tool_execution_update":
				this.#toolUpdate(event);
				return;
			case "tool_execution_end":
				this.#toolEnd(event);
				return;
			case "notice": {
				const level = event.level === "warning" || event.level === "error" ? event.level : "info";
				if (typeof event.message === "string") this.#emit({ k: "notice", level, message: clip(event.message, 500) });
				return;
			}
			case "auto_compaction_start":
				this.#compacting = true;
				this.#emit({ k: "compaction", phase: "start", auto: true });
				this.#summaryChanged();
				return;
			case "auto_compaction_end": {
				this.#compacting = false;
				if (event.skipped === true) return;
				const error = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
				this.#emit({
					k: "compaction", phase: "end", auto: true, ok: event.aborted !== true && error === undefined,
					...(error ? { message: clip(error, 300) } : {}),
				});
				this.#summaryChanged();
				return;
			}
			case "auto_retry_start":
				this.#emit({
					k: "notice", level: "warning",
					message: `Retrying (${String(event.attempt)}/${String(event.maxAttempts)}): ${clip(String(event.errorMessage ?? ""), 300)}`,
				});
				return;
			case "auto_retry_end":
				if (event.success === false) this.#emit({ k: "notice", level: "error", message: `Retry failed: ${clip(String(event.finalError ?? "unknown error"), 300)}` });
				return;
			default:
				return; // turn_start/turn_end/thinking_level_changed and unknown events
		}
	}

	// ── streaming assistant ghost ──

	#ghostUpdate(raw: Record<string, unknown>, isStart: boolean): void {
		if (isStart && this.#ghost) this.#flushGhostAsFinal();
		let ghost = this.#ghost;
		if (!ghost) {
			ghost = {
				liveId: `l_${(this.#liveSeq++).toString(36)}`,
				raw,
				lastEmit: 0,
				dirty: false,
				timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
			};
			this.#ghost = ghost;
		}
		ghost.raw = raw;
		ghost.dirty = true;
		const wait = ghost.lastEmit + STREAM_EMIT_MS - Date.now();
		if (wait <= 0) {
			this.#emitGhost(ghost, false);
		} else if (!ghost.timer) {
			ghost.timer = setTimeout(() => {
				ghost.timer = undefined;
				if (ghost.dirty && !this.#closed) this.#emitGhost(ghost, false);
			}, wait);
			ghost.timer.unref();
		}
	}

	#renderGhost(ghost: Ghost): Message | undefined {
		return normalizeMessage(ghost.raw, { blobs: this.#blobs, id: ghost.liveId }) ?? undefined;
	}

	#emitGhost(ghost: Ghost, final: boolean): void {
		clearTimeout(ghost.timer);
		ghost.timer = undefined;
		ghost.dirty = false;
		ghost.lastEmit = Date.now();
		const message = this.#renderGhost(ghost);
		if (message) this.#emit({ k: "msg", message, final });
	}

	#ghostEnd(raw: Record<string, unknown>): void {
		let ghost = this.#ghost;
		if (!ghost) {
			ghost = { liveId: `l_${(this.#liveSeq++).toString(36)}`, raw, lastEmit: 0, dirty: true, timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined };
		}
		ghost.raw = raw;
		this.#ghost = null;
		this.#finishGhost(ghost);
	}

	#flushGhostAsFinal(): void {
		const ghost = this.#ghost;
		if (!ghost) return;
		this.#ghost = null;
		this.#finishGhost(ghost);
	}

	/** Emit the final copy and park the ghost until its entry arrives (unless it already did). */
	#finishGhost(ghost: Ghost): void {
		this.#emitGhost(ghost, true);
		ghost.endedAt = Date.now();
		if (ghost.entryId !== undefined) return; // the stored copy already carries the entry id
		const message = this.#renderGhost(ghost);
		if (message) {
			this.#messages.push(message);
			this.#trimMessages();
			const text = textOfMessage(message);
			if (text) this.#lastAssistantText = text;
		}
		this.#awaiting.push(ghost);
		while (this.#awaiting.length > MAX_AWAITING_GHOSTS) this.#awaiting.shift();
	}

	// ── tools ──

	#toolStart(event: WireEvent): void {
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		const tool = typeof event.toolName === "string" ? event.toolName : undefined;
		if (!callId || !tool) return;
		const intent = typeof event.intent === "string" ? event.intent : undefined;
		const args = shrinkArguments(event.args);
		this.#running.set(callId, { callId, tool, args, intent, startedAt: Date.now(), lastEmit: 0 });
		while (this.#running.size > MAX_RUNNING_TOOLS) {
			const oldest = this.#running.keys().next().value as string;
			clearTimeout(this.#running.get(oldest)?.timer);
			this.#running.delete(oldest);
		}
		this.#emit({ k: "tool.start", callId, tool, args, ...(intent ? { intent } : {}) });
		this.#summaryChanged();
	}

	#toolUpdate(event: WireEvent): void {
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		const running = callId ? this.#running.get(callId) : undefined;
		if (!callId || !running) return;
		const out = toolOutput(event.partialResult);
		running.pendingOutput = out.text;
		running.pendingTruncated = out.truncated;
		const emit = (): void => {
			running.timer = undefined;
			if (running.pendingOutput === undefined || this.#closed) return;
			const text = running.pendingOutput;
			const truncated = running.pendingTruncated === true;
			running.pendingOutput = undefined;
			running.lastEmit = Date.now();
			this.#emit({ k: "tool.update", callId, output: text, ...(truncated ? { truncated: true } : {}) });
		};
		const wait = running.lastEmit + TOOL_UPDATE_EMIT_MS - Date.now();
		if (wait <= 0) emit();
		else if (!running.timer) {
			running.timer = setTimeout(emit, wait);
			running.timer.unref();
		}
	}

	#toolEnd(event: WireEvent): void {
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (!callId) return;
		const running = this.#running.get(callId);
		clearTimeout(running?.timer);
		this.#running.delete(callId);
		const result = event.result;
		const full = isRecord(result) ? toolResultText(result.content) : toolResultText(result);
		this.#retainToolOutput(callId, full);
		const out = truncateUtf8(full);
		this.#emit({
			k: "tool.end", callId, output: out.text, isError: event.isError === true,
			...(out.truncated ? { truncated: true } : {}),
		});
		this.#summaryChanged();
	}

	#retainToolOutput(callId: string, text: string): void {
		this.#toolOutputs.delete(callId);
		this.#toolOutputs.set(callId, text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) : text);
		while (this.#toolOutputs.size > MAX_TOOL_OUTPUTS) this.#toolOutputs.delete(this.#toolOutputs.keys().next().value as string);
	}

	// ───────────────────────────── host dialogs ─────────────────────────────

	#onUiRequest(wire: WireUiRequest): void {
		if (!isRecord(wire) || typeof wire.reqId !== "number") return;
		const existing = this.#pendingUi.get(wire.reqId);
		if (existing) {
			existing.stale = false; // replayed after a rejoin
			return;
		}
		const driver = this.#driver;
		if (driver) {
			const step = driver.driver.step(wire);
			if (step) {
				this.#pendingUi.set(wire.reqId, { wire, request: toUiRequest(wire, Date.now()), hidden: true, stale: false });
				try {
					this.#client.sendUiResponse(wire.reqId, step.value);
				} catch (err) {
					this.#log(`tui ${this.sid}: could not continue the ask answer: ${err instanceof Error ? err.message : String(err)}`);
					this.#abortDriver(true);
					return;
				}
				if (step.finished) this.#clearDriver();
				else this.#armDriverTimer(driver);
				return;
			}
		}
		const request = toUiRequest(wire, Date.now());
		this.#pendingUi.set(wire.reqId, { wire, request, hidden: false, stale: false });
		this.#emit({ k: "ui.request", request });
		this.#attention(request.kind === "approval" ? "approval" : "question", clip(describeUiRequest(request), 140), request.reqId);
		this.#summaryChanged();
	}

	#onUiEnd(reqId: number): void {
		const pending = this.#pendingUi.get(reqId);
		if (!pending) return;
		this.#pendingUi.delete(reqId);
		if (!pending.hidden) this.#emit({ k: "ui.end", reqId: pending.request.reqId });
		this.#summaryChanged();
	}

	#startDriver(driver: AskDriver, first: PendingUi): void {
		this.#abortDriver(true);
		const step = driver.step(first.wire);
		if (!step) throw new OpError("invalid", "answer does not match the pending question");
		this.#client.sendUiResponse(first.wire.reqId, step.value);
		if (!step.finished) {
			const active: ActiveDriver = { driver, timer: undefined };
			this.#driver = active;
			this.#armDriverTimer(active);
		}
	}

	#armDriverTimer(active: ActiveDriver): void {
		clearTimeout(active.timer);
		active.timer = setTimeout(() => {
			if (this.#driver !== active) return;
			this.#log(`tui ${this.sid}: ask answer did not complete; surfacing the pending question again`);
			this.#abortDriver(true);
		}, ASK_STEP_TIMEOUT_MS);
		active.timer.unref();
	}

	#clearDriver(): void {
		clearTimeout(this.#driver?.timer);
		this.#driver = null;
	}

	/** Stop replaying an ask answer; re-surface any step the host is still waiting on. */
	#abortDriver(resurface: boolean): void {
		if (!this.#driver) return;
		this.#clearDriver();
		if (!resurface || this.#closed) return;
		let surfaced = false;
		for (const p of this.#pendingUi.values()) {
			if (!p.hidden) continue;
			p.hidden = false;
			surfaced = true;
			this.#emit({ k: "ui.request", request: p.request });
		}
		if (surfaced) {
			this.#emit({ k: "notice", level: "warning", message: "The multi-step answer did not complete; answer the remaining question again." });
			this.#summaryChanged();
		}
	}

	#surfacedUi(): UiRequest[] {
		return [...this.#pendingUi.values()].filter(p => !p.hidden && !p.stale).map(p => p.request);
	}

	// ───────────────────────────── subagents ─────────────────────────────

	readonly #subagentOps: SessionOpHandlers = {
		"subagent.cancel": async a => {
			this.#requireAgent(a.id);
			this.#client.sendAgentCmd("kill", a.id);
			return {};
		},
		"subagent.steer": async a => {
			this.#requireAgent(a.id);
			if (a.message.trim().length === 0) throw new OpError("invalid", "empty message");
			this.#client.sendAgentCmd("chat", a.id, a.message);
			return {};
		},
	};

	#requireAgent(id: string): void {
		this.#requireLive();
		if (!this.#agents.some(a => a.id === id)) throw new OpError("not_found", "no such subagent");
	}

	#subagents(): SubagentInfo[] {
		return toSubagents(this.#agents, this.#progress);
	}

	// ───────────────────────────── summary helpers ─────────────────────────────

	#requireLive(): void {
		if (this.#closed) throw new OpError("session_closed", "the TUI session is no longer attached");
		if (this.#readOnly) throw new OpError("readonly", "this TUI session is attached read-only");
		if (!this.#client.live) throw new OpError("session_closed", "reconnecting to the TUI session; try again in a moment");
	}

	#title(cwd: string): string {
		return (
			this.#state?.sessionName ??
			this.#header?.title ??
			this.#host?.sessionName ??
			(cwd ? basename(cwd) : undefined) ??
			"TUI session"
		) || "TUI session";
	}

	#status(): SessionStatus {
		if (this.#closed) return "offline";
		const live = this.#client.live;
		const waiting = this.#surfacedUi().length > 0 || ((this.#readOnly || !live) && this.#host?.inputRequired === true);
		if (waiting) return "waiting";
		const working = live ? this.#working : this.#working || this.#host?.busy === true;
		return working ? "working" : "idle";
	}

	#sessionState(): SessionState {
		const base = this.#state ?? { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] };
		const state = toSessionState(base, { isCompacting: this.#compacting, costUsd: this.#costUsd });
		state.isStreaming = this.#working;
		return state;
	}

	/** Coalesced `onSummaryChanged` (status, title, model, context, pendingUi). */
	#summaryChanged(): void {
		if (this.#closed || this.#summaryTimer) return;
		this.#summaryTimer = setTimeout(() => {
			this.#summaryTimer = undefined;
			if (this.#closed) return;
			const { lastActivity: _ignored, ...rest } = this.summary();
			const json = JSON.stringify(rest);
			if (json === this.#lastSummaryJson) return;
			this.#lastSummaryJson = json;
			for (const l of [...this.#summaryListeners]) this.#safe(l);
		}, 50);
		this.#summaryTimer.unref();
	}

	#attention(kind: AttentionItem["kind"], summary: string, uiReqId?: string): void {
		const item: Omit<AttentionItem, "id" | "ts" | "resolved"> = {
			sid: this.sid,
			sessionTitle: this.summary().title,
			kind,
			summary,
			...(uiReqId ? { uiReqId } : {}),
		};
		for (const l of [...this.#attentionListeners]) this.#safe(() => l(item));
	}

	#emit(event: SessionEvent): void {
		for (const l of [...this.#eventListeners]) this.#safe(() => l(event));
	}

	#safe(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.#log(`tui ${this.sid}: listener threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
