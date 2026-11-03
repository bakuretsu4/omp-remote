import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { SessionEvent } from "../../protocol/src/index.ts";
import { ManagedBackend } from "../src/managed/backend.ts";
import { RpcFrameDecoder } from "../src/managed/rpc.ts";
import { createBlobStore } from "../src/normalize/blobs.ts";
import { normalizeMessage, normalizeUiRequest, truncateUtf8, uiAnswerToResponse, TOOL_OUTPUT_LIMIT } from "../src/normalize/message.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

async function launch() {
	const b = await ManagedBackend.launch({
		sid: "m_t", cwd: "/tmp", ompBin: FAKE, approvalMode: "always-ask", blobs: createBlobStore(), log: () => {},
	});
	const events: SessionEvent[] = [];
	const attn: { kind: string; uiReqId?: string; summary: string }[] = [];
	const waiters: { pred: (e: SessionEvent) => boolean; resolve: (e: SessionEvent) => void }[] = [];
	b.subscribe(e => {
		events.push(e);
		for (const w of [...waiters]) {
			if (w.pred(e)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(e);
			}
		}
	});
	b.onAttention(i => attn.push(i));
	const next = (pred: (e: SessionEvent) => boolean): Promise<SessionEvent> => {
		const hit = events.find(pred);
		if (hit) return Promise.resolve(hit);
		const { promise, resolve } = Promise.withResolvers<SessionEvent>();
		waiters.push({ pred, resolve });
		return promise;
	};
	return { b, events, attn, next };
}

describe("managed backend against a fake omp", () => {
	it("runs an approval round trip with attention, state and normalized events", async () => {
		const { b, events, attn, next } = await launch();
		assert.equal(b.summary().status, "idle");
		assert.ok(b.summary().caps.includes("approvalMode"));
		await b.prompt({ sid: "m_t", message: "please approve" }, []);
		const ui = (await next(e => e.k === "ui.request")) as Extract<SessionEvent, { k: "ui.request" }>;
		assert.equal(ui.request.kind, "approval");
		if (ui.request.kind === "approval") {
			assert.equal(ui.request.tool, "bash");
			assert.match(ui.request.detail, /echo hi/);
			assert.deepEqual(ui.request.options, ["Approve", "Approve bash for this session", "Deny"]);
		}
		assert.equal(b.summary().status, "waiting");
		assert.equal(b.summary().pendingUi, 1);
		assert.equal(attn.find(a => a.kind === "approval")!.uiReqId, ui.request.reqId);
		await assert.rejects(() => b.respondUi(ui.request.reqId, { value: "Rm -rf" }), /not one of the offered options/);
		await b.respondUi(ui.request.reqId, { value: "Approve" });
		const end = (await next(e => e.k === "tool.end")) as Extract<SessionEvent, { k: "tool.end" }>;
		assert.equal(end.output, "hi\n");
		assert.equal(end.isError, false);
		await next(e => e.k === "agent.end");
		assert.ok(attn.some(a => a.kind === "done" && a.summary === "done"));
		const msgs = events.filter((e): e is Extract<SessionEvent, { k: "msg" }> => e.k === "msg");
		assert.ok(msgs.at(-1)!.final);
		assert.ok(msgs.filter(m => !m.final).length <= 8 + 1, "streaming coalesced");
		await assert.rejects(() => b.respondUi(ui.request.reqId, { value: "Approve" }), /no such pending request/);
		const snap = await b.snapshot();
		assert.ok(snap.messages.some(m => m.role === "toolResult"));
		assert.equal(snap.pendingUi.length, 0);
		await b.close();
	});

	it("maps Deny to a tool error", async () => {
		const { b, next } = await launch();
		await b.prompt({ sid: "m_t", message: "approve it" }, []);
		const ui = (await next(e => e.k === "ui.request")) as Extract<SessionEvent, { k: "ui.request" }>;
		await b.respondUi(ui.request.reqId, { value: "Deny" });
		const end = (await next(e => e.k === "tool.end")) as Extract<SessionEvent, { k: "tool.end" }>;
		assert.equal(end.isError, true);
		await b.close();
	});

	it("validates ask answers", async () => {
		const { b, next } = await launch();
		await b.prompt({ sid: "m_t", message: "ask me" }, []);
		const ui = (await next(e => e.k === "ui.request")) as Extract<SessionEvent, { k: "ui.request" }>;
		assert.equal(ui.request.kind, "ask");
		await assert.rejects(() => b.respondUi(ui.request.reqId, { answers: [] }), /one entry per question/);
		await b.respondUi(ui.request.reqId, { answers: [{ id: "db", selectedOptions: ["SQLite"] }] });
		await next(e => e.k === "agent.end");
		await b.close();
	});

	it("reports a crash as closed + error attention", async () => {
		const { b, events, attn } = await launch();
		const closed = Promise.withResolvers<string>();
		b.onClosed(r => closed.resolve(r));
		await b.prompt({ sid: "m_t", message: "crash now" }, []);
		const reason = await closed.promise;
		assert.match(reason, /exited unexpectedly \(code 3\)/);
		assert.ok(events.some(e => e.k === "closed"));
		const err = attn.find(a => a.kind === "error")!;
		assert.match(err.summary, /exploded|exited unexpectedly/);
		assert.equal(b.summary().status, "offline");
		await assert.rejects(() => b.prompt({ sid: "m_t", message: "x" }, []), /session has ended/);
	});

	it("abort restores the queue; rename and models work (incl. rpc_chunk reassembly)", async () => {
		const { b } = await launch();
		assert.deepEqual(await b.abort(), { restored: { steering: ["queued"], followUp: [] } });
		await b.rename("Phone session");
		assert.equal(b.summary().title, "Phone session");
		const models = await b.listModels();
		assert.equal(models.length, 30);
		assert.deepEqual(models[0]!.thinkingLevels, ["off", "low", "high"]);
		assert.deepEqual(models[1]!.thinkingLevels, ["off"]);
		await b.close();
	});
});

describe("rpc frame decoder", () => {
	const chunks = (obj: unknown, n: number, id = "c1") => {
		const bytes = Buffer.from(JSON.stringify(obj));
		const size = Math.ceil(bytes.length / n);
		return Array.from({ length: n }, (_, i) => JSON.stringify({ type: "rpc_chunk", chunkId: id, index: i, count: n, byteLength: bytes.length, data: bytes.subarray(i * size, (i + 1) * size).toString("base64") }));
	};

	it("reassembles multi-byte UTF-8 split across chunks", () => {
		const d = new RpcFrameDecoder();
		const parts = chunks({ type: "x", s: "héllo wörld ✓ 日本語" }, 7);
		const outs = parts.map(p => d.push(p));
		assert.equal(outs.slice(0, -1).every(o => o === undefined), true);
		assert.deepEqual(outs.at(-1), { type: "x", s: "héllo wörld ✓ 日本語" });
	});

	it("rejects interleaved, out-of-order and wrong-length sequences", () => {
		const d = new RpcFrameDecoder();
		const parts = chunks({ type: "x", pad: "y".repeat(100) }, 3);
		d.push(parts[0]!);
		assert.throws(() => d.push(JSON.stringify({ type: "agent_start" })), /interrupted/);
		const d2 = new RpcFrameDecoder();
		d2.push(parts[0]!);
		assert.throws(() => d2.push(parts[2]!), /out of sequence/);
		const bad = JSON.parse(chunks({ a: 1 }, 1)[0]!);
		bad.byteLength += 1;
		assert.throws(() => new RpcFrameDecoder().push(JSON.stringify(bad)), /mismatch/);
	});
});

describe("normalization", () => {
	it("truncates tool output on a UTF-8 boundary", () => {
		const s = "é".repeat(TOOL_OUTPUT_LIMIT);
		const t = truncateUtf8(s, TOOL_OUTPUT_LIMIT);
		assert.equal(t.truncated, true);
		assert.ok(Buffer.byteLength(t.text) <= TOOL_OUTPUT_LIMIT);
		assert.ok(!t.text.includes("\ufffd"));
		assert.equal(truncateUtf8("short").truncated, false);
	});

	it("replaces images with blob refs", () => {
		const blobs = createBlobStore();
		const data = Buffer.from("png-bytes").toString("base64");
		const m = normalizeMessage({ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data }], timestamp: 5 }, { blobs, id: "x" })!;
		const img = m.content[1]!;
		assert.equal(img.type, "image");
		if (img.type === "image") {
			assert.equal(img.bytes, 9);
			assert.equal(Buffer.from(blobs.get(img.ref)!.bytes).toString(), "png-bytes");
		}
		assert.ok(!JSON.stringify(m).includes(data));
	});

	it("maps approvals, asks, selects and ignores presentation frames", () => {
		const a = normalizeUiRequest({ type: "extension_ui_request", id: "1", method: "select", title: "Allow tool: write\nPath: /x", options: ["Approve", "Deny"] }, 1)!;
		assert.equal(a.kind, "approval");
		const s = normalizeUiRequest({ id: "2", method: "select", title: "Pick", options: ["A", "B"], optionDetails: [{ description: "first" }, {}] }, 1)!;
		assert.deepEqual(s.kind === "select" && s.options, [{ label: "A", description: "first" }, { label: "B" }]);
		assert.equal(normalizeUiRequest({ id: "3", method: "setWidget" }), null);
		assert.equal(normalizeUiRequest({ id: "4", method: "notify", message: "x" }), null);
		assert.deepEqual(uiAnswerToResponse(a, { cancelled: true }), { cancelled: true });
		assert.throws(() => uiAnswerToResponse(a, { confirmed: true }), /needs \{value\}/);
	});

	it("drops non-display custom messages", () => {
		const blobs = createBlobStore();
		assert.equal(normalizeMessage({ role: "custom", display: false, content: "x" }, { blobs }), null);
		assert.equal(normalizeMessage({ role: "custom", content: "shown" }, { blobs })!.role, "developer");
	});
});
