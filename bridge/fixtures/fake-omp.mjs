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

const sleep = ms => new Promise(res => setTimeout(res, ms));

const DEMO_THINKING = [
	"The user wants a tour of the transcript.",
	"I should read the file first, run the build, then try a small edit.",
	"The edit may fail because the anchor text changed, which is a good case to show.",
].join("\n");

const DEMO_MARKDOWN = [
	"## Demo walkthrough",
	"",
	"This is a **long markdown** reply with `inline code`, so the app can show its typography, spacing and code blocks.",
	"",
	"Things this reply covers:",
	"",
	"- a heading and a paragraph with **bold** text",
	"- a bulleted list like this one",
	"- tool calls in three different states",
	"",
	"Steps I will take:",
	"",
	"1. Read the build file",
	"2. Run the build and show its output",
	"3. Apply an edit (this one will fail)",
	"",
	"A small Kotlin snippet:",
	"",
	"```kotlin",
	"fun greet(name: String): String {",
	"    val shout = name.uppercase()",
	"    return \"Hello, $shout!\"",
	"}",
	"```",
	"",
	"| Tool | Result | Time |",
	"| --- | --- | --- |",
	"| read | ok | 12 ms |",
	"| bash | ok | 1.4 s |",
	"| edit | failed | 3 ms |",
	"",
	"Starting now.",
].join("\n");

const DEMO_BUILD_OUTPUT = [
	"> Task :app:compileKotlin",
	"> Task :app:compileJava NO-SOURCE",
	"> Task :app:processResources",
	"> Task :app:classes",
	"> Task :app:jar",
	"",
	"BUILD SUCCESSFUL in 4s",
	"5 actionable tasks: 5 executed",
].join("\n");

/** One tool execution: start, optional update, end, then the toolResult message (the shape the approve path emits). */
async function demoTool(id, name, args, intent, text, isError = false) {
	out({ type: "tool_execution_start", toolCallId: id, toolName: name, args, intent });
	await sleep(300);
	out({ type: "tool_execution_update", toolCallId: id, toolName: name, args, partialResult: { content: [{ type: "text", text: text.split("\n")[0] }] } });
	await sleep(300);
	out({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text }] }, isError });
	const tr = { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: Date.now() };
	out({ type: "message_start", message: tr, messageId: `msg-${++n}` });
	out({ type: "message_end", message: tr, messageId: `msg-${n}` });
}

/** The `demo` prompt: thinking, long markdown, tool calls that succeed and fail, then a final text. Needs no approval. */
async function demoTurn(user) {
	const calls = [
		{ type: "toolCall", id: "demo_read", name: "read", arguments: { path: "build.gradle.kts" }, intent: "Reading the build file" },
		{ type: "toolCall", id: "demo_bash", name: "bash", arguments: { command: "./gradlew assemble" }, intent: "Running the build" },
		{ type: "toolCall", id: "demo_edit", name: "edit", arguments: { path: "src/Main.kt", oldText: "fun main()", newText: "suspend fun main()" }, intent: "Making main suspend" },
	];
	const mid = `msg-${++n}`;
	const thinking = { type: "thinking", thinking: "" };
	out({ type: "message_start", message: assistant([thinking]), messageId: mid });
	const thoughtLines = DEMO_THINKING.split("\n");
	for (let i = 1; i <= thoughtLines.length; i++) {
		const partial = { type: "thinking", thinking: thoughtLines.slice(0, i).join("\n") };
		out({ type: "message_update", message: assistant([partial]), messageId: mid, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thoughtLines[i - 1] } });
		await sleep(60);
	}
	const think = { type: "thinking", thinking: DEMO_THINKING };
	const mdLines = DEMO_MARKDOWN.split("\n");
	for (let i = 1; i <= mdLines.length; i++) {
		const partial = { type: "text", text: mdLines.slice(0, i).join("\n") };
		out({ type: "message_update", message: assistant([think, partial]), messageId: mid, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `${mdLines[i - 1]}\n` } });
		await sleep(25);
	}
	const a1 = assistant([think, { type: "text", text: DEMO_MARKDOWN }, ...calls], "toolUse");
	out({ type: "message_end", message: a1, messageId: mid });

	await demoTool("demo_read", "read", calls[0].arguments, calls[0].intent, "plugins {\n    kotlin(\"jvm\") version \"2.0.21\"\n}\n\nrepositories {\n    mavenCentral()\n}");
	await demoTool("demo_bash", "bash", calls[1].arguments, calls[1].intent, DEMO_BUILD_OUTPUT);
	await demoTool("demo_edit", "edit", calls[2].arguments, calls[2].intent, "Error: could not find the text to replace in src/Main.kt.\nThe file has changed since it was read; read it again and retry.", true);

	const a2 = assistant([{ type: "text", text: "The read and the build worked. The edit failed because the file no longer contains `fun main()`; that is the end of this demo." }]);
	const fid = `msg-${++n}`;
	out({ type: "message_start", message: assistant([{ type: "text", text: "" }]), messageId: fid });
	out({ type: "message_end", message: a2, messageId: fid });
	state.isStreaming = false;
	out({ type: "agent_end", messages: [user, a1, a2], isTerminal: true, yielded: true });
	out({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
	out({ type: "session_settled" });
}

async function runTurn(message) {
	state.isStreaming = true;
	out({ type: "agent_start" });
	const user = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
	out({ type: "message_start", message: user, messageId: `msg-${++n}` });
	out({ type: "message_end", message: user, messageId: `msg-${n}` });
	if (message.includes("demo")) return demoTurn(user);
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
