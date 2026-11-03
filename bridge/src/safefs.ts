/**
 * Private-state file helpers: directories 0700, files 0600, atomic replace, realpath-under-roots checks.
 */
import {
	chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { forbiddenPath, invalid } from "./errors.ts";

/**
 * Creates `dir` (0700) if needed and makes sure it is a real directory (not a symlink) owned by us. A pre-existing
 * directory with looser permissions is tightened; a chmod failure is an error (never swallowed: this guards secrets).
 */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`${dir} is not a directory (symlinks are refused)`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} is not owned by the current user`);
	if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Startup check for the state directory: real directory, owned by us, mode exactly 0700. Throws otherwise. */
export function assertPrivateDir(dir: string): void {
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`state directory ${dir} is not a real directory (symlinks are refused)`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`state directory ${dir} is not owned by the current user`);
	if ((st.mode & 0o777) !== 0o700) throw new Error(`state directory ${dir} has mode ${(st.mode & 0o777).toString(8)}; run: chmod 700 ${dir}`);
}

export interface ModeCheck { path: string; ok: boolean; detail: string }

/** Permission audit used by `ompr doctor`: dir 0700, secret files 0600, ctl.sock 0600; ownership too. */
export function auditStateModes(dir: string, files: { path: string; want: number }[]): ModeCheck[] {
	const out: ModeCheck[] = [];
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	for (const f of [{ path: dir, want: 0o700 }, ...files]) {
		let st: Stats;
		try {
			st = lstatSync(f.path);
		} catch {
			continue; // not created yet
		}
		const mode = st.mode & 0o777;
		const problems: string[] = [];
		if (st.isSymbolicLink()) problems.push("is a symlink");
		if (mode !== f.want) problems.push(`mode ${mode.toString(8)}, want ${f.want.toString(8)}`);
		if (uid !== undefined && st.uid !== uid) problems.push("not owned by the current user");
		out.push({ path: f.path, ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `mode ${mode.toString(8)}` });
	}
	return out;
}

/** Atomic replace with mode 0600 (tmp file in the same directory + fsync + rename). */
export function writePrivateFile(file: string, data: string | Uint8Array): void {
	ensurePrivateDir(dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
		fsyncSync(fd);
	} catch (e) {
		closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// best effort
		}
		throw e;
	}
	closeSync(fd);
	renameSync(tmp, file);
}

export function readJsonIfExists(file: string): unknown {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	return JSON.parse(text);
}

/** `~`-expands and absolutizes; rejects NULs and non-strings. */
export function expandPath(p: unknown): string {
	if (typeof p !== "string" || p.length === 0 || p.length > 4096 || p.includes("\0")) throw invalid("path must be a non-empty string");
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return resolve(p);
}

export function isUnder(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Realpath every root once; roots that do not exist are dropped. */
export async function resolveRoots(roots: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const r of roots) {
		try {
			out.push(await realpath(expandPath(r)));
		} catch {
			// missing root: ignore
		}
	}
	return out;
}

/**
 * Resolves `p` through symlinks and `..` and requires the result to lie under one of `realRoots`
 * (already realpath'd). Throws `forbidden_path` otherwise, and also when the path does not exist, with
 * the same message so callers cannot probe the filesystem outside the roots.
 */
export async function realpathUnder(p: unknown, realRoots: string[]): Promise<string> {
	const abs = expandPath(p);
	let real: string;
	try {
		real = await realpath(abs);
	} catch {
		throw forbiddenPath("path is outside the allowed roots or does not exist");
	}
	if (!realRoots.some(r => isUnder(real, r))) throw forbiddenPath("path is outside the allowed roots or does not exist");
	return real;
}
