/**
 * OMP Remote L2 protocol — typed shapes. Normative companion to docs/PROTOCOL.md.
 * Dependency-free. The Android app mirrors these as kotlinx.serialization classes.
 * Unknown fields and unknown event kinds MUST be ignored by receivers.
 */

export const PROTO = 1;

// ─────────────────────────────── primitives ───────────────────────────────

export type SessionKind = "managed" | "tui" | "recent";
export type SessionStatus = "idle" | "working" | "waiting" | "offline";
export type ApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What a given session lets the app do. The app disables anything not listed. */
export type Cap =
	| "prompt" | "steer" | "abort" | "queue" | "ui" | "images" | "files"
	| "model" | "thinking" | "fast" | "compact" | "goal" | "todos" | "fork" | "tree"
	| "subagents" | "hosttools" | "voice" | "approvalMode" | "stats" | "btw";

/** Device-side capabilities advertised in HELLO. */
export type DeviceCap = "location" | "clipboard" | "notify" | "camera" | "voice";

export type ErrorCode =
	| "unauthorized" | "not_found" | "invalid" | "busy" | "unsupported"
	| "forbidden_path" | "forbidden" | "readonly" | "session_closed" | "timeout" | "internal";

export interface WireError { code: ErrorCode; message: string }

export interface HostInfo {
	proto: number;
	hostId: string;
	name: string;
	platform: string;
	bridgeVersion: string;
	ompVersion: string | null;
	roots: string[];
	/** True when the bridge can send FCM wake pushes. */
	push: boolean;
	/** Approval modes this PC accepts for sessions started or changed from a phone. Absent on older bridges: assume all. */
	approvalModes?: ApprovalMode[];
	now: number;
}

export interface ModelRef { provider: string; id: string; name?: string; contextWindow?: number | null }

export interface SessionSummary {
	sid: string;
	kind: SessionKind;
	title: string;
	cwd: string;
	status: SessionStatus;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	contextPercent?: number | null;
	costUsd?: number;
	lastActivity: number;
	/** Pending UI requests (approvals/questions) awaiting an answer. */
	pendingUi: number;
	/** `recent` and `managed` only: persisted session file. */
	sessionFile?: string;
	caps: Cap[];
	/** `tui` only: process info for display. */
	pid?: number;
}

// ─────────────────────────────── messages ────────────────────────────────

export type Block =
	| { type: "text"; text: string; truncated?: boolean }
	| { type: "thinking"; thinking: string; truncated?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string }
	| { type: "image"; ref: string; mimeType: string; bytes: number };

export interface Message {
	/** Stable id: omp entry id when persisted, otherwise a bridge-assigned id. */
	id: string;
	role: "user" | "assistant" | "toolResult" | "developer";
	content: Block[];
	/** assistant */
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
	/** toolResult */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** user messages injected by a collab guest or the phone. */
	from?: string;
	timestamp: number;
}

export interface TodoTask { content: string; status: "pending" | "in_progress" | "completed" | "abandoned" | string; blocker?: string }
export interface TodoPhase { name: string; tasks: TodoTask[] }

export interface QueueState { steering: string[]; followUp: string[] }

export interface GoalState { objective: string; status: string; tokenBudget?: number; tokensUsed?: number }

export interface SubagentInfo {
	id: string;
	name: string;
	kind: "main" | "sub";
	status: "running" | "idle" | "parked" | "aborted" | "pending" | "completed" | "failed" | string;
	task?: string;
	lastIntent?: string;
	currentTool?: string;
	tokens?: number;
	costUsd?: number;
}

export interface SessionState {
	isStreaming: boolean;
	isCompacting: boolean;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
	fastMode?: boolean;
	approvalMode?: ApprovalMode;
	contextUsage?: { tokens: number | null; contextWindow: number | null; percent: number | null };
	costUsd?: number;
	tokensPerSecond?: number | null;
	participants?: { name: string; role: "host" | "guest"; readOnly?: boolean }[];
}

// ─────────────────────────────── UI requests ──────────────────────────────

export type UiRequest =
	| { reqId: string; kind: "approval"; tool: string; detail: string; options: string[]; title: string; createdAt: number }
	| { reqId: string; kind: "select"; title: string; options: { label: string; description?: string }[]; createdAt: number }
	| { reqId: string; kind: "confirm"; title: string; message?: string; createdAt: number }
	| { reqId: string; kind: "input"; title: string; placeholder?: string; secret?: boolean; createdAt: number }
	| { reqId: string; kind: "editor"; title: string; prefill?: string; createdAt: number }
	| {
			reqId: string; kind: "ask"; createdAt: number;
			questions: {
				id: string; question: string; header?: string; multi?: boolean; recommended?: number;
				options: { label: string; description?: string; preview?: string }[];
			}[];
	  };

/** Argument of `ui.respond`. Exactly one of the fields applies per request kind. */
export type UiAnswer =
	| { value: string }                                   // approval (option string), select, input, editor
	| { confirmed: boolean }                              // confirm
	| { answers: { id: string; selectedOptions: string[]; customInput?: string }[] } // ask
	| { cancelled: true };

// ─────────────────────────────── snapshot ─────────────────────────────────

export interface SessionSnapshot {
	summary: SessionSummary;
	state: SessionState;
	messages: Message[];
	/** True when older messages exist; page with `session.history`. */
	hasMore: boolean;
	queue: QueueState;
	todos: TodoPhase[];
	goal: GoalState | null;
	pendingUi: UiRequest[];
	subagents: SubagentInfo[];
	/** Running tool calls at snapshot time. */
	runningTools: { callId: string; tool: string; args: unknown; intent?: string; startedAt: number }[];
}

// ─────────────────────────────── events ───────────────────────────────────

export type SessionEvent =
	| { k: "agent.start" }
	| { k: "agent.end"; yielded: boolean; settled: boolean }
	| { k: "msg"; message: Message; final: boolean }
	| { k: "tool.start"; callId: string; tool: string; args: unknown; intent?: string }
	| { k: "tool.update"; callId: string; output: string; truncated?: boolean }
	| { k: "tool.end"; callId: string; output: string; isError: boolean; truncated?: boolean }
	| { k: "ui.request"; request: UiRequest }
	| { k: "ui.end"; reqId: string }
	| { k: "state"; state: SessionState }
	| { k: "queue"; queue: QueueState }
	| { k: "todos"; phases: TodoPhase[] }
	| { k: "goal"; goal: GoalState | null }
	| { k: "subagents"; subagents: SubagentInfo[] }
	| { k: "notice"; level: "info" | "warning" | "error"; message: string }
	| { k: "compaction"; phase: "start" | "end"; auto: boolean; ok?: boolean; message?: string }
	| { k: "live.phase"; phase: "connecting" | "listening" | "working" | "speaking" | "muted" | "error" }
	| { k: "live.transcript"; role: "user" | "assistant"; turn: number; text: string; final: boolean }
	| { k: "live.end"; error?: string }
	| { k: "closed"; reason: string };

export type AttentionKind = "approval" | "question" | "done" | "error" | "limit";

export interface AttentionItem {
	id: string;
	ts: number;
	sid: string;
	sessionTitle: string;
	kind: AttentionKind;
	/** ≤140 chars, plain text. */
	summary: string;
	uiReqId?: string;
	resolved: boolean;
}

export type HostEvent =
	| { k: "sessions.changed" }
	| { k: "attention"; item: AttentionItem }
	| { k: "attention.resolved"; id: string }
	| { k: "hosttool.call"; callId: string; sid: string; tool: string; args: Record<string, unknown> }
	| { k: "hosttool.cancel"; callId: string }
	| { k: "host.notice"; level: "info" | "warning" | "error"; message: string };

// ─────────────────────────────── operations ───────────────────────────────

export interface FsEntry { name: string; path: string; dir: boolean; size?: number; mtime?: number }

export interface CreateSessionArgs {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	approvalMode?: ApprovalMode;
	/** Sent as the first prompt when present. */
	prompt?: string;
	attachments?: { ref: string }[];
	goal?: { objective: string; tokenBudget?: number };
	/** Register `phone_*` host tools for this session. */
	hostTools?: boolean;
}

export interface PromptArgs {
	sid: string;
	message: string;
	attachments?: { ref: string }[];
	/** Required semantics while the agent is busy; the bridge defaults to "followUp". */
	behavior?: "steer" | "followUp";
}

export interface Ops {
	// host
	"host.info": { a: {}; d: HostInfo };
	"models.list": { a: { sid?: string }; d: { models: (ModelRef & { thinkingLevels?: ThinkingLevel[] })[] } };
	"fs.roots": { a: {}; d: { roots: string[] } };
	"fs.list": { a: { path: string; files?: boolean }; d: { path: string; entries: FsEntry[] } };
	"attention.list": { a: { since?: number }; d: { items: AttentionItem[] } };
	"attention.dismiss": { a: { id: string }; d: {} };
	"push.register": { a: { provider: "fcm"; token: string }; d: {} };
	"devices.list": { a: {}; d: { devices: { did: string; label: string; lastSeen: number; current: boolean }[] } };
	"devices.revoke": { a: { did: string }; d: {} };

	// sessions
	"sessions.list": { a: { recent?: number }; d: { sessions: SessionSummary[] } };
	"sessions.create": { a: CreateSessionArgs; d: { sid: string } };
	"sessions.open": { a: { sessionFile: string }; d: { sid: string } };
	"sessions.stop": { a: { sid: string }; d: {} };
	"sessions.handover": { a: { sid: string }; d: { sid: string } };
	"sessions.rename": { a: { sid: string; name: string }; d: {} };

	// session lifecycle / reading
	"session.open": { a: { sid: string; limit?: number }; d: { snapshot: SessionSnapshot; n: number } };
	"session.close": { a: { sid: string }; d: {} };
	"session.history": { a: { sid: string; before?: string; limit?: number }; d: { messages: Message[]; hasMore: boolean } };
	"tool.output": { a: { sid: string; callId: string; off?: number }; d: { text: string; next?: number } };
	"blob.get": { a: { ref: string; off?: number; len?: number }; d: { data: string; total: number; mimeType: string } };

	// driving
	"session.prompt": { a: PromptArgs; d: {} };
	"session.abort": { a: { sid: string }; d: { restored?: { steering: string[]; followUp: string[] } } };
	"session.queue.remove": { a: { sid: string; message: string; queue: "steering" | "followUp" }; d: { removed: boolean } };
	"session.queue.promote": { a: { sid: string; message: string }; d: { promoted: boolean } };
	"ui.respond": { a: { sid: string; reqId: string; answer: UiAnswer }; d: {} };
	"session.btw": { a: { sid: string; question: string }; d: { answer: string } };

	// settings
	"session.set": {
		a: {
			sid: string;
			model?: { provider: string; id: string };
			thinkingLevel?: ThinkingLevel;
			fastMode?: boolean;
			approvalMode?: ApprovalMode;
			autoCompaction?: boolean;
		};
		d: { state: SessionState };
	};
	"session.compact": { a: { sid: string; instructions?: string }; d: {} };
	"session.goal": { a: { sid: string; op: "create" | "pause" | "resume" | "drop"; objective?: string; tokenBudget?: number }; d: { goal: GoalState | null } };
	"session.todos.set": { a: { sid: string; phases: TodoPhase[] }; d: {} };
	"session.fork": { a: { sid: string; entryId?: string }; d: { sid: string } };

	// subagents
	"subagent.cancel": { a: { sid: string; id: string }; d: {} };
	"subagent.steer": { a: { sid: string; id: string; message: string }; d: {} };

	// uploads
	"upload.begin": { a: { name: string; mime: string; size: number; purpose: "image" | "file"; sid?: string }; d: { uploadId: string } };
	"upload.chunk": { a: { uploadId: string; i: number; d: string }; d: {} };
	"upload.end": { a: { uploadId: string }; d: { ref: string; path?: string } };

	// phone tools & voice
	"hosttool.result": { a: { callId: string; ok: boolean; content?: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; error?: string }; d: {} };
	"live.connect": { a: { sid: string; sdpOffer: string; voice?: string; instructions?: string }; d: { sdpAnswer: string; voice: string } };
	"live.stop": { a: { sid: string }; d: {} };
	"live.mute": { a: { sid: string; muted: boolean }; d: {} };
}

export type OpName = keyof Ops;

// ─────────────────────────────── envelopes ────────────────────────────────

export type AppToBridge =
	| { q: number; t: "req"; id: number; op: OpName; a: unknown }
	| { q: number; t: "ping" }
	| { q: number; t: "pong" };

export type BridgeToApp =
	| { q: number; t: "res"; id: number; ok: true; d: unknown }
	| { q: number; t: "res"; id: number; ok: false; e: WireError }
	| { q: number; t: "ev"; sid: string; n: number; e: SessionEvent }
	| { q: number; t: "hev"; e: HostEvent }
	| { q: number; t: "ping" }
	| { q: number; t: "pong" };

// ─────────────────────────────── handshake ────────────────────────────────

export interface PairReq { t: "pair-req"; dpk: string; label: string; ts: number }
export type PairRes = { t: "pair-ok"; did: string; hostId: string; name: string } | { t: "pair-no"; reason: string };
export interface Hello { t: "hello"; eph: string; n: string; ts: number; caps: DeviceCap[]; app: string; label: string }
export interface HelloOk { t: "hello-ok"; eph: string; n: string; host: HostInfo }

export const FRAME_PAIR = 0x00;
export const FRAME_HELLO = 0x01;
export const FRAME_DATA = 0x02;
export const MAX_PLAINTEXT = 512 * 1024;
