/**
 * `peer.sync`: the op wrapper, `PeerSync.syncFresh`, and the daemon-level op path.
 *
 * The real sync talks to a second machine over ssh. These tests run the REAL `PeerSync` against a loopback "peer":
 * a fake `ssh` on PATH drops the ssh options and the host name and runs the remote command locally, so the real
 * remote probe script (python3), the real `omp session lease` call (fixtures/fake-omp.mjs) and the real rsync run. What
 * that proves is the sync logic and the op. What it cannot prove is ssh itself (keys, host keys, network).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { OpError } from "../src/errors.ts";
import { BridgeDaemon } from "../src/daemon.ts";
import { parseConfig, saveConfig } from "../src/config.ts";
import { createIdentity } from "../src/identity.ts";
import { runPeerSyncOp, type PeerSyncRunner } from "../src/peer-op.ts";
import { PeerSync, type PeerSyncDeps, type PeerSyncLike, type SyncReport } from "../src/sync.ts";
import { OmprClient, RpcFailure, pair } from "./e2e-client.ts";

const FAKE_OMP = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
chmodSync(FAKE_OMP, 0o755);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-peer-")));
const binDir = join(tmp, "bin");
const probeLog = join(tmp, "probe.log");
const slowOnce = join(tmp, "slow-once");

before(() => {
	mkdirSync(binDir);
	// Drops `-o X` pairs and the host, then runs the remote command through sh exactly as sshd would.
	writeFileSync(
		join(binDir, "ssh"),
		`#!/bin/sh
while [ "$1" = "-o" ]; do shift 2; done
shift
case "$*" in
python3*)
	date +%s%N >> "${probeLog}"
	if [ -e "${slowOnce}" ]; then rm -f "${slowOnce}"; sleep 1; fi
	;;
esac
exec sh -c "$*"
`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const report = (o: Partial<SyncReport> = {}): SyncReport => ({ ok: true, pushedSessions: [], pulledSessions: [], pushedProjects: [], pulledProjects: [], durationMs: 5, ...o });

describe("runPeerSyncOp", () => {
	it("answers unsupported when no peer is configured", async () => {
		await assert.rejects(() => runPeerSyncOp(undefined, () => {}), (e: unknown) => e instanceof OpError && e.code === "unsupported");
	});

	it("turns the report into counts", async () => {
		const sync: PeerSyncRunner = { syncFresh: async () => report({ pushedSessions: ["a", "b"], pulledSessions: ["c"], pushedProjects: ["/p"], durationMs: 1234 }) };
		assert.deepEqual(await runPeerSyncOp(sync, () => {}), { pushedSessions: 2, pulledSessions: 1, pushedProjects: 1, pulledProjects: 0, durationMs: 1234 });
	});

	it("maps a failure to a one-line internal error without a stack, and logs it", async () => {
		const logs: string[] = [];
		const stack = new Error("rsync failed: ssh: connect to host peer port 22: No route to host\nrsync error: unexplained error (code 255)");
		const e = await runPeerSyncOp({ syncFresh: () => Promise.reject(stack) }, m => logs.push(m)).catch((x: unknown) => x);
		assert.ok(e instanceof OpError);
		assert.equal(e.code, "internal");
		assert.match(e.message, /^sync with the peer failed: rsync failed: ssh: connect to host peer port 22: No route to host/);
		assert.doesNotMatch(e.message, /\n/);
		assert.equal(logs.length, 1);
		const long = await runPeerSyncOp({ syncFresh: () => Promise.reject(new Error("x".repeat(5000))) }, () => {}).catch((x: unknown) => x);
		assert.ok(long instanceof OpError && long.message.length < 400);
	});

	it("gives up waiting with a timeout error while the sync keeps running", async () => {
		const pending = Promise.withResolvers<SyncReport>();
		// Exercises the real timer path: the wrapper must not wait on a sync that never answers.
		const e = await runPeerSyncOp({ syncFresh: () => pending.promise }, () => {}, 20).catch((x: unknown) => x);
		assert.ok(e instanceof OpError);
		assert.equal(e.code, "timeout");
		assert.match(e.message, /continues in the background/);
		pending.resolve(report());
	});
});

interface Loop { peer: string; local: string; remote: string; deps: PeerSyncDeps }

let loopN = 0;
function loopback(): Loop {
	const base = join(tmp, `loop${loopN++}`);
	const local = join(base, "local", "sessions");
	const remote = join(base, "remote", "sessions");
	mkdirSync(local, { recursive: true });
	return {
		peer: "loopback-peer",
		local,
		remote,
		deps: {
			peer: { ssh: "loopback-peer", ompBin: FAKE_OMP, sessionsDir: remote, blobsDir: join(base, "remote", "blobs"), syncProjects: false, intervalSec: 0 },
			localOmpBin: FAKE_OMP,
			localSessionsDir: local,
			localBlobsDir: join(base, "local", "blobs"),
			roots: () => [],
			liveSessionFiles: () => new Set(),
			log: () => {},
		},
	};
}

const SESSION = "--proj--/2026-11-05T00-00-00-000Z_0a1b2c3d-aaaa-bbbb-cccc-000000000001.jsonl";

describe("PeerSync against a loopback peer", () => {
	it("pushes a new local session to the peer", async () => {
		const l = loopback();
		mkdirSync(join(l.local, "--proj--"), { recursive: true });
		writeFileSync(join(l.local, SESSION), '{"type":"session"}\n');
		const r = await new PeerSync(l.deps).syncFresh();
		assert.deepEqual(r.pushedSessions, [SESSION]);
		assert.equal(readFileSync(join(l.remote, SESSION), "utf8"), '{"type":"session"}\n');
	});

	it("syncFresh starts a new run when one is already in flight, so a session released meanwhile is not skipped", async () => {
		const l = loopback();
		const sync = new PeerSync(l.deps);
		const startedBefore = existsSync(probeLog) ? readFileSync(probeLog, "utf8").split("\n").filter(Boolean).length : 0;
		writeFileSync(slowOnce, "");
		// Run 1 scans the (still empty) local folder, then stalls inside the ssh probe.
		const first = sync.syncNow();
		while ((existsSync(probeLog) ? readFileSync(probeLog, "utf8").split("\n").filter(Boolean).length : 0) <= startedBefore) await new Promise(r => setImmediate(r));
		// The phone stopped the session now: its transcript is complete and the lease is gone.
		mkdirSync(join(l.local, "--proj--"), { recursive: true });
		writeFileSync(join(l.local, SESSION), '{"type":"session"}\n{"type":"message"}\n');
		const fresh = await sync.syncFresh();
		assert.deepEqual((await first).pushedSessions, [], "the in-flight run never saw the file");
		assert.deepEqual(fresh.pushedSessions, [SESSION], "syncNow() would have returned the stale run's empty report");
		assert.match(readFileSync(join(l.remote, SESSION), "utf8"), /message/);
	});

	it("never pushes a session that a live omp holds, and reports nothing pushed", async () => {
		const l = loopback();
		mkdirSync(join(l.local, "--proj--"), { recursive: true });
		writeFileSync(join(l.local, SESSION), '{"type":"session"}\n');
		process.env.FAKE_LEASE_HELD = "0a1b2c3d-aaaa-bbbb-cccc-000000000001";
		try {
			const r = await new PeerSync(l.deps).syncFresh();
			assert.deepEqual(r.pushedSessions, []);
			assert.equal(existsSync(join(l.remote, "--proj--")), false);
		} finally {
			delete process.env.FAKE_LEASE_HELD;
		}
	});

	it("fails (and sets lastReport) when the lease check cannot run, syncing nothing", async () => {
		const l = loopback();
		mkdirSync(join(l.local, "--proj--"), { recursive: true });
		writeFileSync(join(l.local, SESSION), '{"type":"session"}\n');
		const sync = new PeerSync({ ...l.deps, localOmpBin: "/nonexistent/omp" });
		await assert.rejects(() => sync.syncFresh());
		assert.equal(sync.lastReport?.ok, false);
		assert.deepEqual(readdirSync(l.remote), [], "the probe created the remote folder, but no session was copied");
	});
});

async function freePort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
	return promise;
}

async function startDaemon(name: string, withPeer: boolean, fake?: (d: PeerSyncDeps) => PeerSyncLike): Promise<{ daemon: BridgeDaemon; client: OmprClient; stop: () => Promise<void> }> {
	const home = join(tmp, `home-${name}`);
	const root = join(tmp, `root-${name}`);
	mkdirSync(root, { recursive: true });
	const lanPort = await freePort();
	const cfg = parseConfig({
		name, lan: true, lanAddress: "127.0.0.1", localPort: await freePort(), lanPort, roots: [root],
		omp: { bin: FAKE_OMP, sessionsDir: join(tmp, `omp-${name}`, "sessions") }, tui: { enabled: false }, inhibitSleepWhileWorking: false,
		...(withPeer ? { peer: { ssh: "loopback-peer", ompBin: FAKE_OMP, sessionsDir: join(tmp, `peer-${name}`, "sessions"), blobsDir: join(tmp, `peer-${name}`, "blobs"), syncProjects: false } } : {}),
	});
	createIdentity(home);
	saveConfig(cfg, home);
	const daemon = new BridgeDaemon({ dir: home, config: cfg, log: () => {}, ...(fake ? { createPeerSync: fake } : {}) });
	await daemon.start();
	const host = await pair(daemon.pairing.begin({ relays: daemon.relayUrlsForPairing }).link, { label: "phone" });
	const client = await OmprClient.connect(host);
	return { daemon, client, stop: async () => { client.close(); await daemon.stop(); } };
}

describe("peer.sync through a real daemon and the reference client", () => {
	it("without a peer: host.info lists no peer-sync and the op is unsupported", async () => {
		const h = await startDaemon("nopeer", false);
		try {
			const info = await h.client.req("host.info", {});
			assert.equal((info.features ?? []).includes("peer-sync"), false);
			await assert.rejects(() => h.client.req("peer.sync", {}), (e: unknown) => e instanceof RpcFailure && e.code === "unsupported");
		} finally {
			await h.stop();
		}
	});

	it("with a peer: advertises peer-sync and returns the sync summary", async () => {
		let calls = 0;
		const h = await startDaemon("peer-ok", true, () => ({
			start() {},
			async stop() {},
			notifyActivity() {},
			lastReport: null,
			async syncFresh(): Promise<SyncReport> {
				calls++;
				return report({ pushedSessions: ["x.jsonl"], pulledSessions: ["y.jsonl", "z.jsonl"], pushedProjects: ["/p"], durationMs: 321 });
			},
		}));
		try {
			const info = await h.client.req("host.info", {});
			assert.ok(info.features?.includes("peer-sync"));
			assert.deepEqual(await h.client.req("peer.sync", {}), { pushedSessions: 1, pulledSessions: 2, pushedProjects: 1, pulledProjects: 0, durationMs: 321 });
			assert.equal(calls, 1);
		} finally {
			await h.stop();
		}
	});

	it("with a peer that fails: the phone gets an internal error with a readable message and no stack", async () => {
		const h = await startDaemon("peer-fail", true, () => ({
			start() {},
			async stop() {},
			notifyActivity() {},
			lastReport: null,
			syncFresh: () => Promise.reject(new Error("rsync failed: connection refused\nrsync error: unexplained error (code 255)")),
		}));
		try {
			const e = await h.client.req("peer.sync", {}).catch((x: unknown) => x);
			assert.ok(e instanceof RpcFailure);
			assert.equal(e.code, "internal");
			assert.match(e.message, /sync with the peer failed: rsync failed: connection refused/);
			assert.doesNotMatch(e.message, /\n/, "multi-line tool output is flattened to one line");
			assert.doesNotMatch(e.message, /\.ts:\d+/, "no stack frames");
		} finally {
			await h.stop();
		}
	});

	it("with the real PeerSync on a loopback peer: pushes a session and reports it", async () => {
		const sessions = join(tmp, "omp-peer-real", "sessions");
		mkdirSync(join(sessions, "--proj--"), { recursive: true });
		writeFileSync(join(sessions, SESSION), '{"type":"session"}\n');
		const h = await startDaemon("peer-real", true);
		try {
			// The daemon's own startup sync may already have pushed it; either way the file must be on the peer afterwards.
			const r = await h.client.req("peer.sync", {}, 60_000);
			assert.ok(r.pushedSessions >= 0 && r.durationMs >= 0);
			assert.equal(readFileSync(join(tmp, "peer-peer-real", "sessions", SESSION), "utf8"), '{"type":"session"}\n');
		} finally {
			await h.stop();
		}
	});
});
