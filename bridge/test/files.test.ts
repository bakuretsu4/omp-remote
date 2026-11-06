import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MAX_PLAINTEXT } from "../../protocol/src/index.ts";
import { OpError } from "../src/errors.ts";
import { FS_READ_DEFAULT, FS_READ_MAX, GIT_DIFF_MAX, fsRead, gitAvailable, gitDiff, gitStatus, parseStatus } from "../src/files.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-files-")));
const root = join(tmp, "root");
const outside = join(tmp, "outside");
const roots = [root];
const hasGit = await gitAvailable();

before(() => {
	mkdirSync(root);
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "top secret\n");
});
after(() => rmSync(tmp, { recursive: true, force: true }));

async function rejects(p: Promise<unknown>, code: string, msg?: RegExp): Promise<void> {
	const e = await p.then(() => assert.fail("expected rejection"), (x: unknown) => x);
	assert.ok(e instanceof OpError, `OpError, got ${String(e)}`);
	assert.equal(e.code, code, e.message);
	if (msg) assert.match(e.message, msg);
}

describe("fs.read", () => {
	it("returns text, the real path and the size", async () => {
		writeFileSync(join(root, "hello.txt"), "héllo\nworld\n");
		const r = await fsRead(join(root, "hello.txt"), undefined, roots);
		assert.deepEqual(r, { path: join(root, "hello.txt"), size: 13, truncated: false, binary: false, text: "héllo\nworld\n" });
	});

	it("refuses paths outside the roots, `..` escapes and symlinks that leave the roots", async () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
		symlinkSync(outside, join(root, "link-dir"));
		await rejects(fsRead(join(outside, "secret.txt"), undefined, roots), "forbidden_path");
		await rejects(fsRead(join(root, "..", "outside", "secret.txt"), undefined, roots), "forbidden_path");
		await rejects(fsRead(join(root, "link-file"), undefined, roots), "forbidden_path");
		await rejects(fsRead(join(root, "link-dir", "secret.txt"), undefined, roots), "forbidden_path");
		await rejects(fsRead(join(root, "missing.txt"), undefined, roots), "forbidden_path");
	});

	it("follows a symlink that stays inside the roots", async () => {
		symlinkSync(join(root, "hello.txt"), join(root, "inner-link"));
		const r = await fsRead(join(root, "inner-link"), undefined, roots);
		assert.equal(r.path, join(root, "hello.txt"));
		assert.equal(r.text, "héllo\nworld\n");
	});

	it("reports binary files without text: NUL bytes or invalid UTF-8", async () => {
		writeFileSync(join(root, "nul.bin"), Buffer.from([0x68, 0x69, 0x00, 0x21]));
		writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		for (const name of ["nul.bin", "latin1.txt"]) {
			const r = await fsRead(join(root, name), undefined, roots);
			assert.equal(r.binary, true, name);
			assert.equal(r.truncated, false);
			assert.equal("text" in r, false);
		}
		assert.equal((await fsRead(join(root, "nul.bin"), undefined, roots)).size, 4);
	});

	it("truncates at the default and at the hard cap, and at an explicit smaller maxBytes", async () => {
		writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));
		const d = await fsRead(join(root, "big.txt"), undefined, roots);
		assert.equal(d.text?.length, FS_READ_DEFAULT);
		assert.equal(d.truncated, true);
		assert.equal(d.size, 300 * 1024);
		const m = await fsRead(join(root, "big.txt"), 10 * 1024 * 1024, roots);
		assert.equal(m.text?.length, FS_READ_MAX);
		assert.equal(m.truncated, true);
		const s = await fsRead(join(root, "big.txt"), 10, roots);
		assert.equal(s.text, "x".repeat(10));
		writeFileSync(join(root, "exact.txt"), "y".repeat(100));
		assert.equal((await fsRead(join(root, "exact.txt"), 100, roots)).truncated, false);
	});

	it("never ends a truncated text in the middle of a multi-byte character", async () => {
		writeFileSync(join(root, "euro.txt"), "€".repeat(100)); // 3 bytes each
		const r = await fsRead(join(root, "euro.txt"), 100, roots); // 100 bytes = 33 chars + 1 stray byte
		assert.equal(r.binary, false);
		assert.equal(r.text, "€".repeat(33));
		assert.equal(r.truncated, true);
	});

	it("keeps the JSON reply inside one channel frame even when escaping inflates the text", async () => {
		writeFileSync(join(root, "ctrl.txt"), "\u0001".repeat(FS_READ_MAX)); // each char becomes the 6-byte escape \u0001
		const r = await fsRead(join(root, "ctrl.txt"), FS_READ_MAX, roots);
		const wire = Buffer.byteLength(JSON.stringify({ t: "res", id: 1, ok: true, d: r }));
		assert.ok(wire < MAX_PLAINTEXT, `reply is ${wire} bytes`);
		assert.equal(r.truncated, true);
		assert.ok((r.text?.length ?? 0) > 1000);
		assert.equal(r.text, "\u0001".repeat(r.text?.length ?? 0));
	});

	it("rejects non-regular files (a FIFO must not hang the open) and bad maxBytes", async () => {
		mkdirSync(join(root, "dir"));
		execFileSync("mkfifo", [join(root, "pipe")]);
		await rejects(fsRead(join(root, "dir"), undefined, roots), "invalid", /not a regular file/);
		await rejects(fsRead(join(root, "pipe"), undefined, roots), "invalid", /not a regular file/);
		for (const bad of [0, -1, 1.5, "10", null]) await rejects(fsRead(join(root, "hello.txt"), bad, roots), "invalid", /maxBytes/);
	});
});

// ─────────────────────────────────── git ───────────────────────────────────

const SETUP_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

/** Runs git for fixture setup, in a clean config environment. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: SETUP_ENV, encoding: "utf8" });
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	git(dir, "init", "-q");
	return dir;
}

describe("parseStatus", () => {
	it("decodes branch headers, renames and cut output", () => {
		const raw = "## main...origin/main [ahead 1]\0 M a.txt\0R  new.txt\0old.txt\0?? c d.txt\0";
		assert.deepEqual(parseStatus(raw, false), { root: "", branch: "main", files: [{ path: "a.txt", status: " M" }, { path: "new.txt", status: "R " }, { path: "c d.txt", status: "??" }] });
		assert.equal(parseStatus("## No commits yet on dev\0", false).branch, "dev");
		assert.equal(parseStatus("## HEAD (no branch)\0", false).branch, null);
		const cut = parseStatus("## main\0 M a.txt\0 M b.t", true);
		assert.deepEqual(cut.files, [{ path: "a.txt", status: " M" }]);
		assert.equal(cut.truncated, true);
	});
});

describe("git.status", { skip: !hasGit }, () => {
	it("lists modified, staged, renamed and untracked files with the branch and root", async () => {
		const repo = makeRepo("status");
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "old.txt"), "to be renamed\nwith some more lines\nso git sees a rename\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "init");
		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		git(repo, "mv", "old.txt", "new.txt");
		writeFileSync(join(repo, "weird name.txt"), "x");
		writeFileSync(join(repo, "staged.txt"), "s");
		git(repo, "add", "staged.txt");
		mkdirSync(join(repo, "sub"));
		const res = await gitStatus(join(repo, "sub"), roots); // asked from a subdirectory
		assert.equal(res.root, repo);
		assert.equal(res.branch, "main");
		assert.deepEqual(Object.fromEntries(res.files.map(f => [f.path, f.status])), {
			"a.txt": " M", "new.txt": "R ", "staged.txt": "A ", "weird name.txt": "??",
		});
	});

	it("reports a clean fresh repository (no commits yet)", async () => {
		const repo = makeRepo("fresh");
		assert.deepEqual(await gitStatus(repo, roots), { root: repo, branch: "main", files: [] });
	});

	it("says `not a git repository` for a plain directory, and refuses files and paths outside the roots", async () => {
		mkdirSync(join(root, "plain"));
		await rejects(gitStatus(join(root, "plain"), roots), "invalid", /not a git repository/);
		await rejects(gitStatus(join(root, "hello.txt"), roots), "invalid", /not a directory/);
		await rejects(gitStatus(outside, roots), "forbidden_path");
		await rejects(gitStatus(join(root, "link-dir"), roots), "forbidden_path");
	});

	it("refuses a repository whose work tree root lies outside the allowed roots", async () => {
		const repo = makeRepo("wide");
		mkdirSync(join(repo, "inner"));
		await rejects(gitStatus(join(repo, "inner"), [join(repo, "inner")]), "forbidden_path", /repository root is outside/);
	});

	it("cuts an enormous listing and says so", async () => {
		const repo = makeRepo("many");
		const pad = "p".repeat(150);
		for (let i = 0; i < 1500; i++) writeFileSync(join(repo, `${pad}-${i}.txt`), "");
		const res = await gitStatus(repo, roots);
		assert.equal(res.truncated, true);
		assert.ok(res.files.length > 100 && res.files.length < 1500);
		assert.ok(res.files.every(f => f.path.length > 0 && f.status === "??"));
	});
});

describe("git.diff", { skip: !hasGit }, () => {
	let repo: string;
	before(() => {
		repo = makeRepo("diff");
		mkdirSync(join(repo, "sub"));
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "sub", "b.txt"), "bee\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "init");
		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "sub", "b.txt"), "bee\nbop\n");
		git(repo, "add", "sub/b.txt");
		writeFileSync(join(repo, "sub", "b.txt"), "bee\nbop\nbup\n");
	});

	it("returns the unstaged diff, the staged diff, and a per-file diff with root-relative paths", async () => {
		const all = await gitDiff(repo, undefined, undefined, roots);
		assert.equal(all.truncated, false);
		assert.match(all.diff, /^diff --git a\/a\.txt b\/a\.txt/m);
		assert.match(all.diff, /^\+two$/m);
		assert.match(all.diff, /^\+bup$/m);
		assert.doesNotMatch(all.diff, /^\+bop$/m);
		const staged = await gitDiff(repo, undefined, true, roots);
		assert.match(staged.diff, /^\+bop$/m);
		assert.doesNotMatch(staged.diff, /^\+two$/m);
		const one = await gitDiff(join(repo, "sub"), "sub/b.txt", false, roots); // asked from a subdirectory: file stays root-relative
		assert.match(one.diff, /^\+bup$/m);
		assert.doesNotMatch(one.diff, /a\.txt/);
		const abs = await gitDiff(repo, join(repo, "a.txt"), undefined, roots); // absolute but inside the repo
		assert.match(abs.diff, /^\+two$/m);
		assert.equal((await gitDiff(repo, "sub/b.txt", true, roots)).diff.includes("a.txt"), false);
	});

	it("treats file as a literal path, never as a glob or pathspec magic", async () => {
		assert.equal((await gitDiff(repo, "*.txt", undefined, roots)).diff, "");
		assert.equal((await gitDiff(repo, ":(top)a.txt", undefined, roots)).diff, "");
	});

	it("rejects file paths that leave the repository", async () => {
		symlinkSync(outside, join(repo, "escape"));
		await rejects(gitDiff(repo, "../secret.txt", undefined, roots), "forbidden_path");
		await rejects(gitDiff(repo, "sub/../../x", undefined, roots), "forbidden_path");
		await rejects(gitDiff(repo, join(outside, "secret.txt"), undefined, roots), "forbidden_path");
		await rejects(gitDiff(repo, "/etc/passwd", undefined, roots), "forbidden_path");
		await rejects(gitDiff(repo, "escape/secret.txt", undefined, roots), "forbidden_path");
		await rejects(gitDiff(repo, ".", undefined, roots), "invalid", /inside the repository/);
		await rejects(gitDiff(repo, "", undefined, roots), "invalid");
		await rejects(gitDiff(repo, "a\0b", undefined, roots), "invalid");
		await rejects(gitDiff(repo, 7, undefined, roots), "invalid");
		await rejects(gitDiff(repo, "a.txt", "yes", roots), "invalid", /staged/);
	});

	it("rejects non-repositories and paths outside the roots", async () => {
		await rejects(gitDiff(join(root, "plain"), undefined, undefined, roots), "invalid", /not a git repository/);
		await rejects(gitDiff(outside, undefined, undefined, roots), "forbidden_path");
	});

	it("caps the output at 200 KiB and flags it", async () => {
		const big = makeRepo("bigdiff");
		writeFileSync(join(big, "f.txt"), "a\n");
		git(big, "add", "-A");
		git(big, "commit", "-qm", "init");
		writeFileSync(join(big, "f.txt"), "line of text to make the diff large\n".repeat(20_000));
		const r = await gitDiff(big, undefined, undefined, roots);
		assert.equal(r.truncated, true);
		assert.ok(Buffer.byteLength(r.diff) <= GIT_DIFF_MAX);
		assert.ok(r.diff.length > 100_000);
		assert.ok(Buffer.byteLength(JSON.stringify({ t: "res", id: 1, ok: true, d: r })) < MAX_PLAINTEXT);
	});
});

describe("hostile repository configuration", { skip: !hasGit }, () => {
	const marks = join(tmp, "marks");
	let repo: string;
	const marker = (name: string): string => join(marks, name);
	const fired = (): string[] => ["fsmonitor", "external", "textconv", "clean", "process", "pager"].filter(n => existsSync(marker(n)));
	const resetMarks = (): void => {
		rmSync(marks, { recursive: true, force: true });
		mkdirSync(marks);
	};

	before(() => {
		mkdirSync(marks);
		repo = makeRepo("hostile");
		// Programs a malicious config would run. Each records that it ran, and answers like a well-behaved tool.
		const prog = (name: string, body: string): string => {
			const p = join(tmp, `${name}.sh`);
			writeFileSync(p, `#!/bin/sh\n: > ${JSON.stringify(marker(name))}\n${body}\n`);
			chmodSync(p, 0o755);
			return p;
		};
		writeFileSync(join(repo, ".gitattributes"), "*.txt diff=y filter=x\n");
		writeFileSync(join(repo, "a.txt"), "aaaa\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "init");
		const set = (k: string, v: string): string => git(repo, "config", k, v);
		set("core.fsmonitor", prog("fsmonitor", "exit 0"));
		set("diff.external", prog("external", "exit 0"));
		set("diff.y.textconv", prog("textconv", 'cat "$1"'));
		set("filter.x.clean", prog("clean", "cat"));
		set("filter.x.process", prog("process", "exit 1"));
		set("core.pager", prog("pager", "cat"));
		// Same size, newer mtime: git must look at the content, which makes it run the clean filter.
		writeFileSync(join(repo, "a.txt"), "bbbb\n");
		utimesSync(join(repo, "a.txt"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
	});

	it("control: plain git does run the repository's programs (so the checks below can fail)", () => {
		resetMarks();
		execFileSync("git", ["status", "--porcelain"], { cwd: repo, env: SETUP_ENV, stdio: "ignore" });
		execFileSync("git", ["diff"], { cwd: repo, env: SETUP_ENV, stdio: "ignore" });
		execFileSync("git", ["diff", "--no-ext-diff"], { cwd: repo, env: SETUP_ENV, stdio: "ignore" });
		const ran = fired();
		for (const n of ["fsmonitor", "external", "textconv", "process"]) assert.ok(ran.includes(n), `${n} should have run; ran: ${ran.join(",")}`);
	});

	it("git.status and git.diff (plain, staged, per file) execute none of them", async () => {
		resetMarks();
		const st = await gitStatus(repo, roots);
		assert.deepEqual(st.files, [{ path: "a.txt", status: " M" }]);
		assert.match((await gitDiff(repo, undefined, undefined, roots)).diff, /^\+bbbb$/m);
		assert.match((await gitDiff(repo, "a.txt", undefined, roots)).diff, /^\+bbbb$/m);
		await gitDiff(repo, undefined, true, roots);
		assert.deepEqual(fired(), []);
	});

	it("also neutralises a filter defined in an included config file under an odd name", async () => {
		resetMarks();
		const prog = join(tmp, "included-clean.sh");
		writeFileSync(prog, `#!/bin/sh\n: > ${JSON.stringify(marker("clean"))}\ncat\n`);
		chmodSync(prog, 0o755);
		const inc = join(tmp, "included.cfg");
		writeFileSync(inc, `[filter "we.ird"]\n\tclean = ${prog}\n`);
		git(repo, "config", "include.path", inc);
		writeFileSync(join(repo, ".git", "info", "attributes"), "*.txt filter=we.ird\n");
		writeFileSync(join(repo, "a.txt"), "cccc\n");
		utimesSync(join(repo, "a.txt"), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
		execFileSync("git", ["-c", "filter.x.process=", "status", "--porcelain"], { cwd: repo, env: SETUP_ENV, stdio: "ignore" });
		assert.ok(fired().includes("clean"), "control: plain git runs the included clean filter");
		resetMarks();
		await gitStatus(repo, roots);
		await gitDiff(repo, undefined, undefined, roots);
		assert.deepEqual(fired(), []);
	});
});
