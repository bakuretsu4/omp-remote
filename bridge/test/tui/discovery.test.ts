import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBlobStore } from "../../src/normalize/blobs.ts";
import type { WireEntry } from "../../src/tui/collab-wire.ts";
import type { RegistryHost } from "../../src/tui/tui-backend.ts";
import type { TuiBackend } from "../../src/tui/tui-backend.ts";
import { TuiDiscovery, sidFor } from "../../src/tui/discovery.ts";
import { FakeCollabHost, assistantEntry, sleep, startTestRelay, userEntry, waitUntil } from "./helpers.ts";

/** A stand-in for the `omp` CLI: serves `collab list --json` / `collab link … --json` from a JSON state file. */
const FAKE_OMP = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.FAKE_OMP_STATE, "utf8"));
const [, action, ...rest] = process.argv.slice(2);
const args = process.argv.slice(2);
if (args[0] !== "collab") { console.error("unexpected args"); process.exit(2); }
if (args[1] === "list") {
	if (state.listFail) { console.error("registry directory is unreadable"); process.exit(1); }
	console.log(JSON.stringify({ version: 1, hosts: state.hosts }, null, 2));
} else if (args[1] === "link") {
	const id = args[2];
	const access = args.includes("--view") ? "view" : "control";
	const link = state.links[id];
	const host = state.hosts.find(h => h.instanceId === id);
	if (!host || !link) { console.error("no such host"); process.exit(1); }
	if (link.generation !== host.generation) { console.error("host " + id + " started a new room since it was listed; list again and retry"); process.exit(1); }
	if (access === "control" && (host.access !== "control" || link.controlFails)) { console.error("control access is not published for this host"); process.exit(1); }
	console.log(JSON.stringify({ version: 1, instanceId: id, generation: link.generation, access, url: access === "control" ? link.control : link.view }));
} else { console.error("unexpected args"); process.exit(2); }
`;

interface HostState {
	hosts: Partial<RegistryHost>[];
	links: Record<string, { generation: number; control: string; view: string; controlFails?: boolean }>;
	listFail?: boolean;
}

function listedHost(over: Partial<RegistryHost> & { instanceId: string }): RegistryHost {
	return {
		generation: 1, pid: 4242, sessionId: "sess", sessionName: null, cwd: "/work/proj", model: null, startedAt: 1,
		participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control", ...over,
	};
}

async function fixture(t: TestContext, o: { control?: boolean } = { control: true }) {
	const { relay, url } = await startTestRelay();
	const dir = mkdtempSync(join(tmpdir(), "ompr-disc-"));
	const bin = join(dir, "omp");
	const stateFile = join(dir, "state.json");
	writeFileSync(bin, FAKE_OMP);
	chmodSync(bin, 0o755);
	const state: HostState = { hosts: [], links: {} };
	const save = (): void => writeFileSync(stateFile, JSON.stringify(state));
	save();
	const found: TuiBackend[] = [];
	const gone: string[] = [];
	const logs: string[] = [];
	const hosts: FakeCollabHost[] = [];
	const discovery = new TuiDiscovery({
		blobs: createBlobStore(),
		ompBin: bin,
		env: { PATH: process.env.PATH, FAKE_OMP_STATE: stateFile },
		pollMs: 3_600_000, // polls are driven by refresh() for determinism; start() runs the first one
		missesBeforeGone: 2,
		joinRetryBaseMs: 30,
		control: o.control,
		log: m => logs.push(m),
		client: { welcomeTimeoutMs: 400, snapshotProgressTimeoutMs: 400, backoffBaseMs: 20, backoffMaxMs: 60 },
	});
	t.after(async () => {
		await discovery.stop();
		for (const h of hosts) await h.close();
		await relay.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const addHost = async (instanceId: string, over: Partial<RegistryHost> = {}, hostOpts: { entries?: WireEntry[] } = {}) => {
		const host = new FakeCollabHost({ relayUrl: url, ...hostOpts });
		await host.start();
		hosts.push(host);
		const generation = over.generation ?? 1;
		state.hosts = [...state.hosts.filter(h => h.instanceId !== instanceId), listedHost({ instanceId, ...over })];
		state.links[instanceId] = { generation, control: host.link, view: host.viewLink };
		save();
		return host;
	};
	return {
		state, save, found, gone, logs, discovery,
		addHost,
		start: () => discovery.start(b => found.push(b), sid => gone.push(sid)),
	};
}

test("sidFor: generation 1 → t_<id>, later generations get a suffix", () => {
	assert.equal(sidFor("abc", 1), "t_abc");
	assert.equal(sidFor("abc", 2), "t_abcg2");
	assert.equal(sidFor("abc", 17), "t_abcg17");
});

test("finds a live TUI host, joins it exactly once and reports a usable session", async t => {
	const f = await fixture(t);
	const host = await f.addHost("inst_a", { sessionName: "My TUI" }, { entries: [userEntry("hello", 1000), assistantEntry([{ type: "text", text: "hi there" }], 2000)] });
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "onFound");
	const backend = f.found[0]!;
	assert.equal(backend.sid, "t_inst_a");
	assert.equal(backend.kind, "tui");
	assert.ok(backend.summary().caps.includes("prompt"));
	assert.equal(backend.summary().pid, 4242);
	assert.equal((await backend.snapshot()).messages.length, 2);

	// repeated polls (including concurrent ones) never join again
	await Promise.all([f.discovery.refresh(), f.discovery.refresh()]);
	await f.discovery.refresh();
	await f.discovery.refresh();
	assert.equal(host.helloCount, 1);
	assert.equal(f.found.length, 1);
	assert.equal(host.peers.get(1)?.name, "ompr-bridge");

	// the whole path works end to end: prompt through the backend reaches the host
	await backend.prompt({ sid: backend.sid, message: "ping" }, []);
	await waitUntil(() => host.framesOf("prompt").length === 1, 2000, "prompt");
});

test("registry-only hints: view-only hosts attach read-only and inputRequired/busy show in the summary", async t => {
	const f = await fixture(t);
	await f.addHost("inst_v", { access: "view" });
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "onFound");
	const backend = f.found[0]!;
	assert.deepEqual(backend.summary().caps, ["stats"]);
	assert.equal(backend.summary().status, "idle");

	f.state.hosts = [listedHost({ instanceId: "inst_v", access: "view", inputRequired: true, busy: true })];
	f.save();
	await f.discovery.refresh();
	assert.equal(backend.summary().status, "waiting");
});

test("finding 5: control is OFF by default: only the view link is used and the session is read-only", async t => {
	const f = await fixture(t, {});
	await f.addHost("inst_ro"); // the registry offers control access; the bridge must not take it
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "onFound");
	assert.deepEqual(f.found[0]!.summary().caps, ["stats"]);
	assert.ok(f.logs.every(l => !l.includes("control link unavailable")), "control was never requested");
});

test("finding 15: instance ids starting with '-' are rejected before they reach omp's argv", async t => {
	const f = await fixture(t);
	await f.addHost("-evil");
	await f.addHost("inst_ok");
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "onFound");
	assert.equal(f.found[0]!.sid, "t_inst_ok");
});

test("control link unavailable → falls back to a view link (read-only caps)", async t => {
	const f = await fixture(t);
	await f.addHost("inst_c");
	f.state.links.inst_c!.controlFails = true;
	f.save();
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "onFound");
	assert.deepEqual(f.found[0]!.summary().caps, ["stats"]);
	assert.ok(f.logs.some(l => l.includes("control link unavailable")));
	assert.ok(f.logs.every(l => !/[A-Za-z0-9_-]{40,}/.test(l)), "no secrets in logs");
});

test("generation change: old backend is torn down, a new one joins under a new sid", async t => {
	const f = await fixture(t);
	const hostG1 = await f.addHost("inst_r", { generation: 1 });
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "first join");
	const first = f.found[0]!;
	const closedReasons: string[] = [];
	first.onClosed(r => closedReasons.push(r));

	// The TUI ran /new: the room is replaced under the next generation.
	hostG1.send({ t: "bye", reason: "session changed" });
	const hostG2 = await f.addHost("inst_r", { generation: 2 });
	await f.discovery.refresh();
	await waitUntil(() => f.found.length === 2, 5000, "second join");
	const second = f.found[1]!;
	assert.equal(first.sid, "t_inst_r");
	assert.equal(second.sid, "t_inst_rg2");
	assert.deepEqual(f.gone, ["t_inst_r"]);
	assert.equal(closedReasons.length, 1);
	assert.equal(first.summary().status, "offline");
	assert.equal(hostG1.helloCount, 1);
	assert.equal(hostG2.helloCount, 1);
	assert.equal(second.summary().status, "idle");
});

test("generation change without a bye frame also replaces the backend", async t => {
	const f = await fixture(t);
	const hostG1 = await f.addHost("inst_s", { generation: 1 });
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "first join");
	await f.addHost("inst_s", { generation: 2 });
	await f.discovery.refresh();
	await waitUntil(() => f.found.length === 2, 5000, "second join");
	assert.deepEqual(f.gone, ["t_inst_s"]);
	assert.equal(f.found[0]!.summary().status, "offline");
	assert.equal(hostG1.helloCount, 1);
});

test("a host that vanishes is gone after two consecutive misses; one miss is tolerated", async t => {
	const f = await fixture(t);
	await f.addHost("inst_g");
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "join");
	const saved = [...f.state.hosts];

	f.state.hosts = [];
	f.save();
	await f.discovery.refresh(); // miss 1
	assert.deepEqual(f.gone, []);
	f.state.hosts = saved;
	f.save();
	await f.discovery.refresh(); // back: counter resets
	f.state.hosts = [];
	f.save();
	await f.discovery.refresh(); // miss 1 again
	assert.deepEqual(f.gone, []);
	await f.discovery.refresh(); // miss 2 → gone
	assert.deepEqual(f.gone, ["t_inst_g"]);
	assert.equal(f.found[0]!.summary().status, "offline");
	assert.equal(f.found.length, 1, "no rejoin happened");
});

test("a failed listing says nothing about liveness", async t => {
	const f = await fixture(t);
	const host = await f.addHost("inst_l");
	f.start();
	await waitUntil(() => f.found.length === 1, 5000, "join");
	f.state.listFail = true;
	f.save();
	for (let i = 0; i < 4; i++) await f.discovery.refresh();
	assert.deepEqual(f.gone, []);
	assert.equal(f.logs.filter(l => l.includes("listing failed")).length, 1, "the same error is logged once");
	f.state.listFail = false;
	f.save();
	await f.discovery.refresh();
	assert.equal(host.helloCount, 1);
	assert.equal(f.found[0]!.summary().status, "idle");
});

test("hosts whose relay is not connected yet are joined once they are", async t => {
	const f = await fixture(t);
	const host = await f.addHost("inst_n", { relayConnected: false });
	f.start();
	await f.discovery.refresh();
	await f.discovery.refresh();
	assert.equal(host.helloCount, 0);
	f.state.hosts = [listedHost({ instanceId: "inst_n", relayConnected: true })];
	f.save();
	await f.discovery.refresh();
	await waitUntil(() => f.found.length === 1, 5000, "join");
	assert.equal(host.helloCount, 1);
});

test("a stale link is retried later; the host's goodbye is not retried within the same generation", async t => {
	const f = await fixture(t);
	const host = await f.addHost("inst_t");
	f.state.links.inst_t!.generation = 99; // the registry rotated between list and link
	f.save();
	f.start();
	await waitUntil(() => f.logs.some(l => l.includes("joining inst_t") && l.includes("failed")), 5000, "failed join logged");
	assert.equal(f.found.length, 0);
	f.state.links.inst_t!.generation = 1;
	f.save();
	await sleep(60); // retry window (joinRetryBaseMs 30)
	await f.discovery.refresh();
	await waitUntil(() => f.found.length === 1, 5000, "join after recovery");

	host.send({ t: "bye", reason: "sharing stopped" });
	await waitUntil(() => f.found[0]!.summary().status === "offline", 2000, "closed by bye");
	for (let i = 0; i < 3; i++) await f.discovery.refresh();
	assert.equal(host.helloCount, 1, "same (instanceId, generation) is never re-joined after a clean end");
	assert.equal(f.found.length, 1);
});

test("stop() leaves every room and does not report onGone", async t => {
	const f = await fixture(t);
	await f.addHost("inst_x");
	await f.addHost("inst_y");
	f.start();
	await waitUntil(() => f.found.length === 2, 5000, "two joins");
	assert.deepEqual(f.found.map(b => b.sid).sort(), ["t_inst_x", "t_inst_y"]);
	await f.discovery.stop();
	assert.ok(f.found.every(b => b.summary().status === "offline"));
	assert.deepEqual(f.gone, []);
});

test("a missing omp binary is reported once and does not crash discovery", async t => {
	const logs: string[] = [];
	const discovery = new TuiDiscovery({ blobs: createBlobStore(), ompBin: "/nonexistent/omp", pollMs: 3_600_000, log: m => logs.push(m) });
	t.after(() => discovery.stop());
	discovery.start(() => assert.fail("nothing to find"), () => assert.fail("nothing to lose"));
	await discovery.refresh();
	await discovery.refresh();
	assert.equal(logs.filter(l => l.includes("listing failed")).length, 1);
});
