/**
 * Collab `ui-request` (host select/editor dialogs) ⇄ protocol `UiRequest` / `UiAnswer`.
 *
 * Mapping rules (PROTOCOL.md §6.3):
 *  - editor                                 → `editor`
 *  - select whose title starts `Allow tool:` → `approval` (tool = first line, detail = remaining lines)
 *  - select with `selectionMarker` (radio/checkbox) → one step of omp's `ask` tool → `ask` with a single question.
 *    The host drives `ask` as a *sequence* of selects/editors (toggle, "Next →", "Other (type your own)" + editor);
 *    {@link AskDriver} replays that sequence from the phone's single structured answer.
 *  - any other select                       → `select`
 */
import type { UiAnswer, UiRequest } from "../../../protocol/src/index.ts";
import { OpError } from "../errors.ts";
import type { WireUiOption, WireUiRequest } from "./collab-wire.ts";

// Sentinel labels the omp host appends to ask selects (extension-ui-controller.ts).
export const ASK_OTHER_OPTION = "Other (type your own)";
export const ASK_CHAT_OPTION = "Chat about this";
export const ASK_NEXT_OPTION = "Next →";
const CUSTOM_ANSWER_PREFIX = "Custom answer: ";
const APPROVAL_PREFIX = "Allow tool:";
/** Upper bound for prompt text surfaced to the phone (an approval's detail may embed whole file contents). */
const MAX_PROMPT_CHARS = 100_000;

export function optionLabel(option: WireUiOption): string {
	return typeof option === "string" ? option : option.label;
}

function clipPrompt(text: string): string {
	if (text.length <= MAX_PROMPT_CHARS) return text;
	return `${text.slice(0, MAX_PROMPT_CHARS)}\n…[truncated: ${text.length - MAX_PROMPT_CHARS} more characters; review on the PC]`;
}

function toOption(option: WireUiOption): { label: string; description?: string } {
	return typeof option === "string"
		? { label: option }
		: option.description
			? { label: option.label, description: option.description }
			: { label: option.label };
}

/** The real (non-sentinel) options of an ask select. */
function realAskOptions(req: Extract<WireUiRequest, { kind: "select" }>): WireUiOption[] {
	const count = typeof req.markableCount === "number" ? req.markableCount : req.options.length;
	return req.options.slice(0, Math.max(0, Math.min(count, req.options.length)));
}

export function toUiRequest(wire: WireUiRequest, createdAt: number): UiRequest {
	const reqId = String(wire.reqId);
	if (wire.kind === "editor") {
		const req: UiRequest = { reqId, kind: "editor", title: clipPrompt(wire.title), createdAt };
		if (typeof wire.prefill === "string") req.prefill = clipPrompt(wire.prefill);
		return req;
	}
	const labels = wire.options.map(optionLabel);
	if (wire.selectionMarker) {
		return {
			reqId,
			kind: "ask",
			createdAt,
			questions: [
				{
					id: reqId,
					question: clipPrompt(wire.title),
					multi: wire.selectionMarker === "checkbox",
					...(typeof wire.initialIndex === "number" ? { recommended: wire.initialIndex } : {}),
					options: realAskOptions(wire).map(toOption),
				},
			],
		};
	}
	if (wire.title.startsWith(APPROVAL_PREFIX)) {
		const [firstLine = "", ...rest] = wire.title.split("\n");
		return {
			reqId,
			kind: "approval",
			tool: firstLine.slice(APPROVAL_PREFIX.length).trim(),
			detail: clipPrompt(rest.join("\n")),
			options: labels,
			title: clipPrompt(wire.title),
			createdAt,
		};
	}
	return { reqId, kind: "select", title: clipPrompt(wire.title), options: wire.options.map(toOption), createdAt };
}

/** One-line description for notifications (≤140 chars is applied by the caller). */
export function describeUiRequest(request: UiRequest): string {
	switch (request.kind) {
		case "approval": {
			const detail = request.detail.split("\n", 1)[0] ?? "";
			return detail ? `Approve ${request.tool}: ${detail}` : `Approve ${request.tool}`;
		}
		case "ask":
			return request.questions[0]?.question ?? "Question";
		case "select":
		case "confirm":
		case "input":
		case "editor":
			return request.title;
	}
}

// ───────────────────────────── answers ─────────────────────────────

export interface AskPlan {
	title: string;
	marker: "radio" | "checkbox";
	/** Real option labels that must end up selected. */
	target: string[];
	/** Free-text answer (the host's "Other" path). */
	custom?: string;
}

export type UiAction =
	/** Send `ui-response` now (`value: undefined` cancels). */
	| { kind: "respond"; value: string | undefined }
	/** Multi-step ask answer: run the plan against this request and the follow-ups the host sends. */
	| { kind: "drive"; plan: AskPlan };

/** Validate a protocol answer against the pending collab request and decide what to send. */
export function planAnswer(wire: WireUiRequest, answer: UiAnswer): UiAction {
	if ("cancelled" in answer) return { kind: "respond", value: undefined };
	if (wire.kind === "editor") {
		if (!("value" in answer) || typeof answer.value !== "string") throw new OpError("invalid", "editor requests need a string `value`");
		return { kind: "respond", value: answer.value };
	}
	if (!wire.selectionMarker) {
		if (!("value" in answer) || typeof answer.value !== "string") throw new OpError("invalid", "select requests need a string `value`");
		const labels = wire.options.map(optionLabel);
		if (!labels.includes(answer.value)) throw new OpError("invalid", "value is not one of the offered options");
		return { kind: "respond", value: answer.value };
	}
	// ask step
	if (!("answers" in answer) || !Array.isArray(answer.answers)) throw new OpError("invalid", "ask requests need `answers`");
	const given = answer.answers.find(a => a.id === String(wire.reqId)) ?? answer.answers[0];
	if (!given) throw new OpError("invalid", "ask answer is empty");
	const real = realAskOptions(wire).map(optionLabel);
	const selected = Array.isArray(given.selectedOptions) ? given.selectedOptions : [];
	for (const label of selected) {
		if (!real.includes(label)) throw new OpError("invalid", `"${label}" is not one of the offered options`);
	}
	const custom = typeof given.customInput === "string" && given.customInput.trim().length > 0 ? given.customInput : undefined;
	if (wire.selectionMarker === "radio") {
		if (custom === undefined) {
			if (selected.length !== 1) throw new OpError("invalid", "pick exactly one option or type a custom answer");
			return { kind: "respond", value: selected[0] };
		}
		return { kind: "drive", plan: { title: wire.title, marker: "radio", target: [], custom } };
	}
	if (selected.length === 0 && custom === undefined) throw new OpError("invalid", "pick at least one option or type a custom answer");
	return { kind: "drive", plan: { title: wire.title, marker: "checkbox", target: [...new Set(selected)], custom } };
}

export interface DriverStep {
	value: string | undefined;
	/** True when this response completes the question (no follow-up request is expected). */
	finished: boolean;
}

/**
 * Replays the host's ask sequence for one question. Feed every incoming `ui-request` (starting with the one the
 * phone answered) to {@link step}; a non-null result is the response to send for that request.
 */
export class AskDriver {
	readonly #plan: AskPlan;
	#awaitingEditor = false;
	#steps = 0;

	constructor(plan: AskPlan) {
		this.#plan = plan;
	}

	step(req: WireUiRequest): DriverStep | null {
		if (this.#awaitingEditor) {
			if (req.kind === "editor" && req.title.startsWith(CUSTOM_ANSWER_PREFIX)) {
				return { value: this.#plan.custom, finished: true };
			}
			return null;
		}
		if (req.kind !== "select" || req.selectionMarker !== this.#plan.marker || req.title !== this.#plan.title) return null;
		if (++this.#steps > 2 * req.options.length + 8) return { value: undefined, finished: true };
		const labels = req.options.map(optionLabel);
		const choose = (label: string): DriverStep | null => (labels.includes(label) ? { value: label, finished: false } : null);
		const other = (): DriverStep => {
			this.#awaitingEditor = true;
			return choose(ASK_OTHER_OPTION) ?? { value: undefined, finished: true };
		};
		if (this.#plan.marker === "radio") return other();
		const real = realAskOptions(req).map(optionLabel);
		const checked = new Set((req.checkedIndices ?? []).map(i => real[i]).filter((l): l is string => l !== undefined));
		const target = new Set(this.#plan.target);
		for (const label of real) {
			if (target.has(label) !== checked.has(label)) return choose(label) ?? { value: undefined, finished: true };
		}
		if (this.#plan.custom !== undefined) return other();
		return labels.includes(ASK_NEXT_OPTION) ? { value: ASK_NEXT_OPTION, finished: true } : { value: undefined, finished: true };
	}
}
