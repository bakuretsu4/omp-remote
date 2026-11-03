/**
 * Live end-to-end of "phone as agent tools" (PROTOCOL.md §6.6) against a running `ompr run` and the REAL omp binary
 * (spends a few tokens). The Node reference client plays the phone: it advertises device capabilities, answers
 * `hosttool.call` events, and approves omp's tool prompts.
 *
 *   export OMPR_HOME=/tmp/ompr-ht
 *   node bridge/src/cli.ts init --name ht   # then edit config.json: localPort, roots, tui.enabled=false, omp.sessionDir
 *   node bridge/src/cli.ts run &
 *   node bridge/e2e/live-hosttools.ts
 *
 * Asserts: the agent really calls phone_notify, phone_location, phone_clipboard_set and phone_camera_photo with the right
 * arguments, receives the text and IMAGE results we send, and uses them in its answer.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync, crc32 } from "node:zlib";
import type { HostEvent } from "../../protocol/src/index.ts";
import { OmprClient, pair } from "../test/e2e-client.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = process.env.LIVE_ROOT ?? "/tmp/ompr-ht-root";
const RELAY = process.env.LIVE_RELAY ?? "ws://127.0.0.1:7693";
const step = (s: string): void => console.log(`\n== ${s}`);
const ok = (s: string): void => console.log(`   ok: ${s}`);

/** A solid-colour PNG, built by hand so the script needs no image library. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function captureLink(): Promise<string> {
	const child = spawn(process.execPath, [CLI, "pair", "--no-confirm"], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	createInterface({ input: child.stdout }).on("line", l => {
		if (l.startsWith("ompr://pair?")) resolve(l.trim());
	});
	child.once("exit", c => reject(new Error(`ompr pair exited early (${c})`)));
	return promise;
}

async function main(): Promise<void> {
	const cwd = join(ROOT, "work");
	mkdirSync(cwd, { recursive: true });

	step("pair the reference client as a phone with all four tool capabilities");
	const link = await captureLink();
	const host = await pair(link, { relay: RELAY, label: "e2e phone" });
	const c = await OmprClient.connect(host, { relay: RELAY, caps: ["location", "clipboard", "notify", "camera"], label: "e2e phone" });
	ok(`paired and connected: did ${host.did}`);

	// Answer tool calls and approvals as they arrive.
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const handled = new Set<string>();
	let stop = false;
	const answer = async (call: Extract<HostEvent, { k: "hosttool.call" }>): Promise<void> => {
		calls.push({ tool: call.tool, args: call.args });
		const text = (t: string) => ({ callId: call.callId, ok: true, content: [{ type: "text" as const, text: t }] });
		switch (call.tool) {
			case "phone_notify":
				await c.req("hosttool.result", text("Notification shown."));
				break;
			case "phone_location":
				await c.req("hosttool.result", text(JSON.stringify({ latitude: 59.329323, longitude: 18.068581, accuracyMeters: 12, provider: "gps", fixAgeSeconds: 2 })));
				break;
			case "phone_clipboard_set":
				await c.req("hosttool.result", text(`Copied ${String(call.args.text ?? "").length} characters to the phone clipboard.`));
				break;
			case "phone_camera_photo":
				await c.req("hosttool.result", {
					callId: call.callId, ok: true,
					content: [{ type: "image" as const, data: solidPng(48, 48, [220, 20, 20]).toString("base64"), mimeType: "image/png" }],
				});
				break;
			default:
				await c.req("hosttool.result", { callId: call.callId, ok: false, error: `unexpected tool ${call.tool}` });
		}
	};
	const pump = (async () => {
		while (!stop) {
			for (const h of [...c.hevs]) {
				if (h.k === "hosttool.call" && !handled.has(h.callId)) {
					handled.add(h.callId);
					await answer(h).catch(e => console.log(`   (answer failed: ${(e as Error).message})`));
				}
			}
			for (const r of [...c.events]) {
				const e = r.e;
				if (e.k === "ui.request" && e.request.kind === "approval" && !handled.has(e.request.reqId)) {
					handled.add(e.request.reqId);
					console.log(`   approving: ${e.request.tool} ${e.request.detail.split("\n")[0]}`);
					await c.req("ui.respond", { sid: r.sid, reqId: e.request.reqId, answer: { value: "Approve" } }).catch(() => {});
				}
			}
			await sleep(100);
		}
	})();

	step("sessions.create with hostTools: true and a prompt that needs all four tools");
	const { sid } = await c.req("sessions.create", {
		cwd, approvalMode: "write", hostTools: true,
		prompt:
			"You can use the user's phone through tools named phone_*. Do these in order: " +
			"1) phone_notify with title 'e2e' and message 'hello'. 2) phone_location. 3) phone_clipboard_set with text 'abc'. " +
			"4) phone_camera_photo. Then reply with ONE line: the latitude you received, then the dominant colour of the photo in one word.",
	});
	ok(`session ${sid}`);

	// Events only stream to a peer that opened the session. An approval raised before we subscribed is in the snapshot.
	const opened = await c.req("session.open", { sid });
	for (const u of opened.snapshot.pendingUi) {
		if (u.kind === "approval" && !handled.has(u.reqId)) {
			handled.add(u.reqId);
			console.log(`   approving (pending at open): ${u.tool} ${u.detail.split("\n")[0]}`);
			await c.req("ui.respond", { sid, reqId: u.reqId, answer: { value: "Approve" } });
		}
	}

	const end = await c.waitEvent((e, r) => r.sid === sid && e.k === "agent.end", 240_000, "agent.end");
	void end;
	stop = true;
	await pump;

	step("check what the agent actually did");
	const names = calls.map(x => x.tool);
	console.log(`   tool calls: ${names.join(", ")}`);
	for (const t of ["phone_notify", "phone_location", "phone_clipboard_set", "phone_camera_photo"]) assert.ok(names.includes(t), `agent never called ${t}`);
	const notify = calls.find(x => x.tool === "phone_notify")!;
	assert.equal(notify.args.title, "e2e");
	assert.equal(notify.args.message, "hello");
	assert.equal(calls.find(x => x.tool === "phone_clipboard_set")!.args.text, "abc");
	ok("all four tools called with the right arguments");

	const snap = await c.req("session.open", { sid });
	const finalText = snap.snapshot.messages
		.filter(m => m.role === "assistant")
		.flatMap(m => m.content)
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map(b => b.text)
		.join("\n");
	console.log(`   agent said: ${finalText.trim().split("\n").pop()}`);
	assert.match(finalText, /59\.3/, "the agent did not use the location we returned");
	assert.match(finalText, /red/i, "the agent did not see the image we returned (should say red)");
	ok("the agent used the text result (latitude) and the image result (red)");

	step("cleanup");
	await c.req("sessions.stop", { sid }).catch(() => {});
	c.close();
	console.log("\nALL OK");
}

main().then(() => process.exit(0), e => {
	console.error("\nFAILED:", e);
	process.exit(1);
});
