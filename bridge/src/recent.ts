import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface RecentInfo {
	sid: string;
	sessionFile: string;
	cwd: string;
	title: string;
	mtimeMs: number;
	sessionId?: string;
}

const DEFAULT_HEAD_BYTES = 64 * 1024;
const STAT_CONCURRENCY = 32;
const MAX_TITLE_CHARS = 80;

/** `r_` + base64url(sha256(absolute file path)).slice(0,11) */
export function sidForFile(sessionFile: string): string {
	return `r_${createHash("sha256").update(sessionFile).digest("base64url").slice(0, 11)}`;
}

interface Parsed {
	info: RecentInfo;
	empty: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
	const chars = Array.from(s);
	return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("") : s;
}

function cleanTitle(v: unknown): string {
	return typeof v === "string" ? clip(collapse(v)) : "";
}

function userText(message: unknown): string {
	if (!isRecord(message) || message.role !== "user") return "";
	const c = message.content;
	if (typeof c === "string") return collapse(c);
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const p of c) {
		if (isRecord(p) && p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return collapse(parts.join(" "));
}

async function parseFile(sessionFile: string, mtimeMs: number | undefined, maxHeadBytes: number): Promise<Parsed | null> {
	let head: string;
	let truncated: boolean;
	let mtime: number;
	try {
		const fh = await open(sessionFile, "r");
		try {
			const st = await fh.stat();
			if (!st.isFile()) return null;
			mtime = mtimeMs ?? st.mtimeMs;
			const buf = Buffer.alloc(Math.min(st.size, maxHeadBytes));
			let got = 0;
			while (got < buf.length) {
				const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
				if (bytesRead === 0) break;
				got += bytesRead;
			}
			truncated = st.size > got;
			head = buf.toString("utf8", 0, got);
		} finally {
			await fh.close();
		}
	} catch {
		return null;
	}

	const lines = head.split("\n");
	// A truncated head ends mid-line; drop the partial segment.
	if (truncated) lines.pop();

	let slotTitle = "";
	let header: Record<string, unknown> | null = null;
	let firstUser = "";
	let sawMessage = false;

	for (const line of lines) {
		if (line.charCodeAt(0) !== 123 /* { */) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(obj)) continue;
		if (obj.type === "title") {
			if (header === null && !slotTitle) slotTitle = cleanTitle(obj.title);
		} else if (obj.type === "session") {
			header ??= obj;
		} else if (obj.type === "message" && header !== null) {
			sawMessage = true;
			if (!firstUser) firstUser = userText(obj.message);
		}
		if (header !== null && sawMessage && firstUser) break;
	}

	if (header === null || typeof header.cwd !== "string") return null;
	const cwd = header.cwd;
	const title =
		slotTitle || cleanTitle(header.title) || (firstUser ? clip(firstUser) : "") || basename(cwd) || cwd;

	const info: RecentInfo = { sid: sidForFile(sessionFile), sessionFile, cwd, title, mtimeMs: mtime };
	if (typeof header.id === "string" && header.id) info.sessionId = header.id;
	// No message in the head: only "empty" if we actually saw the whole file.
	return { info, empty: !sawMessage && !truncated };
}

/** Reads just title+cwd of one file (same parsing as listRecentSessions); null when unreadable or not a session file. */
export async function readSessionInfo(sessionFile: string, maxHeadBytes: number = DEFAULT_HEAD_BYTES): Promise<RecentInfo | null> {
	const parsed = await parseFile(sessionFile, undefined, maxHeadBytes);
	return parsed ? parsed.info : null;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

async function listDir(dir: string): Promise<{ jsonl: string[]; dirs: string[] }> {
	const jsonl: string[] = [];
	const dirs: string[] = [];
	try {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			let isDir = e.isDirectory();
			if (e.isSymbolicLink()) isDir = await stat(join(dir, e.name)).then((s) => s.isDirectory(), () => false);
			if (isDir) dirs.push(join(dir, e.name));
			else if (e.name.endsWith(".jsonl")) jsonl.push(join(dir, e.name));
		}
	} catch {
		// missing or unreadable directory: nothing to list
	}
	return { jsonl, dirs };
}

export async function listRecentSessions(opts: {
	sessionsDir: string;
	limit: number;
	excludeFiles?: ReadonlySet<string>;
	maxHeadBytes?: number;
}): Promise<RecentInfo[]> {
	const { sessionsDir, limit, excludeFiles } = opts;
	const maxHead = opts.maxHeadBytes ?? DEFAULT_HEAD_BYTES;
	if (limit <= 0) return [];

	const top = await listDir(sessionsDir);
	const nested = await mapLimit(top.dirs, STAT_CONCURRENCY, async (dir) => (await listDir(dir)).jsonl);
	const candidates = [...top.jsonl, ...nested.flat()].filter((f) => !excludeFiles?.has(f));

	const stats = await mapLimit(candidates, STAT_CONCURRENCY, async (file) => {
		try {
			const st = await stat(file);
			return st.isFile() ? { file, mtimeMs: st.mtimeMs } : null;
		} catch {
			return null;
		}
	});
	const sorted = stats
		.filter((s): s is { file: string; mtimeMs: number } => s !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

	const result: RecentInfo[] = [];
	for (const { file, mtimeMs } of sorted) {
		if (result.length >= limit) break;
		const parsed = await parseFile(file, mtimeMs, maxHead);
		if (parsed && !parsed.empty) result.push(parsed.info);
	}
	return result;
}
