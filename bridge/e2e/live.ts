/**
 * Live end-to-end against a running `ompr run` and the REAL omp binary (spends a few tokens).
 *
 *   export OMPR_HOME=/tmp/ompr-test
 *   node bridge/src/cli.ts init --name e2e && <edit config: lan/roots/omp.sessionDir/tui.enabled=false>
 *   node bridge/src/cli.ts run &            # daemon
 *   node bridge/e2e/live.ts                 # this script
 *
 * Steps: `ompr pair --no-confirm` (captured link) → pair → sessions.create (always-ask) with a bash prompt →
 * approval via ui.respond → tool.end containing bridge-ok → agent.end → attention approval+done → fs.list escape →
 * image upload + prompt attachment → sessions.stop → sessions.list recent → sessions.open (resume) →
 * devices.revoke → silence.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { OmprClient, RpcFailure, pair } from "../test/e2e-client.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const LIVE_ROOT = process.env.LIVE_ROOT ?? "/tmp/ompr-live";
const step = (s: string): void => console.log(`\n== ${s}`);
const ok = (s: string): void => console.log(`   ok: ${s}`);

async function captureLink(): Promise<string> {
	const child = spawn(process.execPath, [CLI, "pair", "--no-confirm"], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	createInterface({ input: child.stdout }).on("line", l => {
		if (l.startsWith("ompr://pair?")) resolve(l.trim());
	});
	child.once("exit", c => reject(new Error(`ompr pair exited early (${c})`)));
	const link = await promise;
	// keep the pair command alive (it waits for the phone) – it exits by itself after pairing
	child.on("exit", () => {});
	return link;
}

async function main(): Promise<void> {
	const cwd = join(LIVE_ROOT, "work");
	mkdirSync(cwd, { recursive: true });

	step("ompr pair --no-confirm → link");
	const link = await captureLink();
	console.log(`   link captured (${link.length} chars; token not printed)`);

	step("pair with the reference client through the embedded relay");
	const host = await pair(link, { label: "e2e live" });
	ok(`paired: did ${host.did}, host ${host.hostId}, relay ${host.relays[0]}`);
	const c = await OmprClient.connect(host, { caps: ["notify"] });
	const info = await c.req("host.info", {});
	ok(`host.info: omp ${info.ompVersion}, roots ${JSON.stringify(info.roots)}`);

	step("sessions.create (always-ask) with a bash prompt");
	const { sid } = await c.req("sessions.create", {
		cwd, approvalMode: "always-ask",
		prompt: "Run the bash command `echo bridge-ok`, then reply with just: done",
	}, 120_000);
	ok(`sid ${sid}`);
	const opened = await c.req("session.open", { sid });
	ok(`snapshot: status ${opened.snapshot.summary.status}, model ${opened.snapshot.summary.model?.id}, caps ${opened.snapshot.summary.caps.length}`);

	step("approval");
	const pending = opened.snapshot.pendingUi[0];
	const ui = pending ?? ((await c.waitEvent(e => e.k === "ui.request", 180_000, "ui.request")).e as { request: typeof pending }).request!;
	assert.equal(ui!.kind, "approval");
	if (ui!.kind === "approval") ok(`ui.request approval: tool=${ui.tool} detail=${JSON.stringify(ui.detail)} options=${JSON.stringify(ui.options)}`);
	const items1 = (await c.req("attention.list", {})).items;
	const appr = items1.find(i => i.kind === "approval" && i.uiReqId === ui!.reqId);
	assert.ok(appr && !appr.resolved, "attention approval item exists");
	ok(`attention: ${appr.kind} "${appr.summary}"`);
	await c.req("ui.respond", { sid, reqId: ui!.reqId, answer: { value: "Approve" } });
	ok("answered Approve");

	step("tool.end + agent.end");
	const end = await c.waitEvent(e => e.k === "tool.end", 180_000, "tool.end");
	const out = (end.e as { output: string }).output;
	assert.match(out, /bridge-ok/);
	ok(`tool.end output ${JSON.stringify(out.trim())}`);
	await c.waitEvent(e => e.k === "agent.end", 180_000, "agent.end");
	ok("agent.end");
	const items2 = (await c.req("attention.list", {})).items;
	assert.equal(items2.find(i => i.id === appr.id)!.resolved, true, "approval item resolved after answer");
	const done = items2.find(i => i.kind === "done" && i.sid === sid);
	assert.ok(done, "done attention item");
	ok(`attention: approval resolved, done "${done.summary}"`);
	const order = c.hevs.filter(h => h.k === "attention").map(h => (h as { item: { kind: string } }).item.kind);
	assert.deepEqual(order.filter(k => k === "approval" || k === "done").slice(0, 2), ["approval", "done"]);
	ok(`attention host events in order: ${order.join(" → ")}`);

	step("fs.list escape attempts");
	mkdirSync(LIVE_ROOT, { recursive: true });
	const outside = mkdtempSync(join(tmpdir(), "ompr-outside-"));
	try { symlinkSync(outside, join(cwd, "escape-link")); } catch { /* exists */ }
	for (const p of ["/etc", join(cwd, "..", ".."), join(cwd, "escape-link"), outside]) {
		await assert.rejects(() => c.req("fs.list", { path: p }), (e: unknown) => e instanceof RpcFailure && e.code === "forbidden_path");
		ok(`forbidden_path for ${p}`);
	}
	const listing = await c.req("fs.list", { path: cwd, files: true });
	assert.ok(!listing.entries.some(e => e.name === "escape-link"));
	ok(`fs.list(${cwd}) → ${listing.entries.length} entries, escape-link hidden`);

	step("upload image + prompt with attachment");
	const { uploadId } = await c.req("upload.begin", { name: "dot.png", mime: "image/png", size: PNG.length, purpose: "image" });
	await c.req("upload.chunk", { uploadId, i: 0, d: PNG.toString("base64") });
	const { ref } = await c.req("upload.end", { uploadId });
	ok(`image ref ${ref}`);
	const before = c.events.length;
	await c.req("session.prompt", { sid, message: "This is a test image. Reply with just: ok", attachments: [{ ref }] });
	await c.waitEvent((e, r) => e.k === "agent.end" && c.events.indexOf(r) >= before, 180_000, "second agent.end");
	const snap = await c.req("session.open", { sid });
	const userMsg = [...snap.snapshot.messages].reverse().find(m => m.role === "user")!;
	assert.ok(userMsg.content.some(b => b.type === "image"), "user message carries an image block");
	const imgBlock = userMsg.content.find(b => b.type === "image");
	if (imgBlock?.type === "image") {
		const blob = await c.req("blob.get", { ref: imgBlock.ref });
		assert.equal(Buffer.from(blob.data, "base64").length, imgBlock.bytes); // omp re-encodes attachments, so compare with the block, not the upload
		ok(`user message has image block (${imgBlock.mimeType}, ${imgBlock.bytes} B) and blob.get returns it`);
	}

	step("sessions.stop → sessions.list recent → sessions.open (resume)");
	await c.req("sessions.stop", { sid });
	const list = await c.req("sessions.list", { recent: 10 });
	assert.ok(!list.sessions.some(s => s.sid === sid && s.kind === "managed"));
	const recent = list.sessions.find(s => s.kind === "recent" && s.cwd.includes("ompr-live"));
	assert.ok(recent, "recent session listed after stop");
	ok(`recent: ${recent.sid} "${recent.title}" ${recent.sessionFile}`);
	const reopened = await c.req("sessions.open", { sessionFile: recent.sessionFile! }, 120_000);
	const snap2 = await c.req("session.open", { sid: reopened.sid });
	assert.ok(snap2.snapshot.messages.length >= 4, `resumed transcript has history (got ${snap2.snapshot.messages.length})`);
	ok(`resumed as ${reopened.sid} with ${snap2.snapshot.messages.length} messages`);
	await c.req("sessions.stop", { sid: reopened.sid });

	step("devices.revoke → silence");
	await c.req("devices.revoke", { did: host.did });
	await new Promise(r => setTimeout(r, 300));
	const silent = await c.expectSilence("host.info", {}, 1500);
	assert.equal(silent, true);
	ok("no reply after revoke");
	await assert.rejects(() => OmprClient.connect(host, { timeoutMs: 1500 }), /silence|closed/);
	ok("new handshake gets silence");
	c.close();
	console.log("\nLIVE E2E PASSED");
}

main().then(() => process.exit(0), e => {
	console.error("\nLIVE E2E FAILED:", e);
	process.exit(1);
});
