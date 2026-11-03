import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AttentionInbox, INBOX_LIMIT } from "../src/attention.ts";
import type { SessionBackend } from "../src/backend.ts";
import { SessionRegistry } from "../src/sessions.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-att-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const n = (kind: "approval" | "question" | "done" | "error" | "limit", sid = "s1", summary = "x", uiReqId?: string) => ({
	sid, sessionTitle: "T", kind, summary, ...(uiReqId ? { uiReqId } : {}),
});

describe("attention inbox", () => {
	it("keeps the last 200 items and persists them 0600", () => {
		const dir = join(tmp, "a");
		const inbox = new AttentionInbox(dir);
		for (let i = 0; i < INBOX_LIMIT + 20; i++) inbox.add(n("approval", "s", `item ${i}`, `u${i}`));
		inbox.flush();
		assert.equal(inbox.list().length, INBOX_LIMIT);
		assert.equal(statSync(join(dir, "attention.json")).mode & 0o777, 0o600);
		const again = new AttentionInbox(dir);
		assert.equal(again.list().length, INBOX_LIMIT);
		assert.equal(again.list()[0]!.summary, "item 20");
	});

	it("list(since) is strictly after ts and ts is strictly increasing", () => {
		const inbox = new AttentionInbox(undefined, () => 1000);
		const a = inbox.add(n("approval", "s", "a", "1"))!;
		const b = inbox.add(n("approval", "s", "b", "2"))!;
		assert.ok(b.ts > a.ts);
		assert.deepEqual(inbox.list(a.ts).map(i => i.id), [b.id]);
	});

	it("a new done supersedes the previous unresolved done of the same session only", () => {
		const inbox = new AttentionInbox();
		const d1 = inbox.add(n("done", "s1", "one"))!;
		const o = inbox.add(n("done", "s2", "other"))!;
		const d2 = inbox.add(n("done", "s1", "two"))!;
		assert.equal(d1.resolved, true);
		assert.equal(o.resolved, false);
		assert.equal(d2.resolved, false);
	});

	it("collapses identical errors within a minute", () => {
		let t = 0;
		const inbox = new AttentionInbox(undefined, () => t);
		assert.ok(inbox.add(n("error", "s", "boom")));
		assert.equal(inbox.add(n("error", "s", "boom")), null);
		t += 61_000;
		assert.ok(inbox.add(n("error", "s", "boom")));
	});

	it("emits item/resolved events", () => {
		const inbox = new AttentionInbox();
		const seen: string[] = [];
		inbox.on("item", () => seen.push("item"));
		inbox.on("resolved", () => seen.push("resolved"));
		const it = inbox.add(n("question", "s", "q", "u"))!;
		assert.equal(inbox.resolve(it.id), true);
		assert.equal(inbox.resolve(it.id), false);
		assert.deepEqual(seen, ["item", "resolved"]);
	});
});

class Backend {
	readonly kind = "managed" as const;
	evl = new Set<(e: unknown) => void>();
	attl = new Set<(i: unknown) => void>();
	closel = new Set<(r: string) => void>();
	readonly sid: string;
	constructor(sid: string) {
		this.sid = sid;
	}
	summary() {
		return { sid: this.sid, kind: "managed", title: "t", cwd: "/", status: "idle", lastActivity: 0, pendingUi: 0, caps: [] };
	}
	subscribe(l: (e: unknown) => void) {
		this.evl.add(l);
		return () => this.evl.delete(l);
	}
	onAttention(l: (i: unknown) => void) {
		this.attl.add(l);
		return () => this.attl.delete(l);
	}
	onSummaryChanged() {
		return () => {};
	}
	onClosed(l: (r: string) => void) {
		this.closel.add(l);
		return () => this.closel.delete(l);
	}
}

describe("registry → attention rules", () => {
	const setup = () => {
		const inbox = new AttentionInbox();
		const registry = new SessionRegistry({ inbox, log: () => {} });
		const b = new Backend("m_x");
		registry.add(b as unknown as SessionBackend);
		return { inbox, registry, b };
	};

	it("creates an item from backend attention and resolves it on ui.end", () => {
		const { inbox, b } = setup();
		for (const l of b.attl) l(n("approval", "m_x", "Approve bash?", "r1"));
		assert.equal(inbox.list().filter(i => !i.resolved).length, 1);
		for (const l of b.evl) l({ k: "ui.end", reqId: "r1" });
		assert.equal(inbox.list().filter(i => !i.resolved).length, 0);
	});

	it("done is resolved when the agent starts again; everything resolves when the session closes", () => {
		const { inbox, b, registry } = setup();
		for (const l of b.attl) l(n("done", "m_x", "finished"));
		for (const l of b.evl) l({ k: "agent.start" });
		assert.equal(inbox.list()[0]!.resolved, true);
		for (const l of b.attl) l(n("question", "m_x", "q?", "r2"));
		registry.remove("m_x");
		assert.ok(inbox.list().every(i => i.resolved));
	});

	it("numbers events per session", () => {
		const { registry, b } = setup();
		const seen: number[] = [];
		registry.on("event", (_sid: string, seq: number) => seen.push(seq));
		for (const l of b.evl) {
			l({ k: "agent.start" });
			l({ k: "agent.end", yielded: true, settled: true });
		}
		assert.deepEqual(seen, [1, 2]);
		assert.equal(registry.seq("m_x"), 2);
	});
});
