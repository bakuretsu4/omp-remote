/**
 * Collab wire values → protocol values (entries → `Message`, state → `SessionState`, agents → `SubagentInfo`).
 * Message shape normalization itself (blocks, images → blob refs, truncation) is `normalize/message.ts`.
 */
import type { Message, ModelRef, SessionState, SubagentInfo, ThinkingLevel } from "../../../protocol/src/index.ts";
import type { BlobStore } from "../backend.ts";
import { isRecord } from "../guards.ts";
import { normalizeMessage } from "../normalize/message.ts";
import type { WireAgent, WireEntry, WireModel, WireState } from "./collab-wire.ts";

/** omp's `collab-prompt` custom message: a prompt injected by a collab guest (the phone, another omp…). */
export const COLLAB_PROMPT_TYPE = "collab-prompt";

const THINKING_LEVELS: Record<string, true> = {
	off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};

export function thinkingLevelOf(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS[value] === true ? (value as ThinkingLevel) : undefined;
}

export function modelRef(model: WireModel | undefined): ModelRef | undefined {
	if (!model || typeof model.id !== "string" || typeof model.provider !== "string") return undefined;
	return { provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow ?? null };
}

/** A replicated session entry as a displayable `Message`, or null for entries the phone has no use for. */
export function entryToMessage(entry: WireEntry, blobs: BlobStore): Message | null {
	switch (entry.type) {
		case "message":
			return isRecord(entry.message) ? normalizeMessage({ ...entry.message, timestamp: timestampOf(entry) }, { blobs, id: entry.id }) : null;
		case "custom_message": {
			if (entry.display === false) return null;
			const from = isRecord(entry.details) && typeof entry.details.from === "string" ? entry.details.from : undefined;
			if (entry.customType === COLLAB_PROMPT_TYPE) {
				return normalizeMessage({ role: "user", content: entry.content, timestamp: timestampOf(entry) }, { blobs, id: entry.id, from });
			}
			return normalizeMessage({ role: "custom", content: entry.content, display: true, timestamp: timestampOf(entry) }, { blobs, id: entry.id });
		}
		case "compaction":
			return normalizeMessage({ role: "compactionSummary", summary: entry.shortSummary ?? entry.summary, timestamp: timestampOf(entry) }, { blobs, id: entry.id });
		case "branch_summary":
			return normalizeMessage({ role: "branchSummary", summary: entry.summary, timestamp: timestampOf(entry) }, { blobs, id: entry.id });
		default:
			return null; // model_change / thinking_level_change are reflected by `state`
	}
}

/** Prefer the message's own epoch-ms timestamp; entries carry an ISO string. */
function timestampOf(entry: WireEntry): number {
	if (isRecord(entry.message) && typeof entry.message.timestamp === "number") return entry.message.timestamp;
	const t = Date.parse(entry.timestamp);
	return Number.isNaN(t) ? Date.now() : t;
}

export interface LiveSessionState {
	isCompacting: boolean;
	costUsd: number;
}

export function toSessionState(state: WireState, live: LiveSessionState): SessionState {
	const out: SessionState = { isStreaming: state.isStreaming === true, isCompacting: live.isCompacting };
	const model = modelRef(state.model);
	if (model) out.model = model;
	const thinking = thinkingLevelOf(state.thinkingLevel);
	if (thinking) out.thinkingLevel = thinking;
	if (state.contextUsage) {
		out.contextUsage = {
			tokens: state.contextUsage.tokens ?? null,
			contextWindow: state.contextUsage.contextWindow ?? null,
			percent: state.contextUsage.percent ?? null,
		};
	}
	out.costUsd = live.costUsd;
	if (Array.isArray(state.participants)) {
		out.participants = state.participants.map(p => ({
			name: String(p.name),
			role: p.role === "host" ? "host" : "guest",
			...(p.readOnly ? { readOnly: true } : {}),
		}));
	}
	return out;
}

/** Latest progress payload per agent (omp `task:subagent:progress`). Only the fields we surface are typed. */
export interface AgentProgressInfo {
	task?: string;
	lastIntent?: string;
	currentTool?: string;
	tokens?: number;
	cost?: number;
	status?: string;
}

export function progressInfoOf(data: unknown): { id: string; info: AgentProgressInfo } | null {
	if (!isRecord(data) || !isRecord(data.progress)) return null;
	const p = data.progress;
	const id = p.id;
	if (typeof id !== "string") return null;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	return {
		id,
		info: { task: str(p.task), lastIntent: str(p.lastIntent), currentTool: str(p.currentTool), tokens: num(p.tokens), cost: num(p.cost), status: str(p.status) },
	};
}

export function toSubagents(agents: readonly WireAgent[], progress: ReadonlyMap<string, AgentProgressInfo>): SubagentInfo[] {
	return agents.map(agent => {
		const p = progress.get(agent.id);
		const info: SubagentInfo = {
			id: agent.id,
			name: agent.displayName,
			kind: agent.kind === "main" ? "main" : "sub",
			status: agent.status,
		};
		if (p?.task) info.task = p.task;
		if (p?.lastIntent) info.lastIntent = p.lastIntent;
		if (p?.currentTool) info.currentTool = p.currentTool;
		if (p?.tokens !== undefined) info.tokens = p.tokens;
		if (p?.cost !== undefined) info.costUsd = p.cost;
		return info;
	});
}

/** Total `usage.cost.total` of an assistant wire message, 0 when absent. */
export function messageCost(message: unknown): number {
	if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return 0;
	const cost = message.usage.cost;
	const total = isRecord(cost) ? cost.total : cost;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
