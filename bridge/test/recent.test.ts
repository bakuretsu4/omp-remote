import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listRecentSessions, readSessionInfo, sidForFile } from "../src/recent.ts";

const j = (o: unknown): string => `${JSON.stringify(o)}\n`;
const header = (id: string, cwd: string, title?: string): string =>
	j({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd, ...(title ? { title } : {}) });
const userMsg = (content: unknown): string =>
	j({ type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "user", content } });
function titleSlot(title: string): string {
	const base = { type: "title", v: 1, title, source: "auto", updatedAt: "2026-01-01T00:00:00Z" };
	const bare = JSON.stringify({ ...base, pad: "" });
	const line = JSON.stringify({ ...base, pad: " ".repeat(255 - Buffer.byteLength(bare)) });
	return `${line}\n`;
}

let root: string;
async function put(rel: string, content: string, mtimeSec?: number): Promise<string> {
	const p = join(root, rel);
	await mkdir(join(p, ".."), { recursive: true });
	await writeFile(p, content);
	if (mtimeSec !== undefined) await utimes(p, mtimeSec, mtimeSec);
	return p;
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "recent-test-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("sidForFile", () => {
	it("is stable, 13 chars, r_ prefixed, distinct per path", () => {
		const a = sidForFile("/a/b.jsonl");
		assert.equal(a, sidForFile("/a/b.jsonl"));
		assert.equal(a.length, 13);
		assert.match(a, /^r_[A-Za-z0-9_-]{11}$/);
		assert.notEqual(a, sidForFile("/a/c.jsonl"));
	});
});

describe("listRecentSessions", () => {
	it("returns [] for a missing dir", async () => {
		assert.deepEqual(await listRecentSessions({ sessionsDir: join(root, "nope"), limit: 5 }), []);
	});

	it("handles bucket, flat, legacy, empty, malformed, subagent dirs, exclusion, ordering, limit", async () => {
		const dir = join(root, "main");
		const t = 1_700_000_000;
		const slot = await put("main/-home-x/a_1.jsonl", titleSlot("Slot title") + header("id-a", "/home/x", "Hdr") + userMsg("hello"), t + 10);
		const legacy = await put("main/-home-y/b_2.jsonl", header("id-b", "/home/y") + userMsg([{ type: "text", text: "  fix\n the   bug  " }]), t + 40);
		const flat = await put("main/c_3.jsonl", header("id-c", "/srv/proj"), t + 50); // empty: header only
		const flat2 = await put("main/d_4.jsonl", header("id-d", "/srv/proj2") + userMsg("x"), t + 30);
		await put("main/-home-x/e_5.jsonl", "garbage\n\u0000\u0001binary\n{not json\n", t + 60);
		await put("main/-home-x/notes.txt", "x", t + 70);
		await put("main/-home-x/a_1/sub.jsonl", header("id-s", "/sub") + userMsg("sub"), t + 80); // subagent dir
		await put("main/-home-x/a_1/deeper/z.jsonl", header("id-z", "/z") + userMsg("z"), t + 90);
		const excluded = await put("main/-home-x/f_6.jsonl", header("id-f", "/f") + userMsg("f"), t + 100);

		const all = await listRecentSessions({ sessionsDir: dir, limit: 50, excludeFiles: new Set([excluded]) });
		assert.deepEqual(
			all.map((r) => r.sessionFile),
			[legacy, flat2, slot],
		);
		assert.equal(all[0]?.title, "fix the bug");
		assert.equal(all[0]?.cwd, "/home/y");
		assert.equal(all[0]?.sessionId, "id-b");
		assert.equal(all[0]?.sid, sidForFile(legacy));
		assert.equal(all[0]?.mtimeMs, (t + 40) * 1000);
		assert.equal(all[2]?.title, "Slot title");
		assert.ok(!all.some((r) => r.sessionFile === flat));

		const limited = await listRecentSessions({ sessionsDir: dir, limit: 2, excludeFiles: new Set([excluded]) });
		assert.deepEqual(limited.map((r) => r.sessionFile), [legacy, flat2]);
	});

	it("does not resolve symlinks", async () => {
		const real = await put("real/-r/x_1.jsonl", header("id-l", "/l") + userMsg("m"), 1_700_000_000);
		const linkDir = join(root, "linkroot");
		await mkdir(linkDir, { recursive: true });
		await symlink(join(root, "real", "-r"), join(linkDir, "-r"));
		const res = await listRecentSessions({ sessionsDir: linkDir, limit: 5 });
		assert.equal(res.length, 1);
		assert.equal(res[0]?.sessionFile, join(linkDir, "-r", "x_1.jsonl"));
		assert.notEqual(res[0]?.sessionFile, real);
	});
});

describe("title fallbacks and head handling", () => {
	it("falls back: slot -> header -> first user text -> cwd basename", async () => {
		const p1 = await put("t/1.jsonl", titleSlot("") + header("1", "/w/one", "Header T") + userMsg("u"));
		assert.equal((await readSessionInfo(p1))?.title, "Header T");
		const p2 = await put("t/2.jsonl", titleSlot("") + header("2", "/w/two") + userMsg("first words here"));
		assert.equal((await readSessionInfo(p2))?.title, "first words here");
		const long = "w ".repeat(100);
		const p3 = await put("t/3.jsonl", header("3", "/w/three") + userMsg(long));
		const t3 = (await readSessionInfo(p3))?.title ?? "";
		assert.ok(t3.length <= 80 && t3.startsWith("w w"));
		const p4 = await put("t/4.jsonl", header("4", "/w/four") + j({ type: "model_change", id: "x" }) + userMsg([{ type: "image" }]));
		assert.equal((await readSessionInfo(p4))?.title, "four");
	});

	it("readSessionInfo returns null for unreadable or non-session files", async () => {
		assert.equal(await readSessionInfo(join(root, "missing.jsonl")), null);
		const p = await put("t/junk.jsonl", "hello\nworld\n");
		assert.equal(await readSessionInfo(p), null);
		assert.equal(await readSessionInfo(root), null);
	});

	it("tolerates huge lines and a partial last line in the head", async () => {
		const huge = j({ type: "custom", blob: "x".repeat(300_000) });
		const p = await put("h/huge.jsonl", header("h", "/h") + huge + userMsg("late message"), 1_700_000_100);
		// Head too small to reach any message but file is larger: counts as non-empty.
		const res = await listRecentSessions({ sessionsDir: join(root, "h"), limit: 5, maxHeadBytes: 4096 });
		assert.equal(res.length, 1);
		assert.equal(res[0]?.sessionFile, p);
		assert.equal(res[0]?.title, "h");

		const partial = header("p", "/p") + userMsg("ok") + '{"type":"message","message":{"role":"user","conte';
		const p2 = await put("h2/part.jsonl", partial);
		assert.equal((await readSessionInfo(p2))?.title, "ok");
	});

	it("excludes header-only files even when head is small, but only if whole file seen", async () => {
		await put("e/empty.jsonl", titleSlot("T") + header("e", "/e"), 1_700_000_200);
		assert.deepEqual(await listRecentSessions({ sessionsDir: join(root, "e"), limit: 5 }), []);
	});
});
