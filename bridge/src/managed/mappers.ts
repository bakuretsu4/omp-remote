/** Pure mappers from omp RPC payloads to protocol shapes. */
import type {
	GoalState, ModelRef, SubagentInfo, ThinkingLevel, TodoPhase,
} from "../../../protocol/src/index.ts";
import { isRecord } from "../guards.ts";

const THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const clip = (s: string, n: number): string => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function mapThinking(v: unknown): ThinkingLevel | undefined {
	return typeof v === "string" && THINKING.includes(v) ? (v as ThinkingLevel) : undefined;
}

export function mapModel(m: unknown): ModelRef | undefined {
	if (!isRecord(m) || typeof m.id !== "string" || typeof m.provider !== "string") return undefined;
	const ref: ModelRef = { provider: m.provider, id: m.id };
	if (typeof m.name === "string") ref.name = m.name;
	if (typeof m.contextWindow === "number") ref.contextWindow = m.contextWindow;
	return ref;
}

/** `get_available_models` entry → ModelRef + selectable thinking levels. */
export function mapModelListing(m: unknown): (ModelRef & { thinkingLevels?: ThinkingLevel[] }) | undefined {
	const ref = mapModel(m);
	if (!ref || !isRecord(m)) return ref;
	const out: ModelRef & { thinkingLevels?: ThinkingLevel[] } = { ...ref };
	if (m.reasoning === true && isRecord(m.thinking) && Array.isArray(m.thinking.efforts)) {
		const levels = m.thinking.efforts.map(mapThinking).filter((l): l is ThinkingLevel => l !== undefined);
		out.thinkingLevels = ["off", ...levels.filter(l => l !== "off")];
	} else {
		out.thinkingLevels = ["off"];
	}
	return out;
}

/** Accepts omp's `Goal`, `GoalModeState` (`{goal}`), or null. */
export function mapGoal(g: unknown): GoalState | null {
	const goal = isRecord(g) && isRecord(g.goal) ? g.goal : g;
	if (!isRecord(goal) || typeof goal.objective !== "string") return null;
	const out: GoalState = { objective: goal.objective, status: typeof goal.status === "string" ? goal.status : "active" };
	if (typeof goal.tokenBudget === "number") out.tokenBudget = goal.tokenBudget;
	if (typeof goal.tokensUsed === "number") out.tokensUsed = goal.tokensUsed;
	return out;
}

export function mapTodos(v: unknown): TodoPhase[] {
	if (!Array.isArray(v)) return [];
	const phases: TodoPhase[] = [];
	for (const p of v) {
		if (!isRecord(p) || typeof p.name !== "string" || !Array.isArray(p.tasks)) continue;
		const tasks: TodoPhase["tasks"] = [];
		for (const t of p.tasks) {
			if (!isRecord(t) || typeof t.content !== "string" || typeof t.status !== "string") continue;
			tasks.push(typeof t.blocker === "string" ? { content: t.content, status: t.status, blocker: t.blocker } : { content: t.content, status: t.status });
		}
		phases.push({ name: p.name, tasks });
	}
	return phases;
}

const SUB_STATUS: Record<string, string> = { started: "running", completed: "completed", failed: "failed", aborted: "aborted" };

/** `get_subagents` snapshot entry, `subagent_lifecycle` payload, or `subagent_progress` payload → SubagentInfo patch. */
export function mapSubagent(p: unknown, kind: "snapshot" | "lifecycle" | "progress"): SubagentInfo | undefined {
	if (!isRecord(p)) return undefined;
	const progress = isRecord(p.progress) ? p.progress : undefined;
	const id = typeof p.id === "string" ? p.id : typeof progress?.id === "string" ? progress.id : undefined;
	if (!id) return undefined;
	const rawStatus = typeof progress?.status === "string" && kind !== "lifecycle" ? progress.status : typeof p.status === "string" ? p.status : "running";
	const info: SubagentInfo = {
		id,
		name: typeof p.agent === "string" ? p.agent : typeof progress?.agent === "string" ? progress.agent : id,
		kind: "sub",
		status: kind === "lifecycle" ? (SUB_STATUS[rawStatus] ?? rawStatus) : rawStatus,
	};
	const task = typeof p.task === "string" ? p.task : typeof progress?.task === "string" ? progress.task : typeof p.description === "string" ? p.description : undefined;
	if (task) info.task = clip(task, 200);
	if (progress) {
		const intent = progress.currentToolIntent ?? progress.lastIntent;
		if (typeof intent === "string") info.lastIntent = clip(intent, 160);
		if (typeof progress.currentTool === "string") info.currentTool = progress.currentTool;
		if (typeof progress.tokens === "number") info.tokens = progress.tokens;
	}
	return info;
}

/**
 * Active branch of an omp entry list in chronological order, following `parentId` from `leafId`.
 * Falls back to append order when the tree is unusable.
 */
export function activeBranch(entries: unknown[], leafId: unknown): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	const all: Record<string, unknown>[] = [];
	for (const e of entries) {
		if (!isRecord(e)) continue;
		all.push(e);
		if (typeof e.id === "string") byId.set(e.id, e);
	}
	if (typeof leafId !== "string" || !byId.has(leafId)) return all;
	const out: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let cur: Record<string, unknown> | undefined = byId.get(leafId);
	while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
		seen.add(cur.id);
		out.push(cur);
		cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
	}
	return out.reverse();
}
