/**
 * ManagedBackend: one `omp --mode rpc-ui` child process per session (PROTOCOL.md §6.1).
 * Translates omp RPC frames to normalized `SessionEvent`s and protocol ops to RPC commands.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type {
	ApprovalMode, Cap, GoalState, Message, ModelRef, Ops, PromptArgs, QueueState, SessionEvent, SessionSnapshot,
	SessionState, SessionStatus, SessionSummary, SubagentInfo, ThinkingLevel, TodoPhase, UiAnswer, UiRequest,
} from "../../../protocol/src/index.ts";
import type {
	BlobStore, ResolvedAttachment, SessionBackend, SessionOpHandlers,
} from "../backend.ts";
import { OpError, busy, invalid, sessionClosed } from "../errors.ts";
import { isRecord } from "../guards.ts";
import type { HostToolHost } from "../hosttools.ts";
import { normalizeMessage, shrinkArguments, toolOutput, truncateUtf8 } from "../normalize/message.ts";
import { normalizeUiRequest, uiAnswerToResponse } from "../normalize/ui.ts";
import {
	activeBranch, clip, mapGoal, mapModel, mapModelListing, mapSubagent, mapThinking, mapTodos,
} from "./mappers.ts";
import { OmpProcess, RpcError } from "./rpc.ts";

export interface ManagedOptions {
	sid: string;
	cwd: string;
	ompBin: string;
	approvalMode: ApprovalMode;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	/** Persisted session file to resume (`--resume`). */
	resumeFile?: string;
	/** `--session-dir` for every spawn. */
	sessionDir?: string;
	extraArgs?: string[];
	blobs: BlobStore;
	log: (m: string) => void;
	/** Register `phone_*` tools when set. */
	hostTools?: HostToolHost;
	env?: NodeJS.ProcessEnv;
	/** Test seam for the child process. */
	spawn?: ConstructorParameters<typeof OmpProcess>[0]["spawn"];
}

const COALESCE_MS = 125;
const TOOL_UPDATE_MS = 250;
const TOOL_OUTPUT_KEEP = 256 * 1024;
const TOOL_PAGE = 64 * 1024;
const TRANSCRIPT_MAX = 4000;
const LIMIT_RE = /usage limit|rate.?limit|quota|limit reached|too many requests|\b429\b|credit balance|out of credits/i;

const MANAGED_CAPS: Cap[] = [
	"prompt", "steer", "abort", "queue", "ui", "images", "files", "model", "thinking", "fast", "compact", "goal",
	"todos", "fork", "subagents", "voice", "approvalMode", "btw",
];

type Listener<T> = (v: T) => void;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

/** Resolves persisted `blob:sha256:<hex>` image references from omp's content-addressed blob dir. */
function resolveOmpBlob(ref: string, mimeType: string): { bytes: Uint8Array; mimeType: string } | undefined {
	const m = /^blob:sha256:([0-9a-f]{64})$/.exec(ref);
	if (!m) return undefined;
	try {
		return { bytes: readFileSync(join(agentDir(), "blobs", m[1]!)), mimeType };
	} catch {
		return undefined;
	}
}

interface StreamEntry {
	raw: unknown;
	lastEmit: number;
	timer?: NodeJS.Timeout;
}

interface ToolRun { callId: string; tool: string; args: unknown; intent?: string; startedAt: number }

export class ManagedBackend implements SessionBackend {
	readonly sid: string;
	readonly kind = "managed" as const;
	readonly ops: SessionOpHandlers;

	readonly #o: ManagedOptions;
	#proc!: OmpProcess;
	#approvalMode: ApprovalMode;

	#transcript: Message[] = [];
	#transcriptTruncated = false;
	readonly #stream = new Map<string, StreamEntry>();
	readonly #running = new Map<string, ToolRun>();
	readonly #toolOut = new Map<string, Buffer>();
	readonly #toolUpdateAt = new Map<string, number>();
	readonly #pendingUi = new Map<string, UiRequest>();
	readonly #subagents = new Map<string, SubagentInfo>();
	readonly #btwRecords = new Map<string, Record<string, unknown>>();
	readonly #btwWaiters = new Map<string, (r: Record<string, unknown>) => void>();

	#queue: QueueState = { steering: [], followUp: [] };
	#todos: TodoPhase[] = [];
	#goal: GoalState | null = null;
	#state: SessionState = { isStreaming: false, isCompacting: false };
	#stateJson = "";
	#sessionFile: string | undefined;
	#sessionName: string | undefined;
	#firstUserText: string | undefined;
	#costUsd = 0;
	#lastActivity = Date.now();
	#usageStage: string | undefined;

	#turnActive = false;
	#compacting = false;
	#abortRequested = false;
	#errorReported = false;
	#lastAssistantText = "";
	#closing = false;
	#restarting = false;
	#closed = false;

	readonly #evListeners = new Set<Listener<SessionEvent>>();
	readonly #attListeners = new Set<Listener<Parameters<Parameters<SessionBackend["onAttention"]>[0]>[0]>>();
	readonly #sumListeners = new Set<() => void>();
	readonly #closeListeners = new Set<Listener<string>>();
	#sumPending = false;
	#stateTimer: NodeJS.Timeout | undefined;
	#subTimer: NodeJS.Timeout | undefined;
	#unsubHostTools: (() => void) | undefined;

	private constructor(o: ManagedOptions) {
		this.#o = o;
		this.sid = o.sid;
		this.#approvalMode = o.approvalMode;
		this.ops = this.#buildOps();
	}

	/** Spawns omp, negotiates the protocol and loads the transcript. Throws `OpError` on failure. */
	static async launch(o: ManagedOptions): Promise<ManagedBackend> {
		const b = new ManagedBackend(o);
		try {
			await b.#spawn(o.resumeFile, true);
		} catch (e) {
			await b.#proc?.shutdown(500).catch(() => {});
			throw e instanceof OpError ? e : new OpError("internal", `could not start omp: ${(e as Error).message}`);
		}
		return b;
	}

	// ───────────────────────────── process lifecycle ─────────────────────────────

	#args(resumeFile: string | undefined): string[] {
		const a = ["--mode", "rpc-ui", "--approval-mode", this.#approvalMode];
		if (this.#o.model) a.push("--model", `${this.#o.model.provider}/${this.#o.model.id}`);
		if (this.#o.thinkingLevel) a.push("--thinking", this.#o.thinkingLevel);
		if (resumeFile) a.push("--resume", resumeFile);
		if (this.#o.sessionDir) a.push("--session-dir", this.#o.sessionDir);
		if (this.#o.extraArgs) a.push(...this.#o.extraArgs);
		return a;
	}

	async #spawn(resumeFile: string | undefined, firstStart: boolean): Promise<void> {
		const proc = new OmpProcess({ bin: this.#o.ompBin, args: this.#args(resumeFile), cwd: this.#o.cwd, env: this.#o.env, spawn: this.#o.spawn });
		this.#proc = proc;
		proc.on("frame", f => {
			try {
				this.#onFrame(f);
			} catch (e) {
				this.#o.log(`[${this.sid}] frame handler error: ${(e as Error).message}`);
			}
		});
		proc.on("protocol-error", (e: Error) => this.#o.log(`[${this.sid}] rpc protocol error: ${e.message}`));
		proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => this.#onExit(proc, code, signal));
		const ready = await proc.start();
		const versions = Array.isArray(ready.supportedProtocolVersions) ? ready.supportedProtocolVersions : [];
		if (versions.includes(2)) await proc.request("negotiate_protocol", { protocolVersion: 2 });
		try {
			await proc.request("set_ask_dialog", { enabled: true });
		} catch (e) {
			this.#o.log(`[${this.sid}] set_ask_dialog unavailable: ${(e as Error).message}`);
		}
		try {
			await proc.request("set_subagent_subscription", { level: "progress" });
		} catch (e) {
			this.#o.log(`[${this.sid}] set_subagent_subscription unavailable: ${(e as Error).message}`);
		}
		// Drop high-volume events nobody here consumes; keep everything else (unknown names are forwarded).
		try {
			await proc.request("set_event_filter", {
				events: [
					"agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
					"tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_compaction_start", "auto_compaction_end",
					"manual_compaction_start", "manual_compaction_end", "auto_retry_start", "auto_retry_end", "retry_fallback_applied",
					"retry_fallback_succeeded", "model_changed", "thinking_level_changed", "goal_updated", "queue_update", "notice",
					"todo_auto_clear", "irc_message",
				],
			});
		} catch (e) {
			this.#o.log(`[${this.sid}] set_event_filter unavailable: ${(e as Error).message}`);
		}
		await this.#refreshState();
		if (firstStart) {
			if (this.#sessionFile && existsSync(this.#sessionFile) && resumeFile) await this.#loadTranscript();
			this.#unsubHostTools = this.#o.hostTools?.onChange(() => void this.#syncHostTools());
		}
		await this.#syncHostTools();
		try {
			const subs = await proc.request<{ subagents?: unknown[] }>("get_subagents");
			for (const s of subs?.subagents ?? []) {
				const info = mapSubagent(s, "snapshot");
				if (info) this.#subagents.set(info.id, info);
			}
		} catch {
			// older omp: subagent frames still arrive through the subscription
		}
		this.#touch();
	}

	#onExit(proc: OmpProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (proc !== this.#proc || this.#restarting || this.#closed) return;
		this.#finishClose(this.#closing ? "stopped" : `omp exited unexpectedly (code ${code}${signal ? `, ${signal}` : ""})`, !this.#closing, proc.stderrTail);
	}

	#finishClose(reason: string, crashed: boolean, stderrTail = ""): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#turnActive = false;
		this.#compacting = false;
		for (const s of this.#stream.values()) clearTimeout(s.timer);
		this.#stream.clear();
		this.#running.clear();
		if (this.#pendingUi.size) {
			const ids = [...this.#pendingUi.keys()];
			this.#pendingUi.clear();
			for (const reqId of ids) this.#emit({ k: "ui.end", reqId });
		}
		clearTimeout(this.#stateTimer);
		clearTimeout(this.#subTimer);
		this.#unsubHostTools?.();
		if (crashed) {
			const tail = stderrTail.trim().split("\n").slice(-1)[0] ?? "";
			this.#attention("error", `${reason}${tail ? `: ${tail}` : ""}`);
			this.#emit({ k: "notice", level: "error", message: reason });
		}
		this.#emit({ k: "closed", reason });
		this.#notifySummary();
		for (const l of this.#closeListeners) l(reason);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closing = true;
		await this.#proc.shutdown();
		this.#finishClose("stopped", false);
	}

	/** Stops the process and starts a fresh one on `resumeFile` (same sid, subscribers and transcript cache). */
	async #respawn(resumeFile: string | undefined, approvalMode?: ApprovalMode): Promise<void> {
		if (this.#turnActive || this.#compacting || this.#pendingUi.size || this.#running.size) throw busy("the session is busy; try again when it is idle");
		this.#restarting = true;
		try {
			await this.#proc.shutdown();
			if (approvalMode) this.#approvalMode = approvalMode;
			await this.#spawn(resumeFile && existsSync(resumeFile) ? resumeFile : undefined, false);
		} catch (e) {
			this.#restarting = false;
			this.#finishClose(`restart failed: ${(e as Error).message}`, true);
			throw new OpError("internal", `could not restart omp: ${(e as Error).message}`);
		}
		this.#restarting = false;
		this.#notifySummary();
	}

	// ───────────────────────────── summary / snapshot ─────────────────────────────

	#status(): SessionStatus {
		if (this.#closed) return "offline";
		if (this.#pendingUi.size > 0) return "waiting";
		if (this.#turnActive || this.#compacting) return "working";
		return "idle";
	}

	#title(): string {
		return this.#sessionName || (this.#firstUserText ? clip(this.#firstUserText, 80) : basename(this.#o.cwd)) || "session";
	}

	summary(): SessionSummary {
		const s: SessionSummary = {
			sid: this.sid,
			kind: "managed",
			title: this.#title(),
			cwd: this.#o.cwd,
			status: this.#status(),
			approvalMode: this.#approvalMode,
			costUsd: this.#costUsd,
			lastActivity: this.#lastActivity,
			pendingUi: this.#pendingUi.size,
			caps: this.#caps(),
		};
		if (this.#state.model) s.model = this.#state.model;
		if (this.#state.thinkingLevel) s.thinkingLevel = this.#state.thinkingLevel;
		const pct = this.#state.contextUsage?.percent;
		if (pct !== undefined) s.contextPercent = pct;
		if (this.#sessionFile) s.sessionFile = this.#sessionFile;
		if (this.#proc.pid) s.pid = this.#proc.pid;
		return s;
	}

	#caps(): Cap[] {
		const caps = [...MANAGED_CAPS];
		if (this.#o.hostTools) caps.push("hosttools");
		return caps;
	}

	async snapshot(limit = 200): Promise<SessionSnapshot> {
		const n = Math.max(1, Math.min(limit, 1000));
		const messages = this.#transcript.slice(-n);
		const hasMore = this.#transcript.length > n || this.#transcriptTruncated;
		const inFlight = this.#streamingMessages().filter(m => !messages.some(x => x.id === m.id));
		return {
			summary: this.summary(),
			state: this.#state,
			messages: [...messages, ...inFlight],
			hasMore,
			queue: this.#queue,
			todos: this.#todos,
			goal: this.#goal,
			pendingUi: [...this.#pendingUi.values()],
			subagents: [...this.#subagents.values()],
			runningTools: [...this.#running.values()].map(t => {
				const r: SessionSnapshot["runningTools"][number] = { callId: t.callId, tool: t.tool, args: t.args, startedAt: t.startedAt };
				if (t.intent) r.intent = t.intent;
				return r;
			}),
		};
	}

	async history(before: string | undefined, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
		const n = Math.max(1, Math.min(limit, 500));
		let end = this.#transcript.length;
		if (before) {
			const idx = this.#transcript.findIndex(m => m.id === before);
			if (idx < 0) throw invalid("unknown message id");
			end = idx;
		}
		const start = Math.max(0, end - n);
		return { messages: this.#transcript.slice(start, end), hasMore: start > 0 };
	}

	#streamingMessages(): Message[] {
		const out: Message[] = [];
		for (const [id, s] of this.#stream) {
			const m = normalizeMessage(s.raw, { blobs: this.#o.blobs, id, resolveBlob: resolveOmpBlob });
			if (m) out.push(m);
		}
		return out;
	}

	async toolOutput(callId: string, off: number): Promise<{ text: string; next?: number }> {
		let buf = this.#toolOut.get(callId);
		if (!buf) {
			const m = this.#transcript.find(x => x.role === "toolResult" && x.toolCallId === callId);
			if (!m) throw new OpError("not_found", "no output retained for that call");
			buf = Buffer.from(m.content.map(b => (b.type === "text" ? b.text : `[image: ${b.type === "image" ? b.mimeType : b.type}]`)).join("\n"), "utf8");
		}
		let start = Math.max(0, Math.floor(off));
		while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
		let end = Math.min(buf.length, start + TOOL_PAGE);
		while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
		const text = buf.toString("utf8", start, end);
		return end < buf.length ? { text, next: end } : { text };
	}

	async rename(name: string): Promise<void> {
		const n = name.trim();
		if (!n || n.length > 200) throw invalid("name must be 1..200 characters");
		await this.#rpc("set_session_name", { name: n });
		this.#sessionName = n;
		this.#notifySummary();
	}

	async fork(entryId?: string): Promise<{ sessionFile: string }> {
		const file = this.#sessionFile;
		if (!file || !existsSync(file)) throw invalid("nothing to fork yet: the session has no saved messages");
		if (this.#turnActive || this.#compacting || this.#pendingUi.size) throw busy("the session is busy; try again when it is idle");
		const r = await this.#rpc<{ cancelled?: boolean }>("fork", entryId ? { entryId } : {}, 60_000);
		if (r?.cancelled) throw invalid("fork was cancelled (the session is not persisted)");
		await this.#refreshState();
		const forked = this.#sessionFile;
		if (!forked || forked === file) throw new OpError("internal", "omp did not switch to a forked session file");
		// omp's fork moves THIS process onto the fork; put the original session back so only the new session is the fork.
		await this.#respawn(file);
		return { sessionFile: forked };
	}

	async listModels(): Promise<Ops["models.list"]["d"]["models"]> {
		const data = await this.#rpc<{ models?: unknown[] }>("get_available_models", {}, 90_000);
		return (data?.models ?? []).flatMap(m => {
			const x = mapModelListing(m);
			return x ? [x] : [];
		});
	}

	// ───────────────────────────── subscriptions ─────────────────────────────

	subscribe(listener: Listener<SessionEvent>): () => void {
		this.#evListeners.add(listener);
		return () => this.#evListeners.delete(listener);
	}

	onAttention(listener: Parameters<SessionBackend["onAttention"]>[0]): () => void {
		this.#attListeners.add(listener);
		return () => this.#attListeners.delete(listener);
	}

	onSummaryChanged(listener: () => void): () => void {
		this.#sumListeners.add(listener);
		return () => this.#sumListeners.delete(listener);
	}

	onClosed(listener: Listener<string>): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	#emit(e: SessionEvent): void {
		for (const l of [...this.#evListeners]) {
			try {
				l(e);
			} catch (err) {
				this.#o.log(`[${this.sid}] event listener threw: ${(err as Error).message}`);
			}
		}
	}

	#attention(kind: "approval" | "question" | "done" | "error" | "limit", summary: string, uiReqId?: string): void {
		const item: Parameters<Parameters<SessionBackend["onAttention"]>[0]>[0] = { sid: this.sid, sessionTitle: this.#title(), kind, summary: clip(summary, 140) };
		if (uiReqId) item.uiReqId = uiReqId;
		for (const l of [...this.#attListeners]) {
			try {
				l(item);
			} catch (err) {
				this.#o.log(`[${this.sid}] attention listener threw: ${(err as Error).message}`);
			}
		}
	}

	#notifySummary(): void {
		if (this.#sumPending) return;
		this.#sumPending = true;
		queueMicrotask(() => {
			this.#sumPending = false;
			for (const l of [...this.#sumListeners]) l();
		});
	}

	#touch(): void {
		this.#lastActivity = Date.now();
		this.#notifySummary();
	}

	// ───────────────────────────── rpc helpers ─────────────────────────────

	async #rpc<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
		if (this.#closed) throw sessionClosed("the session has ended");
		try {
			return await this.#proc.request<T>(type, params, timeoutMs);
		} catch (e) {
			throw this.#mapRpcError(e);
		}
	}

	#mapRpcError(e: unknown): OpError {
		if (e instanceof OpError) return e;
		if (e instanceof RpcError) {
			if (e.code === "exited") return sessionClosed("the session has ended");
			if (e.code === "timeout") return new OpError("timeout", e.message);
			if (e.code === "session_busy") return busy(e.message);
			return new OpError("internal", e.message);
		}
		return new OpError("internal", (e as Error).message);
	}

	// ───────────────────────────── state ─────────────────────────────

	#scheduleStateRefresh(delay = 150): void {
		if (this.#stateTimer || this.#closed) return;
		this.#stateTimer = setTimeout(() => {
			this.#stateTimer = undefined;
			void this.#refreshState().catch(() => {});
		}, delay);
	}

	async #refreshState(): Promise<SessionState> {
		const d = await this.#proc.request<Record<string, unknown>>("get_state").catch(e => {
			throw this.#mapRpcError(e);
		});
		if (!isRecord(d)) return this.#state;
		const model = mapModel(d.model);
		const cu = isRecord(d.contextUsage) ? d.contextUsage : undefined;
		const st: SessionState = {
			isStreaming: d.isStreaming === true,
			isCompacting: d.isCompacting === true,
			approvalMode: this.#approvalMode,
			costUsd: this.#costUsd,
		};
		if (model) st.model = model;
		const think = mapThinking(d.thinkingLevel);
		if (think) st.thinkingLevel = think;
		if (typeof d.fastModeEnabled === "boolean") st.fastMode = d.fastModeEnabled;
		if (cu) {
			st.contextUsage = {
				tokens: num(cu.tokens) ?? null,
				contextWindow: num(cu.contextWindow) ?? null,
				percent: num(cu.percent) ?? null,
			};
		}
		if (d.tokensPerSecond === null || num(d.tokensPerSecond) !== undefined) st.tokensPerSecond = (d.tokensPerSecond as number | null) ?? null;
		this.#sessionFile = str(d.sessionFile) ?? this.#sessionFile;
		this.#sessionName = str(d.sessionName) ?? this.#sessionName;
		this.#compacting = d.isCompacting === true;

		const qm = isRecord(d.queuedMessages) ? d.queuedMessages : undefined;
		if (qm) this.#setQueue({ steering: strList(qm.steering), followUp: strList(qm.followUp) });
		const todos = mapTodos(d.todoPhases);
		if (JSON.stringify(todos) !== JSON.stringify(this.#todos)) {
			this.#todos = todos;
			this.#emit({ k: "todos", phases: todos });
		}
		if ("goal" in d) this.#setGoal(mapGoal(d.goal));

		const ul = isRecord(d.usageLimit) ? str(d.usageLimit.stage) : undefined;
		if (ul !== this.#usageStage) {
			const prev = this.#usageStage;
			this.#usageStage = ul;
			if (ul && !prev) {
				const resets = isRecord(d.usageLimit) ? num(d.usageLimit.resetsAtSec) : undefined;
				const when = resets ? ` until ${new Date(resets * 1000).toLocaleString()}` : "";
				this.#attention("limit", `Usage limit reached (${ul === "wrap_up" ? "wrap-up" : "low priority"})${when}`);
				this.#emit({ k: "notice", level: "warning", message: `Usage limit: ${ul}${when}` });
			}
		}
		const json = JSON.stringify(st);
		if (json !== this.#stateJson) {
			this.#stateJson = json;
			this.#state = st;
			this.#emit({ k: "state", state: st });
			this.#notifySummary();
		}
		return this.#state;
	}

	#setQueue(q: QueueState): void {
		const next: QueueState = q;
		if (JSON.stringify(next) === JSON.stringify(this.#queue)) return;
		this.#queue = next;
		this.#emit({ k: "queue", queue: next });
	}

	#setGoal(g: GoalState | null): void {
		if (JSON.stringify(g) === JSON.stringify(this.#goal)) return;
		this.#goal = g;
		this.#emit({ k: "goal", goal: g });
	}

	// ───────────────────────────── transcript ─────────────────────────────

	async #loadTranscript(): Promise<void> {
		try {
			const d = await this.#proc.request<{ entries?: unknown[]; leafId?: unknown }>("get_entries", {}, 90_000);
			const out: Message[] = [];
			for (const e of activeBranch(d?.entries ?? [], d?.leafId)) {
				const m = this.#entryToMessage(e);
				if (m) out.push(m);
			}
			this.#setTranscript(out);
			return;
		} catch (e) {
			this.#o.log(`[${this.sid}] get_entries failed (${(e as Error).message}); paging messages instead`);
		}
		try {
			const out: Message[] = [];
			let cursor: string | undefined;
			for (let i = 0; i < 200; i++) {
				const page = await this.#proc.request<{ messages?: unknown[]; nextCursor?: string }>("get_messages_page", cursor ? { cursor, limit: 256 } : { limit: 256 }, 60_000);
				for (const raw of page?.messages ?? []) {
					const m = normalizeMessage(raw, { blobs: this.#o.blobs, resolveBlob: resolveOmpBlob });
					if (m) out.push(m);
				}
				if (!page?.nextCursor) break;
				cursor = page.nextCursor;
			}
			this.#setTranscript(out);
		} catch (e) {
			this.#o.log(`[${this.sid}] could not load transcript: ${(e as Error).message}`);
		}
	}

	#entryToMessage(e: Record<string, unknown>): Message | null {
		const id = str(e.id);
		if (!id) return null;
		const ts = str(e.timestamp);
		const base = { blobs: this.#o.blobs, id, resolveBlob: resolveOmpBlob };
		switch (e.type) {
			case "message": {
				const raw = isRecord(e.message) ? { ...e.message } : undefined;
				if (!raw) return null;
				if (ts && typeof raw.timestamp !== "number") raw.timestamp = ts;
				return normalizeMessage(raw, base);
			}
			case "compaction":
				return normalizeMessage({ role: "compactionSummary", summary: clip(str(e.summary) ?? "", 2000), timestamp: ts }, base);
			case "branch_summary":
				return normalizeMessage({ role: "branchSummary", summary: clip(str(e.summary) ?? "", 2000), timestamp: ts }, base);
			case "custom_message":
				return e.display === false ? null : normalizeMessage({ role: "custom", content: e.content, timestamp: ts }, base);
			default:
				return null;
		}
	}

	#setTranscript(msgs: Message[]): void {
		this.#transcript = msgs.length > TRANSCRIPT_MAX ? msgs.slice(-TRANSCRIPT_MAX) : msgs;
		this.#transcriptTruncated = msgs.length > TRANSCRIPT_MAX;
		for (const m of this.#transcript) {
			if (m.role === "assistant" && m.usage) this.#costUsd += m.usage.costUsd;
			if (m.role === "user" && !this.#firstUserText) this.#firstUserText = firstText(m);
		}
		this.#notifySummary();
	}

	#append(m: Message): void {
		const i = this.#transcript.findIndex(x => x.id === m.id);
		if (i >= 0) this.#transcript[i] = m;
		else this.#transcript.push(m);
		if (this.#transcript.length > TRANSCRIPT_MAX) {
			this.#transcript.shift();
			this.#transcriptTruncated = true;
		}
	}

	// ───────────────────────────── frame dispatch ─────────────────────────────

	#onFrame(f: Record<string, unknown>): void {
		switch (f.type) {
			case "agent_start":
				this.#turnActive = true;
				this.#abortRequested = false;
				this.#errorReported = false;
				this.#emit({ k: "agent.start" });
				this.#touch();
				return;
			case "agent_end":
				this.#onAgentEnd(f);
				return;
			case "message_start":
			case "message_update":
			case "message_end":
				this.#onMessage(f);
				return;
			case "tool_execution_start":
				this.#onToolStart(f);
				return;
			case "tool_execution_update":
				this.#onToolUpdate(f);
				return;
			case "tool_execution_end":
				this.#onToolEnd(f);
				return;
			case "extension_ui_request":
				this.#onUiRequest(f);
				return;
			case "queue_update":
				this.#setQueue({ steering: strList(f.steering), followUp: strList(f.followUp) });
				return;
			case "goal_updated":
				this.#setGoal(mapGoal(f.goal));
				return;
			case "model_changed":
			case "thinking_level_changed":
				this.#scheduleStateRefresh(50);
				return;
			case "session_settled":
				this.#scheduleStateRefresh(50);
				if (this.#pendingUi.size) this.#dropStaleUi();
				return;
			case "prompt_result":
				this.#onPromptResult(f);
				return;
			case "manual_compaction_start":
			case "auto_compaction_start":
				this.#compacting = true;
				this.#emit({ k: "compaction", phase: "start", auto: f.type === "auto_compaction_start" });
				this.#notifySummary();
				return;
			case "manual_compaction_end":
			case "auto_compaction_end": {
				this.#compacting = false;
				const auto = f.type === "auto_compaction_end";
				const err = str(f.errorMessage);
				const ev: Extract<SessionEvent, { k: "compaction" }> = { k: "compaction", phase: "end", auto, ok: f.aborted !== true && f.skipped !== true && !err };
				if (err) ev.message = clip(err, 300);
				else if (f.skipped === true) ev.message = "Nothing to compact";
				this.#emit(ev);
				this.#scheduleStateRefresh(50);
				this.#notifySummary();
				return;
			}
			case "auto_retry_start":
				this.#emit({ k: "notice", level: "warning", message: `Retrying (${num(f.attempt) ?? "?"}/${num(f.maxAttempts) ?? "?"}): ${clip(str(f.errorMessage) ?? "request failed", 200)}` });
				return;
			case "auto_retry_end":
				if (f.success === false) this.#emit({ k: "notice", level: "error", message: `Retries exhausted: ${clip(str(f.finalError) ?? "request failed", 240)}` });
				return;
			case "retry_fallback_applied":
				this.#emit({ k: "notice", level: "info", message: `Switched model: ${str(f.from) ?? "?"} → ${str(f.to) ?? "?"}` });
				this.#scheduleStateRefresh(50);
				return;
			case "notice": {
				const level = f.level === "error" || f.level === "warning" ? f.level : "info";
				const msg = str(f.message);
				if (msg) this.#emit({ k: "notice", level, message: clip(msg, 500) });
				return;
			}
			case "extension_error":
				this.#emit({ k: "notice", level: "warning", message: `Extension error: ${clip(str(f.error) ?? "unknown", 300)}` });
				return;
			case "rpc_frame_error":
				this.#emit({ k: "notice", level: "warning", message: "omp dropped an oversized event" });
				return;
			case "subagent_lifecycle":
			case "subagent_progress":
				this.#onSubagent(f);
				return;
			case "btw_record":
				this.#onBtwRecord(f);
				return;
			case "host_tool_call":
				this.#onHostToolCall(f);
				return;
			case "host_tool_cancel":
				if (typeof f.targetId === "string") this.#o.hostTools?.cancel(f.targetId);
				return;
			case "live_phase":
				if (typeof f.phase === "string") this.#emit({ k: "live.phase", phase: f.phase as Extract<SessionEvent, { k: "live.phase" }>["phase"] });
				return;
			case "live_transcript":
				if ((f.role === "user" || f.role === "assistant") && typeof f.text === "string") {
					this.#emit({ k: "live.transcript", role: f.role, turn: num(f.turn) ?? 0, text: clip(f.text, 4000), final: f.final === true });
				}
				return;
			case "live_end": {
				const ev: Extract<SessionEvent, { k: "live.end" }> = { k: "live.end" };
				const e = str(f.error);
				if (e) ev.error = clip(e, 300);
				this.#emit(ev);
				return;
			}
			case "session_info_update": {
				const t = str(f.title) ?? str(f.name) ?? (isRecord(f.info) ? str(f.info.title) ?? str(f.info.name) : undefined);
				if (t && t !== this.#sessionName) {
					this.#sessionName = t;
					this.#notifySummary();
				}
				return;
			}
			default:
				return;
		}
	}

	#onAgentEnd(f: Record<string, unknown>): void {
		const yielded = typeof f.yielded === "boolean" ? f.yielded : f.isTerminal !== false;
		const settled = f.isTerminal !== false && f.awaitingAsyncWork !== true;
		this.#emit({ k: "agent.end", yielded, settled });
		if (!yielded) {
			this.#scheduleStateRefresh(100);
			return;
		}
		this.#turnActive = false;
		for (const callId of this.#running.keys()) {
			// A tool that never reported its end (abort): close it out so the app does not spin forever.
			this.#emit({ k: "tool.end", callId, output: "", isError: true });
		}
		this.#running.clear();
		const aborted = this.#abortRequested;
		this.#abortRequested = false;
		const last = lastAssistant(f.messages);
		if (last?.stopReason === "error" && !aborted) {
			this.#reportError(str(last.errorMessage) ?? "The model request failed");
		} else if (!aborted && !this.#errorReported) {
			this.#attention("done", this.#lastAssistantText || "Finished");
		}
		this.#touch();
		this.#scheduleStateRefresh(50);
	}

	#onPromptResult(f: Record<string, unknown>): void {
		if (f.status !== "error" || this.#errorReported) return;
		const e = isRecord(f.error) ? f.error : undefined;
		const msg = str(e?.message) ?? "The prompt failed";
		this.#reportError(e?.code === "cost_cap" ? `Session cost cap reached: ${msg}` : msg);
	}

	#reportError(message: string): void {
		this.#errorReported = true;
		this.#attention(LIMIT_RE.test(message) ? "limit" : "error", message);
		this.#emit({ k: "notice", level: "error", message: clip(message, 500) });
	}

	// ───────────────────────────── messages ─────────────────────────────

	#onMessage(f: Record<string, unknown>): void {
		const id = str(f.messageId) ?? `m_${Date.now().toString(36)}`;
		const raw = isRecord(f.message) ? f.message : isRecord(f.assistantMessageEvent) ? f.assistantMessageEvent.partial : undefined;
		if (!isRecord(raw)) return;
		if (f.type === "message_end") {
			const s = this.#stream.get(id);
			if (s) {
				clearTimeout(s.timer);
				this.#stream.delete(id);
			}
			const m = normalizeMessage(raw, { blobs: this.#o.blobs, id, resolveBlob: resolveOmpBlob });
			if (!m) return;
			this.#append(m);
			if (m.role === "assistant") {
				if (m.usage) this.#costUsd += m.usage.costUsd;
				const t = firstText(m);
				if (t) this.#lastAssistantText = t;
				this.#scheduleStateRefresh(300);
			} else if (m.role === "user" && !this.#firstUserText) {
				this.#firstUserText = firstText(m);
				this.#notifySummary();
			}
			this.#emit({ k: "msg", message: m, final: true });
			this.#touch();
			return;
		}
		if (raw.role !== "assistant") return; // user/toolResult messages are emitted once, on message_end
		let s = this.#stream.get(id);
		if (!s) {
			s = { raw, lastEmit: 0 };
			this.#stream.set(id, s);
		} else {
			s.raw = raw;
		}
		const wait = s.lastEmit + COALESCE_MS - Date.now();
		if (wait <= 0) this.#flushStream(id);
		else if (!s.timer) s.timer = setTimeout(() => this.#flushStream(id), wait);
	}

	#flushStream(id: string): void {
		const s = this.#stream.get(id);
		if (!s) return;
		s.timer = undefined;
		s.lastEmit = Date.now();
		const m = normalizeMessage(s.raw, { blobs: this.#o.blobs, id, resolveBlob: resolveOmpBlob });
		if (m) this.#emit({ k: "msg", message: m, final: false });
	}

	// ───────────────────────────── tools ─────────────────────────────

	#onToolStart(f: Record<string, unknown>): void {
		const callId = str(f.toolCallId);
		const tool = str(f.toolName);
		if (!callId || !tool) return;
		const run: ToolRun = { callId, tool, args: shrinkArguments(f.args ?? {}), startedAt: Date.now() };
		const intent = str(f.intent);
		if (intent) run.intent = intent;
		this.#running.set(callId, run);
		const ev: Extract<SessionEvent, { k: "tool.start" }> = { k: "tool.start", callId, tool, args: run.args };
		if (intent) ev.intent = intent;
		this.#emit(ev);
		this.#touch();
	}

	#keepOutput(callId: string, result: unknown): void {
		const full = isRecord(result) ? result.content : result;
		const text = truncateUtf8(toolText(full), TOOL_OUTPUT_KEEP).text;
		this.#toolOut.set(callId, Buffer.from(text, "utf8"));
		while (this.#toolOut.size > 64) this.#toolOut.delete(this.#toolOut.keys().next().value!);
	}

	#onToolUpdate(f: Record<string, unknown>): void {
		const callId = str(f.toolCallId);
		if (!callId) return;
		const now = Date.now();
		if (now - (this.#toolUpdateAt.get(callId) ?? 0) < TOOL_UPDATE_MS) return;
		this.#toolUpdateAt.set(callId, now);
		const out = toolOutput(f.partialResult);
		this.#keepOutput(callId, f.partialResult);
		const ev: Extract<SessionEvent, { k: "tool.update" }> = { k: "tool.update", callId, output: out.text };
		if (out.truncated) ev.truncated = true;
		this.#emit(ev);
	}

	#onToolEnd(f: Record<string, unknown>): void {
		const callId = str(f.toolCallId);
		if (!callId) return;
		const tool = str(f.toolName) ?? this.#running.get(callId)?.tool ?? "";
		this.#running.delete(callId);
		this.#toolUpdateAt.delete(callId);
		const out = toolOutput(f.result);
		this.#keepOutput(callId, f.result);
		const ev: Extract<SessionEvent, { k: "tool.end" }> = { k: "tool.end", callId, output: out.text, isError: f.isError === true };
		if (out.truncated) ev.truncated = true;
		this.#emit(ev);
		if (/todo|goal/i.test(tool)) this.#scheduleStateRefresh(100);
		this.#touch();
	}

	// ───────────────────────────── UI ─────────────────────────────

	#onUiRequest(f: Record<string, unknown>): void {
		if (f.method === "cancel") {
			const target = str(f.targetId);
			if (target && this.#pendingUi.delete(target)) {
				this.#emit({ k: "ui.end", reqId: target });
				this.#notifySummary();
			}
			return;
		}
		const req = normalizeUiRequest(f);
		if (!req) return; // notify/setStatus/setWidget/…: presentation only
		this.#pendingUi.set(req.reqId, req);
		this.#emit({ k: "ui.request", request: req });
		if (req.kind === "approval") {
			const first = req.detail.split("\n").find(l => l.trim().length) ?? "";
			this.#attention("approval", `Approve ${req.tool}${first ? `: ${first}` : ""}?`, req.reqId);
		} else {
			const text = req.kind === "ask" ? (req.questions[0]?.question ?? "Question") : req.title;
			this.#attention("question", text || "Question", req.reqId);
		}
		this.#touch();
	}

	/** At `session_settled` nothing can still be waiting on a dialog; clear any we missed a `cancel` for. */
	#dropStaleUi(): void {
		const ids = [...this.#pendingUi.keys()];
		this.#pendingUi.clear();
		for (const reqId of ids) this.#emit({ k: "ui.end", reqId });
		this.#notifySummary();
	}

	async respondUi(reqId: string, answer: UiAnswer): Promise<void> {
		if (this.#closed) throw sessionClosed("the session has ended");
		const req = this.#pendingUi.get(reqId);
		if (!req) throw new OpError("not_found", "no such pending request (already answered or cancelled)");
		const body = uiAnswerToResponse(req, answer);
		this.#pendingUi.delete(reqId);
		this.#proc.notify({ type: "extension_ui_response", id: reqId, ...body });
		this.#emit({ k: "ui.end", reqId });
		this.#touch();
	}

	// ───────────────────────────── subagents ─────────────────────────────

	#onSubagent(f: Record<string, unknown>): void {
		const kind = f.type === "subagent_lifecycle" ? "lifecycle" : "progress";
		const info = mapSubagent(f.payload, kind);
		if (!info) return;
		const prev = this.#subagents.get(info.id);
		this.#subagents.set(info.id, prev ? { ...prev, ...info, name: info.name || prev.name } : info);
		if (this.#subTimer) return;
		this.#subTimer = setTimeout(() => {
			this.#subTimer = undefined;
			this.#emit({ k: "subagents", subagents: [...this.#subagents.values()] });
		}, 250);
	}

	// ───────────────────────────── host tools ─────────────────────────────

	async #syncHostTools(): Promise<void> {
		if (!this.#o.hostTools || this.#closed) return;
		try {
			await this.#proc.request("set_host_tools", { tools: this.#o.hostTools.definitions() });
		} catch (e) {
			this.#o.log(`[${this.sid}] set_host_tools failed: ${(e as Error).message}`);
		}
	}

	#onHostToolCall(f: Record<string, unknown>): void {
		const id = str(f.id);
		const tool = str(f.toolName);
		const host = this.#o.hostTools;
		if (!id || !tool) return;
		const reply = (content: unknown, isError: boolean): void => this.#proc.notify({ type: "host_tool_result", id, result: { content }, ...(isError ? { isError: true } : {}) });
		if (!host) {
			reply([{ type: "text", text: "host tools are not enabled for this session" }], true);
			return;
		}
		host.call(this.sid, id, tool, isRecord(f.arguments) ? f.arguments : {}).then(
			r => reply(r.content, r.isError),
			e => reply([{ type: "text", text: (e as Error).message }], true),
		);
	}

	// ───────────────────────────── driving ─────────────────────────────

	async prompt(a: PromptArgs, attachments: ResolvedAttachment[]): Promise<void> {
		let message = a.message;
		const images: { type: "image"; data: string; mimeType: string }[] = [];
		for (const att of attachments) {
			if (att.kind === "image") images.push({ type: "image", data: att.dataBase64, mimeType: att.mimeType });
			else message += `\n\n[Attached file: ${att.path}]`;
		}
		const params: Record<string, unknown> = { message, streamingBehavior: a.behavior ?? "followUp" };
		if (images.length) params.images = images;
		await this.#rpc("prompt", params, 120_000);
		this.#touch();
	}

	async abort(): Promise<{ restored?: { steering: string[]; followUp: string[] } }> {
		this.#abortRequested = this.#turnActive;
		const d = await this.#rpc<{ steering?: unknown[]; followUp?: unknown[] }>("abort_and_restore_queue", {}, 60_000);
		const texts = (v: unknown[] | undefined): string[] => (v ?? []).flatMap(x => (isRecord(x) && typeof x.text === "string" ? [x.text] : []));
		const steering = texts(d?.steering);
		const followUp = texts(d?.followUp);
		this.#scheduleStateRefresh(50);
		return steering.length || followUp.length ? { restored: { steering, followUp } } : {};
	}

	#buildOps(): SessionOpHandlers {
		return {
			"session.queue.remove": async a => {
				const d = await this.#rpc<{ removed?: boolean }>("remove_queued_message", { message: a.message, queue: a.queue });
				return { removed: d?.removed === true };
			},
			"session.queue.promote": async a => {
				const d = await this.#rpc<{ promoted?: boolean }>("promote_queued_message", { message: a.message });
				return { promoted: d?.promoted === true };
			},
			"session.btw": async a => this.#btw(a.question),
			"session.set": async a => {
				if (a.model) await this.#rpc("set_model", { provider: a.model.provider, modelId: a.model.id }, 90_000);
				if (a.thinkingLevel) await this.#rpc("set_thinking_level", { level: a.thinkingLevel });
				if (a.fastMode !== undefined) await this.#rpc("set_fast_mode", { enabled: a.fastMode });
				if (a.autoCompaction !== undefined) await this.#rpc("set_auto_compaction", { enabled: a.autoCompaction });
				if (a.approvalMode && a.approvalMode !== this.#approvalMode) await this.#respawn(this.#sessionFile, a.approvalMode);
				return { state: await this.#refreshState() };
			},
			"session.compact": async a => {
				await this.#rpc("compact", a.instructions ? { customInstructions: a.instructions } : {}, 15 * 60_000);
				return {};
			},
			"session.goal": async a => {
				const params: Record<string, unknown> = { op: a.op };
				if (a.objective) params.objective = a.objective;
				if (a.tokenBudget !== undefined) params.token_budget = a.tokenBudget;
				const d = await this.#rpc<{ goal?: unknown }>("goal", params);
				const g = mapGoal(d?.goal ?? null);
				this.#setGoal(g);
				return { goal: g };
			},
			"session.todos.set": async a => {
				await this.#rpc("set_todos", { phases: a.phases });
				this.#scheduleStateRefresh(50);
				return {};
			},
			"subagent.cancel": async a => {
				await this.#rpc("cancel_subagent", { subagentId: a.id });
				return {};
			},
			"subagent.steer": async a => {
				await this.#rpc("steer_subagent", { subagentId: a.id, message: a.message });
				return {};
			},
			"live.connect": async a => {
				const p: Record<string, unknown> = { sdpOffer: a.sdpOffer };
				if (a.voice) p.voice = a.voice;
				if (a.instructions) p.instructions = a.instructions;
				const d = await this.#rpc<{ sdpAnswer?: string; voice?: string }>("live_connect", p, 60_000);
				if (typeof d?.sdpAnswer !== "string") throw new OpError("internal", "omp returned no SDP answer");
				return { sdpAnswer: d.sdpAnswer, voice: d.voice ?? a.voice ?? "" };
			},
			"live.stop": async () => {
				await this.#rpc("live_stop", {}, 30_000);
				return {};
			},
			"live.mute": async a => {
				await this.#rpc("live_mute", { muted: a.muted });
				return {};
			},
		};
	}

	// ───────────────────────────── btw ─────────────────────────────

	#onBtwRecord(f: Record<string, unknown>): void {
		const rec = f.record;
		if (!isRecord(rec) || typeof rec.id !== "string") return;
		this.#btwRecords.set(rec.id, rec);
		if (this.#btwRecords.size > 32) this.#btwRecords.delete(this.#btwRecords.keys().next().value!);
		if (rec.status !== "running") this.#btwWaiters.get(rec.id)?.(rec);
	}

	async #btw(question: string): Promise<{ answer: string }> {
		const q = question.trim();
		if (!q || q.length > 8000) throw invalid("question must be 1..8000 characters");
		const d = await this.#rpc<{ record?: Record<string, unknown> }>("btw", { question: q }, 60_000);
		const first = d?.record;
		if (!isRecord(first) || typeof first.id !== "string") throw new OpError("internal", "omp returned no record");
		const id = first.id;
		let rec = this.#btwRecords.get(id) ?? first;
		if (rec.status === "running") {
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			this.#btwWaiters.set(id, resolve);
			const timer = setTimeout(() => resolve({ ...rec, status: "error", error: "timed out waiting for the answer" }), 180_000);
			rec = await promise;
			clearTimeout(timer);
			this.#btwWaiters.delete(id);
		}
		if (rec.status === "complete") return { answer: str(rec.answer) ?? "" };
		throw new OpError("internal", str(rec.error) ?? `the side question ended with status ${String(rec.status)}`);
	}
}

function strList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function firstText(m: Message): string {
	for (const b of m.content) if (b.type === "text" && b.text.trim()) return b.text.trim();
	return "";
}

function lastAssistant(messages: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isRecord(m) && m.role === "assistant") return m;
	}
	return undefined;
}

function toolText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.flatMap(b => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : isRecord(b) && b.type === "image" ? ["[image]"] : []))
		.join("\n");
}

