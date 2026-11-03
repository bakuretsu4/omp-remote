/**
 * omp `extension_ui_request` frames ⇄ protocol `UiRequest` / `UiAnswer` (PROTOCOL.md §6.3).
 */
import type { UiAnswer, UiRequest } from "../../../protocol/src/index.ts";
import { invalid } from "../errors.ts";
import { isRecord } from "../guards.ts";

const APPROVAL_PREFIX = "Allow tool:";
const DETAIL_LIMIT = 8 * 1024;
const TITLE_LIMIT = 2 * 1024;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Returns null for frames that are not dialogs (notify, setStatus, setWidget, setTitle, set_editor_text,
 * open_url, cancel). Approval prompts are `select` frames whose title starts with `Allow tool:`.
 */
export function normalizeUiRequest(frame: unknown, createdAt: number = Date.now()): UiRequest | null {
	if (!isRecord(frame)) return null;
	const reqId = str(frame.id);
	if (!reqId) return null;
	switch (frame.method) {
		case "select": {
			const title = str(frame.title) ?? "";
			const options = Array.isArray(frame.options) ? frame.options.filter((o): o is string => typeof o === "string") : [];
			if (title.startsWith(APPROVAL_PREFIX)) {
				const nl = title.indexOf("\n");
				const head = (nl < 0 ? title : title.slice(0, nl)).slice(APPROVAL_PREFIX.length).trim();
				const detail = nl < 0 ? "" : title.slice(nl + 1);
				return { reqId, kind: "approval", tool: head, detail: clip(detail, DETAIL_LIMIT), options, title: clip(nl < 0 ? title : title.slice(0, nl), TITLE_LIMIT), createdAt };
			}
			const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
			return {
				reqId,
				kind: "select",
				title: clip(title, TITLE_LIMIT),
				options: options.map((label, i) => {
					const d = details[i];
					const description = isRecord(d) ? str(d.description) : undefined;
					return description ? { label, description } : { label };
				}),
				createdAt,
			};
		}
		case "confirm": {
			const req: UiRequest = { reqId, kind: "confirm", title: clip(str(frame.title) ?? "", TITLE_LIMIT), createdAt };
			const message = str(frame.message);
			if (message) req.message = clip(message, DETAIL_LIMIT);
			return req;
		}
		case "input": {
			const req: UiRequest = { reqId, kind: "input", title: clip(str(frame.title) ?? "", TITLE_LIMIT), createdAt };
			const placeholder = str(frame.placeholder);
			if (placeholder) req.placeholder = placeholder;
			if (frame.secret === true) req.secret = true;
			return req;
		}
		case "editor": {
			const req: UiRequest = { reqId, kind: "editor", title: clip(str(frame.title) ?? "", TITLE_LIMIT), createdAt };
			const prefill = str(frame.prefill);
			if (prefill) req.prefill = clip(prefill, DETAIL_LIMIT * 4);
			return req;
		}
		case "ask": {
			if (!Array.isArray(frame.questions)) return null;
			const questions: Extract<UiRequest, { kind: "ask" }>["questions"] = [];
			for (const q of frame.questions) {
				if (!isRecord(q) || typeof q.id !== "string" || typeof q.question !== "string") continue;
				const options = (Array.isArray(q.options) ? q.options : []).flatMap(o => {
					if (!isRecord(o) || typeof o.label !== "string") return [];
					const opt: { label: string; description?: string; preview?: string } = { label: o.label };
					if (typeof o.description === "string") opt.description = o.description;
					if (typeof o.preview === "string") opt.preview = clip(o.preview, DETAIL_LIMIT);
					return [opt];
				});
				const nq: (typeof questions)[number] = { id: q.id, question: q.question, options };
				if (typeof q.header === "string") nq.header = q.header;
				if (q.multi === true) nq.multi = true;
				if (typeof q.recommended === "number") nq.recommended = q.recommended;
				questions.push(nq);
			}
			return { reqId, kind: "ask", createdAt, questions };
		}
		default:
			return null;
	}
}

/**
 * Validates `answer` against `req` and returns the body of omp's `extension_ui_response`
 * (everything except `type` and `id`). Throws `invalid` on a mismatch so garbage never reaches omp.
 */
export function uiAnswerToResponse(req: UiRequest, answer: UiAnswer): Record<string, unknown> {
	if ("cancelled" in answer && answer.cancelled === true) return { cancelled: true };
	switch (req.kind) {
		case "approval":
		case "select": {
			if (!("value" in answer) || typeof answer.value !== "string") throw invalid(`${req.kind} needs {value}`);
			const labels = req.kind === "approval" ? req.options : req.options.map(o => o.label);
			if (!labels.includes(answer.value)) throw invalid("value is not one of the offered options");
			return { value: answer.value };
		}
		case "input":
		case "editor":
			if (!("value" in answer) || typeof answer.value !== "string") throw invalid(`${req.kind} needs {value}`);
			return { value: answer.value };
		case "confirm":
			if (!("confirmed" in answer) || typeof answer.confirmed !== "boolean") throw invalid("confirm needs {confirmed}");
			return { confirmed: answer.confirmed };
		case "ask": {
			if (!("answers" in answer) || !Array.isArray(answer.answers)) throw invalid("ask needs {answers}");
			if (answer.answers.length !== req.questions.length) throw invalid("answers must list one entry per question, in order");
			const out: { id: string; selectedOptions: string[]; customInput?: string }[] = [];
			for (let i = 0; i < req.questions.length; i++) {
				const q = req.questions[i]!;
				const a = answer.answers[i];
				if (!a || a.id !== q.id || !Array.isArray(a.selectedOptions) || !a.selectedOptions.every(s => typeof s === "string")) {
					throw invalid(`answer ${i} does not match question ${q.id}`);
				}
				const entry: { id: string; selectedOptions: string[]; customInput?: string } = { id: q.id, selectedOptions: a.selectedOptions };
				if (typeof a.customInput === "string" && a.customInput.trim().length) entry.customInput = a.customInput;
				out.push(entry);
			}
			return { answers: out };
		}
	}
}
