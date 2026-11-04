import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSyncableProjectDir, planSessionSync, type SessionFileStat } from "../src/sync.ts";

const f = (name: string, size: number, mtimeSec: number, sid = name): SessionFileStat => ({
	relPath: `-proj/2026-11-04T00-00-00-000Z_${name}.jsonl`,
	sessionId: sid,
	size,
	mtimeSec,
	hasArtifactDir: false,
});
const none = new Set<string>();

describe("planSessionSync", () => {
	it("pushes sessions only the local side has and pulls ones only the peer has", () => {
		const plan = planSessionSync([f("a", 10, 1)], [f("b", 10, 1)], none, none);
		assert.deepEqual(plan.toPush.map(s => s.sessionId), ["a"]);
		assert.deepEqual(plan.toPull.map(s => s.sessionId), ["b"]);
	});

	it("lets the longer transcript win, breaking size ties by mtime", () => {
		const plan = planSessionSync(
			[f("grew-local", 20, 5), f("grew-remote", 10, 5), f("tie-newer-remote", 10, 1), f("same", 10, 5)],
			[f("grew-local", 10, 9), f("grew-remote", 20, 1), f("tie-newer-remote", 10, 2), f("same", 10, 5)],
			none,
			none,
		);
		assert.deepEqual(plan.toPush.map(s => s.sessionId), ["grew-local"]);
		assert.deepEqual(plan.toPull.map(s => s.sessionId).sort(), ["grew-remote", "tie-newer-remote"]);
	});

	it("never overwrites a session the peer currently holds, even when local looks bigger", () => {
		const plan = planSessionSync([f("a", 99, 9)], [f("a", 10, 1)], none, new Set(["a"]));
		assert.deepEqual(plan.toPush, []);
		assert.deepEqual(plan.toPull, []);
	});

	it("never overwrites a session held locally, even when the peer copy looks bigger", () => {
		const plan = planSessionSync([f("a", 10, 1)], [f("a", 99, 9)], new Set(["a"]), none);
		assert.deepEqual(plan.toPush, []);
		assert.deepEqual(plan.toPull, []);
	});

	it("still pulls a peer-held session this PC has never seen, so the phone can see it", () => {
		const plan = planSessionSync([], [f("a", 10, 1)], none, new Set(["a"]));
		assert.deepEqual(plan.toPull.map(s => s.sessionId), ["a"]);
	});

	it("skips a session both sides claim to hold", () => {
		const plan = planSessionSync([f("a", 99, 9)], [f("a", 10, 1)], new Set(["a"]), new Set(["a"]));
		assert.deepEqual(plan, { toPush: [], toPull: [] });
	});

	it("derives the session id from the file name when the stat omits it", () => {
		const local: SessionFileStat = { ...f("abcdef12-0000-0000-0000-000000000000", 99, 9), sessionId: undefined };
		const plan = planSessionSync([local], [f("abcdef12-0000-0000-0000-000000000000", 10, 1)], new Set(["abcdef12-0000-0000-0000-000000000000"]), none);
		assert.deepEqual(plan.toPull, []);
		assert.equal(plan.toPush.length, 1);
	});
});

describe("isSyncableProjectDir", () => {
	const home = "/home/u";
	const roots = [home];

	it("accepts a project folder under a root", () => {
		assert.equal(isSyncableProjectDir("/home/u/code/app", roots, home), true);
		assert.equal(isSyncableProjectDir("/home/u/code", roots, home), true);
	});

	it("refuses a root itself, $HOME, and the shared temp directories", () => {
		assert.equal(isSyncableProjectDir("/home/u", roots, home), false);
		assert.equal(isSyncableProjectDir("/tmp", ["/tmp"], home), false);
		assert.equal(isSyncableProjectDir("/", ["/"], home), false);
	});

	it("refuses hidden directories under $HOME, at any depth", () => {
		for (const d of ["/home/u/.ssh", "/home/u/.config/ompr", "/home/u/.omp/agent", "/home/u/code/.git-stuff", "/home/u/.local/share/x"]) {
			assert.equal(isSyncableProjectDir(d, roots, home), false, d);
		}
	});

	it("refuses folders outside every root and `..` escapes", () => {
		assert.equal(isSyncableProjectDir("/etc", roots, home), false);
		assert.equal(isSyncableProjectDir("/home/u/code/../../other", roots, home), false);
		assert.equal(isSyncableProjectDir("/home/user2/app", roots, home), false);
	});
});
