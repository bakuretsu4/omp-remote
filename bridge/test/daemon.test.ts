/** Hermetic end-to-end: real daemon + embedded relay + reference app client, with a fake omp. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { BridgeDaemon, connectControl } from "../src/daemon.ts";
import { paths, parseConfig, saveConfig } from "../src/config.ts";
import { createIdentity } from "../src/identity.ts";
import { OmprClient, RpcFailure, pair, type PairedHost } from "./e2e-client.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

async function freePort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
	return promise;
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-daemon-")));
const home = join(tmp, "home");
const root = join(tmp, "root");
let daemon: BridgeDaemon;
let host: PairedHost;
let lanPort: number;

before(async () => {
	mkdirSync(join(root, "proj"), { recursive: true });
	symlinkSync(tmp, join(root, "proj", "up"));
	const localPort = await freePort();
	lanPort = await freePort();
	const cfg = parseConfig({
		name: "test-host", lan: true, lanAddress: "127.0.0.1", localPort, lanPort, roots: [root],
		omp: { bin: FAKE }, tui: { enabled: false }, inhibitSleepWhileWorking: false,
	});
	createIdentity(home);
	saveConfig(cfg, home);
	daemon = new BridgeDaemon({ dir: home, config: cfg, log: () => {} });
	await daemon.start();
	const session = daemon.pairing.begin({ relays: daemon.relayUrlsForPairing });
	host = await pair(session.link, { label: "Test phone" });
});

after(async () => {
	await daemon.stop();
	rmSync(tmp, { recursive: true, force: true });
});

describe("daemon", () => {
	it("keeps state private (0700 dir, 0600 files) and exposes a control socket", async () => {
		assert.equal(statSync(home).mode & 0o777, 0o700);
		for (const f of ["identity.json", "devices.json", "config.json"]) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600, f);
		const s = await connectControl(home);
		assert.ok(s);
		s!.destroy();
		assert.equal(statSync(paths(home).ctl).isSocket(), true);
	});

	it("pairs, handshakes through the LAN relay and serves host.info / fs", async () => {
		assert.equal(host.relays[0], `ws://127.0.0.1:${lanPort}`);
		const c = await OmprClient.connect(host, { caps: ["notify"] });
		assert.equal(c.hostInfo.hostId, host.hostId);
		const info = await c.req("host.info", {});
		assert.equal(info.name, "test-host");
		assert.equal(info.ompVersion, "0.0.0-fake");
		assert.deepEqual((await c.req("fs.roots", {})).roots, [root]);
		await assert.rejects(() => c.req("fs.list", { path: join(root, "proj", "up") }), (e: unknown) => e instanceof RpcFailure && e.code === "forbidden_path");
		await assert.rejects(() => c.req("sessions.create", { cwd: tmp }), (e: unknown) => e instanceof RpcFailure && e.code === "forbidden_path");
		await assert.rejects(() => c.req("nope" as never, {} as never), (e: unknown) => e instanceof RpcFailure && e.code === "unsupported");
		c.close();
	});

	it("runs a managed session through approval, with attention items and events", async () => {
		const c = await OmprClient.connect(host);
		const { sid } = await c.req("sessions.create", { cwd: join(root, "proj"), approvalMode: "always-ask", prompt: "please approve" });
		assert.match(sid, /^m_/);
		const { snapshot, n } = await c.req("session.open", { sid });
		assert.equal(snapshot.summary.approvalMode, "always-ask");
		assert.ok(n >= 0);
		// The request may already be pending in the snapshot (that is what snapshots are for) or arrive as an event.
		const req = (snapshot.pendingUi[0] ?? ((await c.waitEvent(e => e.k === "ui.request", 20_000, "ui.request")).e as { request: typeof snapshot.pendingUi[0] }).request) as { kind: string; reqId: string; tool: string };
		assert.equal(req.kind, "approval");
		assert.equal(req.tool, "bash");
		const open = (await c.req("attention.list", {})).items.find(i => i.kind === "approval")!;
		assert.equal(open.resolved, false);
		await c.req("ui.respond", { sid, reqId: req.reqId, answer: { value: "Approve" } });
		const end = await c.waitEvent(e => e.k === "tool.end", 20_000, "tool.end");
		assert.match((end.e as { output: string }).output, /hi/);
		await c.waitEvent(e => e.k === "agent.end", 20_000, "agent.end");
		const items = (await c.req("attention.list", {})).items;
		assert.equal(items.find(i => i.id === open.id)!.resolved, true);
		assert.ok(items.some(i => i.kind === "done"));
		const ns = c.events.filter(r => r.sid === sid).map(r => r.n);
		assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
		assert.equal(new Set(ns).size, ns.length, "strictly increasing event indices");
		const list = await c.req("sessions.list", {});
		assert.equal(list.sessions.find(s => s.sid === sid)!.status, "idle");
		await c.req("sessions.stop", { sid });
		assert.equal((await c.req("sessions.list", {})).sessions.some(s => s.sid === sid), false);
		c.close();
	});

	it("revoking a device gives it silence and refuses new handshakes", async () => {
		const link = daemon.pairing.begin({ relays: daemon.relayUrlsForPairing }).link;
		const second = await pair(link, { label: "stolen" });
		const live = await OmprClient.connect(second);
		await live.req("host.info", {});
		assert.equal(daemon.devices.revoke(second.did), true);
		assert.equal(await live.expectSilence("host.info", {}, 800), true);
		await assert.rejects(() => OmprClient.connect(second, { timeoutMs: 800 }), /silence|closed/);
		live.close();
		// the first device is unaffected
		const ok = await OmprClient.connect(host);
		await ok.req("host.info", {});
		ok.close();
	});

	it("a pairing token cannot be reused", async () => {
		const link = daemon.pairing.begin({ relays: daemon.relayUrlsForPairing }).link;
		await pair(link, { label: "first" });
		await assert.rejects(() => pair(link, { label: "again", timeoutMs: 800 }), /timed out|closed/);
	});
});
