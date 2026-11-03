import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AttentionItem, SessionEvent, UiRequest } from "../../../protocol/src/index.ts";
import { OpError } from "../../src/errors.ts";
import { createBlobStore } from "../../src/normalize/blobs.ts";
import { TuiBackend } from "../../src/tui/tui-backend.ts";
import {
	FakeCollabHost, assistantEntry, assistantMessage, collabPromptEntry, makeState, parseLink, sleep, startTestRelay,
	toolResultEntry, userEntry, waitUntil, type FakeHostOptions,
} from "./helpers.ts";

const FAST_CLIENT = { welcomeTimeoutMs: 400, snapshotProgressTimeoutMs: 400, backoffBaseMs: 20, backoffMaxMs: 60 };

async function setup(t: TestContext, opts: Partial<FakeHostOptions> & { view?: boolean; maxMessages?: number } = {}) {
	const { relay, url } = await startTestRelay();
	const host = new FakeCollabHost({ relayUrl: url, ...opts });
	await host.start();
	const link = parseLink(opts.view ? host.viewLink : host.link);
	const backend = await TuiBackend.attach({
		sid: "t_test", link, blobs: createBlobStore(), maxMessages: opts.maxMessages, client: FAST_CLIENT,
	});
	const events: SessionEvent[] = [];
	const attention: Omit<AttentionItem, "id" | "ts" | "resolved">[] = [];
	backend.subscribe(e => events.push(e));
	backend.onAttention(a => attention.push(a));
	t.after(async () => {
		await backend.close();
		await host.close();
		await relay.close();
	});
	return { relay, url, host, backend, events, attention };
}

const kinds = (events: SessionEvent[]): string[] => events.map(e => e.k);
const textOf = (m: { content: { type: string; text?: string }[] }): string => m.content.map(b => b.text ?? "").join("");

test("attach: snapshot is normalized; summary and caps are honest", async t => {
	const entries = [
		userEntry("Run ls", 1000),
		assistantEntry([{ type: "text", text: "Sure" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], 2000),
		toolResultEntry("c1", "bash", "a.txt\nb.txt", 3000),
		collabPromptEntry("from the phone", "Pixel", 4000),
		assistantEntry([{ type: "text", text: "Done." }], 5000),
	];
	const { host, backend } = await setup(t, { entries });

	const hello = host.framesOf("hello")[0]!;
	assert.equal(hello.proto, 3);
	assert.equal(hello.name, "ompr-bridge");
	assert.equal(host.peers.get(1)?.canWrite, true);

	const s = backend.summary();
	assert.equal(s.sid, "t_test");
	assert.equal(s.kind, "tui");
	assert.equal(s.title, "Test session");
	assert.equal(s.cwd, "/work/proj");
	assert.equal(s.status, "idle");
	assert.deepEqual(s.model, { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200_000 });
	assert.equal(s.thinkingLevel, "medium");
	assert.equal(s.contextPercent, 10);
	assert.equal(s.costUsd, 0.5);
	assert.equal(s.pendingUi, 0);
	assert.deepEqual([...s.caps].sort(), ["abort", "files", "images", "prompt", "stats", "subagents", "ui"]);
	assert.ok(!s.caps.includes("steer"));

	const snap = await backend.snapshot();
	assert.deepEqual(snap.messages.map(m => m.role), ["user", "assistant", "toolResult", "user", "assistant"]);
	assert.deepEqual(snap.messages.map(m => m.id), entries.map(e => e.id));
	assert.equal(snap.messages[3]!.from, "Pixel");
	assert.equal(textOf(snap.messages[3]!), "from the phone");
	assert.deepEqual(snap.messages[1]!.content[1], { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } });
	assert.equal(snap.messages[2]!.toolCallId, "c1");
	assert.equal(snap.hasMore, false);
	assert.deepEqual(snap.state.participants, [{ name: "host", role: "host" }]);
	assert.deepEqual(snap.queue, { steering: [], followUp: [] });

	const last2 = await backend.history(undefined, 2);
	assert.deepEqual(last2.messages.map(m => m.id), [entries[3]!.id, entries[4]!.id]);
	assert.equal(last2.hasMore, true);
	const page = await backend.history(entries[3]!.id, 10);
	assert.deepEqual(page.messages.map(m => m.id), entries.slice(0, 3).map(e => e.id));
	assert.equal(page.hasMore, false);
	await assert.rejects(backend.history("nope", 5), (e: unknown) => e instanceof OpError && e.code === "not_found");
	assert.equal((await backend.snapshot(2)).hasMore, true);
});

test("retention cap: only the newest messages are kept", async t => {
	const entries = Array.from({ length: 120 }, (_, i) => userEntry(`m${i}`, 1000 + i));
	const { backend } = await setup(t, { entries, chunkSize: 25, maxMessages: 50 });
	const snap = await backend.snapshot(1000);
	assert.equal(snap.messages.length, 50);
	assert.equal(textOf(snap.messages[0]!), "m70");
	assert.equal(textOf(snap.messages.at(-1)!), "m119");
});

test("live frames that race the snapshot are replayed after it, in order", async t => {
	const { relay, url } = await startTestRelay();
	t.after(() => relay.close());
	const entries = Array.from({ length: 9 }, (_, i) => userEntry(`m${i}`, 1000 + i));
	const host = new FakeCollabHost({ relayUrl: url, entries, chunkSize: 3 });
	await host.start();
	t.after(() => host.close());
	// Slip a live entry between two snapshot chunks: the host's own send order is welcome, chunk, LIVE, chunk, chunk.
	const live = userEntry("live", 9999);
	const origSend = host.send.bind(host);
	let chunks = 0;
	host.send = (frame, peer) => {
		origSend(frame, peer);
		if (frame.t === "snapshot-chunk" && ++chunks === 1) origSend({ t: "entry", entry: live });
	};
	const backend = await TuiBackend.attach({
		sid: "t_race", link: parseLink(host.link), blobs: createBlobStore(), client: FAST_CLIENT,
	});
	t.after(() => backend.close());
	const snap = await backend.snapshot(100);
	assert.deepEqual(snap.messages.map(textOf), [...entries.map((_, i) => `m${i}`), "live"]);
});

test("streaming turn (message_end before the entry): events, stable live id, single final msg, attention done", async t => {
	const { host, backend, events, attention } = await setup(t, { entries: [userEntry("hi", 1000)] });
	const ts = 2000;
	const partial = (text: string) => assistantMessage([{ type: "text", text }], ts, { stopReason: undefined });

	host.send({ t: "event", event: { type: "agent_start" } });
	host.send({ t: "state", state: makeState({ isStreaming: true }) });
	await waitUntil(() => backend.summary().status === "working", 2000, "working");

	host.send({ t: "event", event: { type: "message_start", message: partial("") } });
	host.send({ t: "event", event: { type: "message_update", message: partial("Hel") } });
	host.send({ t: "event", event: { type: "message_update", message: partial("Hello") } });
	host.send({ t: "event", event: { type: "message_update", message: partial("Hello world") } });
	host.send({ t: "event", event: { type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: { command: "echo hi" }, intent: "Say hi" } });
	host.send({ t: "event", event: { type: "tool_execution_update", toolCallId: "c9", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "h" }] } } });
	await waitUntil(() => events.some(e => e.k === "tool.update"), 2000, "tool.update");
	const mid = await backend.snapshot();
	assert.equal(mid.runningTools.length, 1);
	assert.equal(mid.runningTools[0]!.tool, "bash");
	assert.equal(mid.messages.at(-1)!.role, "assistant", "in-flight assistant message is part of the snapshot");
	host.send({ t: "event", event: { type: "tool_execution_end", toolCallId: "c9", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false } });
	const finalMsg = assistantMessage([{ type: "text", text: "Hello world" }], ts);
	host.send({ t: "event", event: { type: "message_end", message: finalMsg } });
	const entry = assistantEntry([{ type: "text", text: "Hello world" }], ts);
	host.appendEntry(entry);
	host.send({ t: "event", event: { type: "agent_end", isTerminal: true, yielded: true } });
	host.send({ t: "state", state: makeState({ isStreaming: false }) });
	await waitUntil(() => events.some(e => e.k === "agent.end"), 2000, "agent.end");
	await waitUntil(() => backend.summary().status === "idle", 2000, "idle");

	assert.ok(kinds(events).includes("agent.start"));
	const msgs = events.flatMap(e => (e.k === "msg" ? [e] : []));
	assert.ok(msgs.length >= 2 && msgs.length <= 4, `coalesced stream, got ${msgs.length}`);
	assert.equal(new Set(msgs.map(m => m.message.id)).size, 1, "one stable live id for the whole stream");
	assert.equal(msgs[0]!.final, false);
	assert.equal(msgs.at(-1)!.final, true);
	assert.equal(textOf(msgs.at(-1)!.message), "Hello world");
	assert.equal(msgs.filter(m => m.final).length, 1, "the entry must not announce the message a second time");

	const start = events.find(e => e.k === "tool.start");
	assert.deepEqual(start, { k: "tool.start", callId: "c9", tool: "bash", args: { command: "echo hi" }, intent: "Say hi" });
	assert.deepEqual(events.find(e => e.k === "tool.end"), { k: "tool.end", callId: "c9", output: "hi\n", isError: false });
	assert.deepEqual(events.find(e => e.k === "agent.end"), { k: "agent.end", yielded: true, settled: true });

	// the stored message took the entry id; the live id is an alias for paging
	const snap = await backend.snapshot();
	assert.equal(snap.messages.at(-1)!.id, entry.id);
	assert.equal(snap.runningTools.length, 0);
	const liveId = msgs[0]!.message.id;
	const before = await backend.history(liveId, 10);
	assert.deepEqual(before.messages.map(textOf), ["hi"]);

	assert.deepEqual(await backend.toolOutput("c9", 0), { text: "hi\n" });
	await assert.rejects(backend.toolOutput("zzz", 0), (e: unknown) => e instanceof OpError && e.code === "not_found");

	const done = attention.filter(a => a.kind === "done");
	assert.equal(done.length, 1);
	assert.equal(done[0]!.summary, "Hello world");
	assert.equal(done[0]!.sid, "t_test");
	assert.equal(done[0]!.sessionTitle, "Test session");
});

test("streaming turn (entry before message_end) keeps one id and one final msg", async t => {
	const { host, backend, events } = await setup(t, {});
	const ts = 3000;
	host.send({ t: "event", event: { type: "message_start", message: assistantMessage([{ type: "text", text: "A" }], ts) } });
	host.send({ t: "event", event: { type: "message_update", message: assistantMessage([{ type: "text", text: "AB" }], ts) } });
	await waitUntil(() => events.some(e => e.k === "msg"), 2000, "first msg");
	const entry = assistantEntry([{ type: "text", text: "AB" }], ts);
	host.appendEntry(entry);
	await sleep(80);
	host.send({ t: "event", event: { type: "message_end", message: assistantMessage([{ type: "text", text: "AB" }], ts) } });
	await waitUntil(() => events.some(e => e.k === "msg" && e.final), 2000, "final msg");
	await sleep(50);
	const msgs = events.flatMap(e => (e.k === "msg" ? [e] : []));
	assert.equal(new Set(msgs.map(m => m.message.id)).size, 1);
	assert.equal(msgs.filter(m => m.final).length, 1);
	const snap = await backend.snapshot();
	assert.deepEqual(snap.messages.map(m => m.id), [entry.id], "no duplicate in the stored transcript");
});

test("entries without a stream (user prompts, tool results) are announced as final msg", async t => {
	const { host, events, backend } = await setup(t, {});
	host.appendEntry(collabPromptEntry("do it", "Pixel", 5000));
	host.appendEntry(userEntry("typed on the pc", 6000));
	await waitUntil(() => events.filter(e => e.k === "msg").length === 2, 2000, "two msgs");
	const msgs = events.flatMap(e => (e.k === "msg" ? [e] : []));
	assert.equal(msgs[0]!.message.from, "Pixel");
	assert.equal(msgs[1]!.message.from, undefined);
	assert.ok(msgs.every(m => m.final));
	assert.equal((await backend.snapshot()).messages.length, 2);
});

test("host approval select → approval UiRequest; answer round trip; first answer wins", async t => {
	const { host, backend, events, attention } = await setup(t, {});
	const reqId = host.uiRequest({
		kind: "select",
		title: "Allow tool: bash\nCommand: echo hi",
		options: ["Approve", "Approve bash for this session", "Deny"],
	});
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "ui.request");
	const ev = events.find(e => e.k === "ui.request")! as Extract<SessionEvent, { k: "ui.request" }>;
	const req: UiRequest = ev.request;
	assert.equal(req.kind, "approval");
	assert.equal(req.reqId, String(reqId));
	if (req.kind !== "approval") throw new Error("unreachable");
	assert.equal(req.tool, "bash");
	assert.equal(req.detail, "Command: echo hi");
	assert.deepEqual(req.options, ["Approve", "Approve bash for this session", "Deny"]);
	assert.equal(req.title, "Allow tool: bash\nCommand: echo hi");

	assert.equal(backend.summary().status, "waiting");
	assert.equal(backend.summary().pendingUi, 1);
	assert.deepEqual((await backend.snapshot()).pendingUi.map(r => r.reqId), [String(reqId)]);
	assert.deepEqual(attention.find(a => a.kind === "approval"), {
		sid: "t_test", sessionTitle: "Test session", kind: "approval", summary: "Approve bash: Command: echo hi", uiReqId: String(reqId),
	});

	await assert.rejects(backend.respondUi(String(reqId), { value: "Nuke it" }), (e: unknown) => e instanceof OpError && e.code === "invalid");
	await assert.rejects(backend.respondUi("999", { value: "Approve" }), (e: unknown) => e instanceof OpError && e.code === "not_found");
	await backend.respondUi(String(reqId), { value: "Approve" });
	await waitUntil(() => events.some(e => e.k === "ui.end"), 2000, "ui.end");
	assert.deepEqual(host.responses(reqId).map(r => r.value), ["Approve"]);
	assert.deepEqual(events.find(e => e.k === "ui.end"), { k: "ui.end", reqId: String(reqId) });
	await waitUntil(() => backend.summary().status === "idle", 2000, "idle");
	assert.equal(backend.summary().pendingUi, 0);
	await assert.rejects(backend.respondUi(String(reqId), { value: "Deny" }), (e: unknown) => e instanceof OpError && e.code === "not_found");
});

test("approval cancel sends an undefined value; editor and plain select map through", async t => {
	const { host, backend, events } = await setup(t, {});
	const a = host.uiRequest({ kind: "select", title: "Pick one", options: [{ label: "x", description: "the x" }, "y"] });
	const b = host.uiRequest({ kind: "editor", title: "Edit this", prefill: "draft" });
	await waitUntil(() => events.filter(e => e.k === "ui.request").length === 2, 2000, "two requests");
	const reqs = events.flatMap(e => (e.k === "ui.request" ? [e.request] : []));
	assert.deepEqual(reqs[0], { reqId: String(a), kind: "select", title: "Pick one", options: [{ label: "x", description: "the x" }, { label: "y" }], createdAt: reqs[0]!.createdAt });
	assert.equal(reqs[1]!.kind, "editor");
	await backend.respondUi(String(a), { cancelled: true });
	await backend.respondUi(String(b), { value: "edited text" });
	await waitUntil(() => host.responses().length === 2, 2000, "two responses");
	assert.equal(host.responses(a)[0]!.value, undefined);
	assert.equal(host.responses(b)[0]!.value, "edited text");
});

test("ask (radio) with a custom answer drives Other + the Custom answer editor", async t => {
	const { host, backend, events } = await setup(t, {});
	const reqId = host.uiRequest({
		kind: "select", title: "Which database?", selectionMarker: "radio", markableCount: 2, initialIndex: 1,
		options: ["Postgres", { label: "SQLite", description: "embedded" }, "Other (type your own)", "Chat about this"],
	});
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "ask");
	const req = (events.find(e => e.k === "ui.request") as Extract<SessionEvent, { k: "ui.request" }>).request;
	assert.equal(req.kind, "ask");
	if (req.kind !== "ask") throw new Error("unreachable");
	assert.deepEqual(req.questions, [
		{ id: String(reqId), question: "Which database?", multi: false, recommended: 1, options: [{ label: "Postgres" }, { label: "SQLite", description: "embedded" }] },
	]);
	await assert.rejects(backend.respondUi(String(reqId), { answers: [{ id: String(reqId), selectedOptions: ["Mongo"] }] }), (e: unknown) => e instanceof OpError && e.code === "invalid");

	await backend.respondUi(String(reqId), { answers: [{ id: String(reqId), selectedOptions: [], customInput: "DuckDB please" }] });
	await waitUntil(() => host.responses(reqId).length === 1, 2000, "other");
	assert.equal(host.responses(reqId)[0]!.value, "Other (type your own)");
	// the host now asks for the free text
	const editorId = host.uiRequest({ kind: "editor", title: "Custom answer: Which database?" });
	await waitUntil(() => host.responses(editorId).length === 1, 2000, "custom text");
	assert.equal(host.responses(editorId)[0]!.value, "DuckDB please");
	assert.equal(events.filter(e => e.k === "ui.request").length, 1, "the driver's follow-up steps are not surfaced");
});

test("ask (radio) single option is answered directly", async t => {
	const { host, backend, events } = await setup(t, {});
	const reqId = host.uiRequest({ kind: "select", title: "Q?", selectionMarker: "radio", markableCount: 2, options: ["A", "B", "Other (type your own)", "Chat about this"] });
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "ask");
	await backend.respondUi(String(reqId), { answers: [{ id: String(reqId), selectedOptions: ["B"] }] });
	await waitUntil(() => host.responses(reqId).length === 1, 2000, "answer");
	assert.equal(host.responses(reqId)[0]!.value, "B");
});

test("ask (checkbox) toggles each pick, then Next →", async t => {
	const { host, backend, events } = await setup(t, {});
	const opts = (hasNext: boolean) => ["A", "B", "C", "Other (type your own)", ...(hasNext ? ["Next →"] : []), "Chat about this"];
	const first = host.uiRequest({ kind: "select", title: "Pick some", selectionMarker: "checkbox", markableCount: 3, checkedIndices: [], options: opts(false) });
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "ask");
	const req = (events.find(e => e.k === "ui.request") as Extract<SessionEvent, { k: "ui.request" }>).request;
	assert.equal(req.kind === "ask" && req.questions[0]!.multi, true);
	assert.deepEqual(req.kind === "ask" && req.questions[0]!.options.map(o => o.label), ["A", "B", "C"]);

	await backend.respondUi(String(first), { answers: [{ id: String(first), selectedOptions: ["A", "C"] }] });
	await waitUntil(() => host.responses(first).length === 1, 2000, "toggle A");
	assert.equal(host.responses(first)[0]!.value, "A");
	const second = host.uiRequest({ kind: "select", title: "Pick some", selectionMarker: "checkbox", markableCount: 3, checkedIndices: [0], options: opts(true) });
	await waitUntil(() => host.responses(second).length === 1, 2000, "toggle C");
	assert.equal(host.responses(second)[0]!.value, "C");
	const third = host.uiRequest({ kind: "select", title: "Pick some", selectionMarker: "checkbox", markableCount: 3, checkedIndices: [0, 2], options: opts(true) });
	await waitUntil(() => host.responses(third).length === 1, 2000, "next");
	assert.equal(host.responses(third)[0]!.value, "Next →");
	await sleep(50);
	assert.equal(events.filter(e => e.k === "ui.request").length, 1, "only the original question was shown");
});

test("the ask driver ignores unrelated dialogs, which are surfaced normally", async t => {
	const { host, backend, events } = await setup(t, {});
	const first = host.uiRequest({ kind: "select", title: "Pick some", selectionMarker: "checkbox", markableCount: 2, checkedIndices: [], options: ["A", "B", "Other (type your own)", "Chat about this"] });
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "ask");
	await backend.respondUi(String(first), { answers: [{ id: String(first), selectedOptions: ["A", "B"] }] });
	await waitUntil(() => host.responses(first).length === 1, 2000, "toggle");
	// The host sends the next step, but with a different title: not ours → surfaced as a fresh question.
	const other = host.uiRequest({ kind: "select", title: "Unrelated", options: ["x"] });
	await waitUntil(() => events.filter(e => e.k === "ui.request").length === 2, 2000, "unrelated surfaced");
	assert.equal(events.filter(e => e.k === "ui.request").at(-1)!.k, "ui.request");
	assert.equal((events.filter(e => e.k === "ui.request").at(-1) as { request: UiRequest }).request.reqId, String(other));
});

test("prompt, abort and subagent ops reach the host (images + files mapped)", async t => {
	const agents = [
		{ id: "a1", displayName: "explorer", kind: "sub" as const, status: "running", hasSessionFile: true, createdAt: 1, lastActivity: 2 },
	];
	const { host, backend } = await setup(t, { agents });
	await backend.prompt(
		{ sid: "t_test", message: "look at this" },
		[{ kind: "image", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }, { kind: "file", path: "/work/proj/.ompr-inbox/1-a.txt", name: "a.txt" }],
	);
	await backend.abort();
	await backend.ops["subagent.steer"]!({ sid: "t_test", id: "a1", message: "focus on tests" });
	await backend.ops["subagent.cancel"]!({ sid: "t_test", id: "a1" });
	await waitUntil(() => host.framesOf("agent-cmd").length === 2, 2000, "agent cmds");
	const prompt = host.framesOf("prompt")[0]!;
	assert.equal(prompt.text, "look at this\n\n[Attached file: /work/proj/.ompr-inbox/1-a.txt]");
	assert.deepEqual(prompt.images, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
	assert.equal(host.framesOf("abort").length, 1);
	assert.deepEqual(host.framesOf("agent-cmd"), [
		{ t: "agent-cmd", cmd: "chat", agentId: "a1", text: "focus on tests" },
		{ t: "agent-cmd", cmd: "kill", agentId: "a1" },
	]);
	await assert.rejects(backend.ops["subagent.cancel"]!({ sid: "t_test", id: "nope" }), (e: unknown) => e instanceof OpError && e.code === "not_found");
	await assert.rejects(backend.prompt({ sid: "t_test", message: "  " }, []), (e: unknown) => e instanceof OpError && e.code === "invalid");
	assert.deepEqual((await backend.snapshot()).subagents, [{ id: "a1", name: "explorer", kind: "sub", status: "running" }]);
});

test("subagent list follows `agents` and bus progress frames", async t => {
	const { host, backend, events } = await setup(t, {});
	host.send({ t: "agents", agents: [{ id: "a2", displayName: "scout", kind: "sub", status: "running", hasSessionFile: false, createdAt: 1, lastActivity: 2 }] });
	host.send({ t: "bus", channel: "task:subagent:progress", data: { index: 0, agent: "scout", task: "t", progress: { id: "a2", status: "running", task: "map repo", lastIntent: "Reading", currentTool: "read", tokens: 1200, cost: 0.02 } } });
	await waitUntil(() => events.some(e => e.k === "subagents"), 2000, "subagents");
	await sleep(700);
	const last = events.filter(e => e.k === "subagents").at(-1) as Extract<SessionEvent, { k: "subagents" }>;
	assert.deepEqual(last.subagents, [{ id: "a2", name: "scout", kind: "sub", status: "running", task: "map repo", lastIntent: "Reading", currentTool: "read", tokens: 1200, costUsd: 0.02 }]);
});

test("view-only link: read-only caps, rejected writes, registry inputRequired → waiting", async t => {
	const { host, backend } = await setup(t, { view: true });
	assert.equal(host.peers.get(1)?.canWrite, false);
	assert.equal(host.framesOf("hello")[0]!.writeToken, undefined);
	const s = backend.summary();
	assert.deepEqual(s.caps, ["stats"]);
	assert.deepEqual(backend.ops, {});
	await assert.rejects(backend.prompt({ sid: "t_test", message: "x" }, []), (e: unknown) => e instanceof OpError && e.code === "readonly");
	await assert.rejects(backend.abort(), (e: unknown) => e instanceof OpError && e.code === "readonly");
	await assert.rejects(backend.respondUi("1", { value: "x" }), (e: unknown) => e instanceof OpError && e.code === "readonly");
	assert.equal(host.framesOf("prompt").length, 0);

	// view guests never receive ui-requests; the registry's inputRequired is the only signal
	const attention: string[] = [];
	backend.onAttention(a => attention.push(`${a.kind}:${a.summary}`));
	const changed: number[] = [];
	backend.onSummaryChanged(() => changed.push(1));
	const info = { instanceId: "i", generation: 1, pid: 42, sessionId: "s", sessionName: null, cwd: "/work/proj", model: null, startedAt: 1, participants: 2, relayConnected: true, inputRequired: true, busy: true, access: "view" as const };
	backend.updateHost(info);
	assert.equal(backend.summary().status, "waiting");
	assert.equal(backend.summary().pid, 42);
	assert.equal(backend.summary().pendingUi, 0);
	assert.deepEqual(attention, ["question:Waiting for input on the PC (this session is attached read-only)"]);
	await waitUntil(() => changed.length > 0, 1000, "summary change");
	backend.updateHost({ ...info, inputRequired: false });
	assert.equal(backend.summary().status, "idle");
});

test("a host that downgrades our write token makes the session read-only", async t => {
	const { relay, url } = await startTestRelay();
	t.after(() => relay.close());
	const host = new FakeCollabHost({ relayUrl: url });
	await host.start();
	t.after(() => host.close());
	// A link whose token the host does not accept: welcome.readOnly === true although we sent one.
	const link = parseLink(host.link);
	link.writeToken = new Uint8Array(16).fill(1);
	const backend = await TuiBackend.attach({ sid: "t_ro", link, blobs: createBlobStore(), client: FAST_CLIENT });
	t.after(() => backend.close());
	assert.deepEqual(backend.summary().caps, ["stats"]);
	await assert.rejects(backend.prompt({ sid: "t_ro", message: "x" }, []), (e: unknown) => e instanceof OpError && e.code === "readonly");
});

test("relay drop: reconnect, resync and announce what was missed", async t => {
	const { host, backend, events } = await setup(t, { entries: [userEntry("one", 1000)] });
	const changed: string[] = [];
	backend.onSummaryChanged(() => changed.push(backend.summary().status));
	host.dropRelay();
	await waitUntil(() => events.some(e => e.k === "notice" && e.level === "warning"), 3000, "connection lost notice");
	host.entries.push(userEntry("two (while away)", 2000));
	host.state = makeState({ isStreaming: false, sessionName: "Renamed" });
	await sleep(50);
	await host.reconnect();
	await waitUntil(() => events.some(e => e.k === "notice" && e.message.startsWith("Reconnected")), 5000, "reconnected");
	assert.equal(host.helloCount, 2, "one hello per connection");
	const snap = await backend.snapshot();
	assert.deepEqual(snap.messages.map(textOf), ["one", "two (while away)"]);
	assert.equal(snap.summary.title, "Renamed");
	const msgs = events.flatMap(e => (e.k === "msg" ? [e] : []));
	assert.deepEqual(msgs.map(m => textOf(m.message)), ["two (while away)"], "only the missed message is announced");
	assert.ok(events.some(e => e.k === "state"));
	// and the link is usable again
	await backend.prompt({ sid: "t_test", message: "hello again" }, []);
	await waitUntil(() => host.framesOf("prompt").length === 1, 2000, "prompt after reconnect");
});

test("pending dialogs the host does not replay after a rejoin are ended", async t => {
	const { host, backend, events } = await setup(t, {});
	const reqId = host.uiRequest({ kind: "select", title: "Allow tool: write\nPath: /x", options: ["Approve", "Deny"] });
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "request");
	host.dropRelay();
	host.pendingUi.clear(); // the host answered it locally while we were away
	await sleep(50);
	await host.reconnect();
	await waitUntil(() => events.some(e => e.k === "ui.end"), 6000, "ui.end after sweep");
	assert.deepEqual(events.find(e => e.k === "ui.end"), { k: "ui.end", reqId: String(reqId) });
	assert.equal(backend.summary().pendingUi, 0);
});

test("dialogs the host replays after a rejoin stay pending (no flicker)", async t => {
	const { host, backend, events } = await setup(t, {});
	const reqId = host.uiRequest({ kind: "select", title: "Allow tool: write\nPath: /x", options: ["Approve", "Deny"] });
	await waitUntil(() => events.some(e => e.k === "ui.request"), 2000, "request");
	host.dropRelay();
	await sleep(50);
	await host.reconnect();
	await waitUntil(() => host.helloCount === 2, 5000, "rejoin");
	await sleep(2300);
	assert.equal(events.filter(e => e.k === "ui.end").length, 0);
	assert.equal(events.filter(e => e.k === "ui.request").length, 1);
	assert.equal(backend.summary().pendingUi, 1);
	await backend.respondUi(String(reqId), { value: "Deny" });
	await waitUntil(() => host.responses(reqId).length === 1, 2000, "answered");
});

test("host bye closes the backend with endedByHost", async t => {
	const { host, backend, events } = await setup(t, {});
	const reasons: string[] = [];
	backend.onClosed(r => reasons.push(r));
	host.send({ t: "bye", reason: "session switched" });
	await waitUntil(() => reasons.length === 1, 2000, "closed");
	assert.equal(reasons[0], "host ended the session: session switched");
	assert.equal(backend.endedByHost, true);
	assert.equal(backend.summary().status, "offline");
	assert.deepEqual(events.at(-1), { k: "closed", reason: "host ended the session: session switched" });
	await assert.rejects(backend.prompt({ sid: "t_test", message: "x" }, []), (e: unknown) => e instanceof OpError && e.code === "session_closed");
	await backend.close(); // idempotent
	assert.equal(reasons.length, 1);
});

test("join failures: no welcome in time, host refusal, no such room, bad key", async t => {
	const { relay, url } = await startTestRelay();
	t.after(() => relay.close());
	const mk = async (o: Partial<FakeHostOptions>) => {
		const host = new FakeCollabHost({ relayUrl: url, ...o });
		await host.start();
		t.after(() => host.close());
		return host;
	};
	const attach = (link: string, client = FAST_CLIENT) =>
		TuiBackend.attach({ sid: "t_x", link: parseLink(link), blobs: createBlobStore(), client });

	const silent = await mk({ ignoreHello: true });
	await assert.rejects(attach(silent.link, { ...FAST_CLIENT, welcomeTimeoutMs: 150 }), /timed out waiting for the host's welcome/);

	const refusing = await mk({ helloError: "Session transition in progress; join again when it completes" });
	await assert.rejects(attach(refusing.link), /host refused the join: Session transition in progress/);

	const ghostRoom = new FakeCollabHost({ relayUrl: url }); // never started → no such room
	await assert.rejects(attach(ghostRoom.link), /no such room/);

	const real = await mk({});
	const wrongKey = real.link.replace(/\.[A-Za-z0-9_-]{4}/, ".AAAA");
	await assert.rejects(attach(wrongKey), /bad key|timed out|corrupted/);
});

test("snapshot assembly completes on `final` even if entryCount over-promises", async t => {
	const { relay, url } = await startTestRelay();
	t.after(() => relay.close());
	const entries = [userEntry("a", 1), userEntry("b", 2)];
	const host = new FakeCollabHost({ relayUrl: url, entries, chunkSize: 1 });
	// over-promise: welcome says 5 entries but the train ends with final:true after 2
	const origSend = host.send.bind(host);
	host.send = (frame, peer) => origSend(frame.t === "welcome" ? { ...frame, entryCount: 5 } : frame, peer);
	await host.start();
	t.after(() => host.close());
	const backend = await TuiBackend.attach({ sid: "t_f", link: parseLink(host.link), blobs: createBlobStore(), client: FAST_CLIENT });
	t.after(() => backend.close());
	assert.equal((await backend.snapshot()).messages.length, 2);
});

test("host errors after the join surface as notices; assistant errors raise attention (limit vs error)", async t => {
	const { host, events, attention } = await setup(t, {});
	host.send({ t: "error", message: "prompting is unavailable until the host finishes starting up" });
	host.appendEntry(assistantEntry([], 7000, undefined, { stopReason: "error", errorMessage: "You have hit your usage limit" }));
	host.appendEntry(assistantEntry([], 8000, undefined, { stopReason: "error", errorMessage: "provider exploded" }));
	await waitUntil(() => attention.length === 2, 2000, "attention");
	assert.deepEqual(attention.map(a => a.kind), ["limit", "error"]);
	assert.deepEqual(events.find(e => e.k === "notice"), { k: "notice", level: "error", message: "prompting is unavailable until the host finishes starting up" });
});

test("images in entries become blob refs; tool output pages through toolOutput()", async t => {
	const png = Buffer.from("iVBORw0KGgo=", "base64");
	const big = "line\n".repeat(80_000); // 400 KB
	const { relay, url } = await startTestRelay();
	t.after(() => relay.close());
	const host = new FakeCollabHost({
		relayUrl: url,
		entries: [
			{ id: "img1", parentId: null, timestamp: new Date(1).toISOString(), type: "message", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], timestamp: 1 } },
			toolResultEntry("big", "bash", big, 2),
		],
	});
	await host.start();
	t.after(() => host.close());
	const blobs = createBlobStore();
	const backend = await TuiBackend.attach({ sid: "t_i", link: parseLink(host.link), blobs, client: FAST_CLIENT });
	t.after(() => backend.close());
	const snap = await backend.snapshot();
	const image = snap.messages[0]!.content[1]!;
	assert.equal(image.type, "image");
	if (image.type !== "image") throw new Error("unreachable");
	assert.equal(image.bytes, png.byteLength);
	assert.deepEqual(Buffer.from(blobs.get(image.ref)!.bytes), png);
	const tr = snap.messages[1]!.content[0]!;
	assert.equal(tr.type === "text" && tr.truncated, true, "toolResult text is cut to 32 KiB in messages");

	const p1 = await backend.toolOutput("big", 0);
	assert.equal(Buffer.byteLength(p1.text), 256 * 1024);
	assert.equal(p1.next, 256 * 1024);
	const p2 = await backend.toolOutput("big", p1.next!);
	assert.equal(Buffer.byteLength(p2.text), big.length - 256 * 1024);
	assert.equal(p2.next, undefined);
});
