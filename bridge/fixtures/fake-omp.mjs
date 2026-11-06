#!/usr/bin/env node
// Minimal stand-in for `omp --mode rpc-ui` (omp://rpc.md) used by the managed-backend tests.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

if (process.argv.includes("--version")) {
	console.log("omp/0.0.0-fake");
	process.exit(0);
}

// `omp session lease --json -- <id>...`: which sessions a running omp holds. Tests set FAKE_LEASE_HELD / FAKE_LEASE_UNKNOWN (comma-separated ids).
if (process.argv[2] === "session" && process.argv[3] === "lease") {
	const csv = name => (process.env[name] ?? "").split(",").filter(Boolean);
	const ids = process.argv.slice(process.argv.indexOf("--") + 1);
	console.log(JSON.stringify({ held: ids.filter(i => csv("FAKE_LEASE_HELD").includes(i)), unknown: ids.filter(i => csv("FAKE_LEASE_UNKNOWN").includes(i)) }));
	process.exit(0);
}

// `omp usage --help` / `omp usage --json`: serves fixtures/usage.sample.json (invented data). FAKE_USAGE_FAIL=1 makes `--json` fail.
if (process.argv[2] === "usage") {
	if (process.argv.includes("--help")) {
		console.log("Show provider usage limits for every authenticated account");
		process.exit(0);
	}
	if (process.env.FAKE_USAGE_FAIL) {
		console.error("fake usage failure");
		process.exit(3);
	}
	process.stdout.write(readFileSync(new URL("./usage.sample.json", import.meta.url)));
	process.exit(0);
}

const out = o => process.stdout.write(`${JSON.stringify(o)}\n`);
let v2 = false;
let n = 0;
let uiWaiter;
const state = { model: { provider: "fake", id: "fake-1", name: "Fake 1", contextWindow: 1000 }, thinkingLevel: "high", isStreaming: false, isCompacting: false, sessionId: "fake-session", queuedMessages: { steering: [], followUp: [], liveSteered: 0 }, todoPhases: [], goal: null, fastModeEnabled: false, tokensPerSecond: null };
if (process.env.FAKE_SESSION_FILE) state.sessionFile = process.env.FAKE_SESSION_FILE;

function respond(id, command, data) {
	const frame = { id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
	if (v2 && JSON.stringify(frame).length > 600) {
		const bytes = Buffer.from(JSON.stringify(frame));
		const half = Math.ceil(bytes.length / 2);
		const parts = [bytes.subarray(0, half), bytes.subarray(half)];
		const chunkId = `c${++n}`;
		parts.forEach((p, index) => out({ type: "rpc_chunk", chunkId, index, count: parts.length, byteLength: bytes.length, data: p.toString("base64") }));
		return;
	}
	out(frame);
}

const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, model: "fake-1", stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, timestamp: Date.now() });

async function runTurn(message) {
	state.isStreaming = true;
	out({ type: "agent_start" });
	const user = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
	out({ type: "message_start", message: user, messageId: `msg-${++n}` });
	out({ type: "message_end", message: user, messageId: `msg-${n}` });
	if (message.includes("approve")) {
		const call = { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } };
		const a1 = assistant([call], "toolUse");
		out({ type: "message_start", message: a1, messageId: `msg-${++n}` });
		out({ type: "message_end", message: a1, messageId: `msg-${n}` });
		out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" }, intent: "Running echo" });
		const reqId = `ui_${++n}`;
		out({ type: "extension_ui_request", id: reqId, method: "select", title: "Allow tool: bash\nCommand: echo hi", options: ["Approve", "Approve bash for this session", "Deny"] });
		const answer = await new Promise(res => (uiWaiter = res));
		const ok = typeof answer.value === "string" && answer.value.startsWith("Approve");
		const text = ok ? "hi\n" : "denied";
		out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text }] }, isError: !ok });
		const tr = { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text }], isError: !ok, timestamp: Date.now() };
		out({ type: "message_start", message: tr, messageId: `msg-${++n}` });
		out({ type: "message_end", message: tr, messageId: `msg-${n}` });
	}
	if (message.includes("ask")) {
		const reqId = `ui_${++n}`;
		out({ type: "extension_ui_request", id: reqId, method: "ask", questions: [{ id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] });
		await new Promise(res => (uiWaiter = res));
	}
	const a2 = assistant([{ type: "text", text: "done" }]);
	const mid = `msg-${++n}`;
	out({ type: "message_start", message: assistant([{ type: "text", text: "" }]), messageId: mid });
	for (let i = 1; i <= 20; i++) out({ type: "message_update", message: assistant([{ type: "text", text: "d".repeat(i) }]), messageId: mid, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "d" } });
	out({ type: "message_end", message: a2, messageId: mid });
	state.isStreaming = false;
	out({ type: "agent_end", messages: [user, a2], isTerminal: true, yielded: true });
	out({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
	out({ type: "session_settled" });
}

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
	const f = JSON.parse(line);
	switch (f.type) {
		case "extension_ui_response":
			uiWaiter?.(f);
			return;
		case "negotiate_protocol":
			v2 = true;
			return respond(f.id, f.type, { protocolVersion: 2 });
		case "get_state":
			return respond(f.id, f.type, state);
		case "get_subagents":
			return respond(f.id, f.type, { subagents: [] });
		case "get_available_models":
			return respond(f.id, f.type, { models: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, provider: "fake", name: `Model ${i} ${"x".repeat(20)}`, reasoning: i % 2 === 0, thinking: { efforts: ["low", "high"] } })) });
		case "prompt":
			if (f.message.includes("crash")) {
				respond(f.id, f.type);
				process.stderr.write("fake omp exploded\n");
				process.exit(3);
			}
			respond(f.id, f.type);
			void runTurn(f.message);
			return;
		case "abort_and_restore_queue":
			return respond(f.id, f.type, { steering: [{ text: "queued" }], followUp: [] });
		case "set_session_name":
			state.sessionName = f.name;
			return respond(f.id, f.type);
		default:
			return respond(f.id, f.type, {});
	}
});
rl.on("close", () => process.exit(0));
