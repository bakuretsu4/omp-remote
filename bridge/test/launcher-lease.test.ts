import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AttentionInbox } from "../src/attention.ts";
import { parseConfig } from "../src/config.ts";
import { HostToolRouter } from "../src/hosttools.ts";
import { SessionLauncher } from "../src/launcher.ts";
import { createBlobStore } from "../src/normalize/blobs.ts";
import { resolveRoots } from "../src/safefs.ts";
import { SessionRegistry } from "../src/sessions.ts";
import { UploadManager } from "../src/uploads.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const SESSION_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

let tmp: string;
let sessionFile: string;

before(() => {
	chmodSync(FAKE, 0o755);
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-lease-")));
	mkdirSync(join(tmp, "proj"), { recursive: true });
	mkdirSync(join(tmp, "sessions", "bucket"), { recursive: true });
	sessionFile = join(tmp, "sessions", "bucket", `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: SESSION_ID, cwd: join(tmp, "proj") })}\n`);
});

after(() => {
	delete process.env.FAKE_LEASE_HELD;
	delete process.env.FAKE_LEASE_UNKNOWN;
	rmSync(tmp, { recursive: true, force: true });
});

async function rig() {
	const config = parseConfig({ roots: [tmp], omp: { bin: FAKE, sessionsDir: join(tmp, "sessions") } });
	const roots = await resolveRoots(config.roots);
	const registry = new SessionRegistry({ inbox: new AttentionInbox(), log: () => {} });
	const blobs = createBlobStore();
	const uploads = new UploadManager({ dir: join(tmp, "uploads"), blobs, roots: () => roots, sessionCwd: () => tmp });
	const hostTools = new HostToolRouter({ channels: () => [], sendHev: () => {}, log: () => {} });
	const launcher = new SessionLauncher({ config, registry, uploads, blobs, hostTools, roots: () => roots, log: () => {}, notice: () => {} });
	return { launcher, registry };
}

describe("sessions.open and a session another omp already holds", () => {
	it("refuses a session a live terminal holds, and starts no process", async () => {
		process.env.FAKE_LEASE_HELD = SESSION_ID;
		delete process.env.FAKE_LEASE_UNKNOWN;
		const { launcher, registry } = await rig();
		await assert.rejects(launcher.openFile(sessionFile), (e: { code?: string; message?: string }) => e.code === "busy" && /another omp/.test(e.message ?? ""));
		assert.equal(registry.list().length, 0, "no second writer was started on the same file");
	});

	it("refuses when it cannot tell, rather than risk a second writer", async () => {
		delete process.env.FAKE_LEASE_HELD;
		process.env.FAKE_LEASE_UNKNOWN = SESSION_ID;
		const { launcher, registry } = await rig();
		await assert.rejects(launcher.openFile(sessionFile), (e: { code?: string }) => e.code === "busy");
		assert.equal(registry.list().length, 0);
	});

	it("opens a session nobody holds", async () => {
		delete process.env.FAKE_LEASE_HELD;
		delete process.env.FAKE_LEASE_UNKNOWN;
		const { launcher, registry } = await rig();
		const { sid } = await launcher.openFile(sessionFile);
		assert.equal(registry.get(sid)?.kind, "managed");
		await registry.get(sid)?.close();
	});
});
