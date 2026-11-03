import type { ErrorCode, WireError } from "../../protocol/src/index.ts";

/** Thrown by op handlers / backends; the dispatcher turns it into a `res` with `ok:false`. */
export class OpError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "OpError";
		this.code = code;
	}
}

export const invalid = (message: string): OpError => new OpError("invalid", message);
export const notFound = (message: string): OpError => new OpError("not_found", message);
export const unsupported = (message: string): OpError => new OpError("unsupported", message);
export const busy = (message: string): OpError => new OpError("busy", message);
/** Policy refusal (e.g. an approval mode the bridge config does not allow). */
export const forbidden = (message: string): OpError => new OpError("forbidden", message);
export const forbiddenPath = (message: string): OpError => new OpError("forbidden_path", message);
export const sessionClosed = (message: string): OpError => new OpError("session_closed", message);

export function toWireError(e: unknown): WireError {
	if (e instanceof OpError) return { code: e.code, message: e.message };
	const message = e instanceof Error ? e.message : String(e);
	return { code: "internal", message };
}
