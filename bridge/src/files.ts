/**
 * `fs.read`, `git.status`, `git.diff`: read-only views of files and repositories under the configured roots.
 *
 * Every path from the phone goes through `realpathUnder`. Git is spawned with execFile and fixed argv (no shell), a
 * scrubbed environment, and with every repository-controlled way of running a program neutralised (fsmonitor, pager,
 * external diff, textconv, clean/smudge filters, submodule recursion). Output is capped in bytes and in time, and text
 * is cut so the JSON reply always fits one channel frame.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FsReadResult, GitStatusResult } from "../../protocol/src/index.ts";
import { OpError, forbiddenPath, invalid, unsupported } from "./errors.ts";
import { isUnder, realpathUnder } from "./safefs.ts";

export const FS_READ_DEFAULT = 128 * 1024;
export const FS_READ_MAX = 256 * 1024;
export const GIT_DIFF_MAX = 200 * 1024;
export const GIT_STATUS_MAX = 200 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const GIT_CONFIG_MAX = 1024 * 1024;
const BINARY_SNIFF = 8 * 1024;
/** Cap on the JSON-encoded size of one reply; MAX_PLAINTEXT is 512 KiB and the res envelope is tiny. */
const REPLY_BUDGET = 400_000;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes UTF-8; when `cut`, a multi-byte sequence split by the cut is dropped. Null when the bytes are not UTF-8. */
function decodeUtf8(buf: Uint8Array, cut: boolean): string | null {
	for (let drop = 0; drop <= (cut ? 3 : 0); drop++) {
		try {
			return utf8.decode(buf.subarray(0, buf.length - drop));
		} catch {
			// try shorter
		}
	}
	return null;
}

/** Cuts `s` (on a code point boundary) until its JSON string encoding fits `budget` bytes. */
function fitJson(s: string, budget: number): { text: string; cut: boolean } {
	let text = s;
	let cut = false;
	for (;;) {
		const size = Buffer.byteLength(JSON.stringify(text));
		if (size <= budget || text.length === 0) return { text, cut };
		let n = Math.floor(text.length * (budget / size) * 0.95);
		if (n > 0 && (text.charCodeAt(n - 1) & 0xfc00) === 0xd800) n--;
		text = text.slice(0, n);
		cut = true;
	}
}

// ───────────────────────────────── fs.read ─────────────────────────────────

export async function fsRead(path: unknown, maxBytes: unknown, roots: string[]): Promise<FsReadResult> {
	let cap = FS_READ_DEFAULT;
	if (maxBytes !== undefined) {
		if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1) throw invalid("maxBytes must be a positive integer");
		cap = Math.min(maxBytes, FS_READ_MAX);
	}
	const real = await realpathUnder(path, roots);
	// O_NONBLOCK: a FIFO inside the roots must not hang the open; O_NOFOLLOW: the path was just resolved, never follow a swapped-in link.
	let fh;
	try {
		fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch {
		throw invalid("file cannot be opened");
	}
	try {
		const st = await fh.stat();
		if (!st.isFile()) throw invalid("not a regular file");
		const buf = Buffer.allocUnsafe(Math.min(cap, st.size));
		let got = 0;
		while (got < buf.length) {
			const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
			if (bytesRead === 0) break;
			got += bytesRead;
		}
		const data = buf.subarray(0, got);
		const truncated = st.size > got;
		if (data.subarray(0, BINARY_SNIFF).includes(0)) return { path: real, size: st.size, truncated: false, binary: true };
		const decoded = decodeUtf8(data, truncated);
		if (decoded === null) return { path: real, size: st.size, truncated: false, binary: true };
		const head = { path: real, size: st.size };
		const fit = fitJson(decoded, REPLY_BUDGET - Buffer.byteLength(JSON.stringify({ ...head, truncated: true, binary: false, text: "" })));
		return { ...head, truncated: truncated || fit.cut, binary: false, text: fit.text };
	} finally {
		await fh.close();
	}
}

// ─────────────────────────────────── git ───────────────────────────────────

interface GitOut { stdout: Buffer; truncated: boolean }

const GIT_ENV: NodeJS.ProcessEnv = {
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: homedir(),
	LC_ALL: "C",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_LITERAL_PATHSPECS: "1",
};

const GIT_BASE = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "color.ui=never", "--no-pager"];

/** Runs git with fixed argv. Output beyond `max` bytes is cut (and flagged), a failing exit becomes an OpError. */
function runGit(cwd: string, args: string[], max: number, overrides: string[] = []): Promise<GitOut> {
	const { promise, resolve, reject } = Promise.withResolvers<GitOut>();
	execFile(
		"git", [...GIT_BASE, ...overrides, ...args],
		{ cwd, env: GIT_ENV, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: max, encoding: "buffer", windowsHide: true },
		(err, stdout, stderr) => {
			if (!err) return resolve({ stdout, truncated: false });
			const e = err as Error & { code?: string | number; killed?: boolean };
			if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ stdout: stdout.subarray(0, max), truncated: true });
			if (e.code === "ENOENT") return reject(unsupported("git is not installed on this PC"));
			if (e.killed) return reject(new OpError("timeout", `git did not finish within ${GIT_TIMEOUT_MS / 1000} s`));
			reject(gitFailure(stderr.toString("utf8")));
		},
	);
	return promise;
}

function gitFailure(stderr: string): OpError {
	if (/not a git repository/i.test(stderr)) return invalid("not a git repository");
	if (/dubious ownership/i.test(stderr)) return invalid("git refuses this repository (it is owned by another user)");
	if (/must be run in a work tree/i.test(stderr)) return invalid("not a git work tree (bare repository?)");
	const line = (stderr.split("\n").find(l => l.trim().length > 0) ?? "git failed").trim().slice(0, 200);
	return invalid(`git: ${line}`);
}

export async function gitAvailable(): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	execFile("git", ["--version"], { env: GIT_ENV, timeout: 10_000, windowsHide: true }, err => resolve(!err));
	return promise;
}

/**
 * Overrides that switch off every clean/smudge/process filter the repository's own config defines (git runs them to
 * compare the work tree with the index). Only repository-local scopes are touched: the user's global filters (git-lfs)
 * stay in force because the user, not the repository, configured them.
 */
async function filterOverrides(cwd: string): Promise<string[]> {
	const { stdout } = await runGit(cwd, ["config", "--list", "-z", "--show-scope", "--includes"], GIT_CONFIG_MAX);
	const parts = stdout.toString("utf8").split("\0");
	const names = new Set<string>();
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const scope = parts[i];
		if (scope !== "local" && scope !== "worktree") continue;
		const m = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(parts[i + 1].split("\n", 1)[0]);
		if (m) names.add(m[1]);
	}
	const out: string[] = [];
	for (const name of names) {
		if (name.includes("=") || name.includes("\n")) throw invalid("this repository's git filter configuration is not supported");
		for (const k of ["clean", "smudge", "process"]) out.push("-c", `filter.${name}.${k}=`);
		out.push("-c", `filter.${name}.required=false`);
	}
	return out;
}

interface Repo { cwd: string; root: string; overrides: string[] }

/** Validates `path` (a directory under the roots), finds its repository and requires the work tree root to be under the roots too. */
async function openRepo(path: unknown, roots: string[]): Promise<Repo> {
	const cwd = await realpathUnder(path, roots);
	if (!(await stat(cwd)).isDirectory()) throw invalid("not a directory");
	const top = (await runGit(cwd, ["rev-parse", "--show-toplevel"], 8192)).stdout.toString("utf8").replace(/\n$/, "");
	let root: string;
	try {
		root = await realpathUnder(top, roots);
	} catch {
		throw forbiddenPath("the repository root is outside the allowed roots");
	}
	return { cwd, root, overrides: await filterOverrides(cwd) };
}

const STATUS_HEAD = /^## (?:No commits yet on |Initial commit on )?(.*?)(?:\.\.\.| \[|$)/;

/** Parses `git status --porcelain=v1 -b -z` output. Exported for tests. */
export function parseStatus(raw: string, truncated: boolean): GitStatusResult {
	const recs = raw.split("\0");
	if (truncated) recs.pop(); // the last record may be cut
	let branch: string | null = null;
	const files: { path: string; status: string }[] = [];
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i];
		if (r.length === 0) continue;
		if (i === 0 && r.startsWith("## ")) {
			const name = STATUS_HEAD.exec(r)?.[1] ?? "";
			branch = name === "" || name.startsWith("HEAD (no branch)") ? null : name;
			continue;
		}
		if (r.length < 4 || r[2] !== " ") continue;
		const status = r.slice(0, 2);
		files.push({ path: r.slice(3), status });
		if (status.includes("R") || status.includes("C")) i++; // the next record is the original path
	}
	return { root: "", branch, files, ...(truncated ? { truncated: true } : {}) };
}

export async function gitStatus(path: unknown, roots: string[]): Promise<GitStatusResult> {
	const repo = await openRepo(path, roots);
	const out = await runGit(
		repo.cwd, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal", "--ignore-submodules=all"],
		GIT_STATUS_MAX, repo.overrides,
	);
	const res = parseStatus(out.stdout.toString("utf8"), out.truncated);
	res.root = repo.root;
	return res;
}

/** Resolves a repo-relative (or absolute, but inside the repo) `file` to a root-relative path; throws when it escapes the root. */
async function repoRelative(file: unknown, root: string): Promise<string> {
	if (typeof file !== "string" || file.length === 0 || file.length > 4096 || file.includes("\0")) throw invalid("file must be a non-empty path");
	const abs = resolve(root, file);
	if (!isUnder(abs, root)) throw forbiddenPath("file is outside the repository");
	// A symlinked directory on the way must not lead out of the repo either (git refuses such paths; do not rely on that).
	let probe = abs;
	for (;;) {
		try {
			if (!isUnder(await realpath(probe), root)) throw forbiddenPath("file is outside the repository");
			break;
		} catch (e) {
			if (e instanceof OpError) throw e;
			const parent = resolve(probe, "..");
			if (parent === probe) break;
			probe = parent;
		}
	}
	const rel = relative(root, abs);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid("file must name a path inside the repository");
	return rel;
}

export async function gitDiff(path: unknown, file: unknown, staged: unknown, roots: string[]): Promise<{ diff: string; truncated: boolean }> {
	if (staged !== undefined && typeof staged !== "boolean") throw invalid("staged must be a boolean");
	const repo = await openRepo(path, roots);
	const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];
	if (staged) args.push("--cached");
	args.push("--");
	if (file !== undefined) args.push(await repoRelative(file, repo.root));
	// cwd = the repository root: pathspecs are relative to it, exactly as `git.status` reports them.
	const out = await runGit(repo.root, args, GIT_DIFF_MAX, repo.overrides);
	const text = out.stdout.toString("utf8");
	const fit = fitJson(text, REPLY_BUDGET - 64);
	return { diff: fit.text, truncated: out.truncated || fit.cut };
}
