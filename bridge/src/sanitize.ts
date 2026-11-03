/** One shared sanitizer for every peer-controlled display string (pair-req / HELLO labels, device names). */

// \p{C}: control, format (incl. bidi marks and ZWJ/ZWSP), surrogate, private-use, unassigned.
// The explicit bidi ranges are listed too so the intent survives a regex-engine change.
const STRIP = /[\p{C}\u202A-\u202E\u2066-\u2069\u2028\u2029]/gu;

/**
 * Strips control/format/bidi characters, collapses whitespace, trims and caps the length (in code points).
 * Returns `fallback` when nothing printable is left or the input is not a string.
 */
export function cleanLabel(v: unknown, fallback = "Phone", max = 64): string {
	if (typeof v !== "string") return fallback;
	const s = v.replace(STRIP, " ").replace(/\s+/gu, " ").trim();
	if (s.length === 0) return fallback;
	const cps = Array.from(s);
	return cps.length > max ? cps.slice(0, max).join("").trim() || fallback : s;
}
