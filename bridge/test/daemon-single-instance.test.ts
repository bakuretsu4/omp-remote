import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { BridgeDaemon, connectControl } from "../src/daemon.ts";
import { paths, parseConfig, saveConfig } from "../src/config.ts";
import { createIdentity } from "../src/identity.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));

async function freePort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const p = (s.address() as { port: number }).port;
		s.close(() => resolve(p));
	});
	return promise;
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-single-")));
const home = join(tmp, "home");

async function make(): Promise<BridgeDaemon> {
	const cfg = parseConfig({
		name: "t", localPort: await freePort(), roots: [tmp], omp: { bin: FAKE }, tui: { enabled: false }, inhibitSleepWhileWorking: false,
	});
	return new BridgeDaemon({ dir: home, config: cfg, log: () => {} });
}

let first: BridgeDaemon;

before(async () => {
	createIdentity(home);
	saveConfig(parseConfig({ name: "t", roots: [tmp] }), home);
	first = await make();
	await first.start();
});

after(async () => {
	await first.stop();
	rmSync(tmp, { recursive: true, force: true });
});

describe("one daemon per state directory", () => {
	it("a second daemon that fails to start leaves the first one's control socket in place", async () => {
		const second = await make();
		await assert.rejects(() => second.start(), /already running/);
		await second.stop(); // `ompr run` does exactly this on a failed start
		assert.equal(existsSync(paths(home).ctl), true, "the running daemon's socket must survive");
		const s = await connectControl(home);
		assert.ok(s, "ompr status / pair must still reach the running daemon");
		s!.destroy();
	});

	it("the daemon that owns the socket still removes it when it stops", async () => {
		const solo = join(tmp, "solo");
		createIdentity(solo);
		saveConfig(parseConfig({ name: "t", roots: [tmp] }), solo);
		const cfg = parseConfig({ name: "t", localPort: await freePort(), roots: [tmp], omp: { bin: FAKE }, tui: { enabled: false }, inhibitSleepWhileWorking: false });
		const d = new BridgeDaemon({ dir: solo, config: cfg, log: () => {} });
		await d.start();
		assert.equal(existsSync(paths(solo).ctl), true);
		await d.stop();
		assert.equal(existsSync(paths(solo).ctl), false);
	});
});
