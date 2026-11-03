/**
 * Live extras against the running daemon + real omp: `ompr pair` with the terminal confirmation (answers y),
 * models.list, session.set (thinking + approval-mode restart), session.fork, abort, rename.
 * Uses two tiny prompts. Run after e2e/live.ts setup (same OMPR_HOME / roots).
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { OmprClient, RpcFailure, pair } from "../test/e2e-client.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const LIVE_ROOT = process.env.LIVE_ROOT ?? "/tmp/ompr-live";
const ok = (s: string): void => console.log(`   ok: ${s}`);
const step = (s: string): void => console.log(`\n== ${s}`);

async function main(): Promise<void> {
	const cwd = join(LIVE_ROOT, "work2");
	mkdirSync(cwd, { recursive: true });

	step("ompr pair (with confirmation: answer y on the terminal)");
	const child = spawn(process.execPath, [CLI, "pair"], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
	child.on("exit", c => console.log(`   (ompr pair exited ${c})`));
	const rl = createInterface({ input: child.stdout });
	const link = Promise.withResolvers<string>();
	const confirmed = Promise.withResolvers<string>();
	rl.on("line", l => {
		if (l.startsWith("ompr://pair?")) link.resolve(l.trim());
		if (l.includes("Paired \"")) confirmed.resolve(l.slice(l.indexOf("Paired")));
	});
	child.stdout.on("data", (d: Buffer) => {
		if (String(d).includes("[y/N]")) {
			console.log(`   prompt on terminal: ${String(d).trim().split("\n").pop()}`);
			child.stdin.write("y\n");
		}
	});
	const host = await pair(await link.promise, { label: "confirmed phone" });
	ok(`bridge printed: ${await confirmed.promise}`);
	const c = await OmprClient.connect(host);

	step("models.list");
	const models = await c.req("models.list", {}, 120_000);
	assert.ok(models.models.length > 3);
	ok(`${models.models.length} models, e.g. ${models.models[0]!.provider}/${models.models[0]!.id} levels=${JSON.stringify(models.models[0]!.thinkingLevels)}`);

	step("create a session (tiny prompt), set thinking, restart with approval mode write, rename");
	const { sid } = await c.req("sessions.create", { cwd, approvalMode: "always-ask", prompt: "Reply with just: ok" }, 120_000);
	await c.req("session.open", { sid });
	await c.waitEvent(e => e.k === "agent.end", 180_000, "agent.end");
	const set1 = await c.req("session.set", { sid, thinkingLevel: "low" });
	assert.equal(set1.state.thinkingLevel, "low");
	ok(`thinkingLevel → ${set1.state.thinkingLevel}`);
	await c.req("sessions.rename", { sid, name: "Phone renamed" });
	const set2 = await c.req("session.set", { sid, approvalMode: "write" }, 120_000);
	assert.equal(set2.state.approvalMode, "write");
	const after = await c.req("session.open", { sid });
	assert.equal(after.snapshot.summary.approvalMode, "write");
	assert.ok(after.snapshot.messages.length >= 2, "transcript survived the restart");
	ok(`approval mode → write (omp restarted on the same session file), ${after.snapshot.messages.length} messages kept, title "${after.snapshot.summary.title}"`);

	step("session.fork → new managed session, original untouched");
	const fork = await c.req("session.fork", { sid }, 120_000);
	assert.notEqual(fork.sid, sid);
	const fsnap = await c.req("session.open", { sid: fork.sid });
	ok(`fork ${fork.sid} (${fsnap.snapshot.messages.length} messages) from ${sid}`);
	const list = await c.req("sessions.list", {});
	assert.ok(list.sessions.some(s => s.sid === sid) && list.sessions.some(s => s.sid === fork.sid));
	assert.notEqual(list.sessions.find(s => s.sid === sid)!.sessionFile, list.sessions.find(s => s.sid === fork.sid)!.sessionFile);
	ok("two live sessions with different session files");

	step("abort while idle is harmless; queue ops report cleanly");
	const ab = await c.req("session.abort", { sid });
	ok(`abort → ${JSON.stringify(ab)}`);
	await assert.rejects(() => c.req("session.prompt", { sid: "m_nope", message: "x" }), (e: unknown) => e instanceof RpcFailure && e.code === "not_found");

	await c.req("sessions.stop", { sid });
	await c.req("sessions.stop", { sid: fork.sid });
	c.close();
	console.log("\nLIVE EXTRA PASSED");
}

main().then(() => process.exit(0), e => {
	console.error("\nLIVE EXTRA FAILED:", e);
	process.exit(1);
});
