/** The bridge's single canonical object guard. Fields stay `unknown`; check each one before use. */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
