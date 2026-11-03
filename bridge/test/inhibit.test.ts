import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it, mock } from "node:test";
import type { spawn } from "node:child_process";
import { SleepInhibitor } from "../src/inhibit.ts";

class FakeChild extends EventEmitter {
	killed: string[] = [];
	unrefd = false;
	kill(sig: string): boolean {
		this.killed.push(sig);
		queueMicrotask(() => this.emit("exit", null, sig));
		return true;
	}
	unref(): void {
		this.unrefd = true;
	}
}

function harness(opts: { enabled?: boolean } = {}) {
	const children: FakeChild[] = [];
	const calls: { bin: string; args: string[]; options: unknown }[] = [];
	const logs: string[] = [];
	const fakeSpawn = ((bin: string, args: string[], options: unknown) => {
		calls.push({ bin, args, options });
		const c = new FakeChild();
		children.push(c);
		return c;
	}) as unknown as typeof spawn;
	const inh = new SleepInhibitor({ enabled: opts.enabled ?? true, spawn: fakeSpawn, log: (m) => logs.push(m) });
	return { inh, children, calls, logs };
}

describe("SleepInhibitor", () => {
	afterEach(() => mock.timers.reset());

	it("spawns on busy with exact argv and kills on idle", async () => {
		const { inh, children, calls } = harness();
		assert.equal(inh.active, false);
		inh.setBusy(true);
		assert.equal(inh.active, true);
		assert.equal(calls[0]!.bin, "systemd-inhibit");
		assert.deepEqual(calls[0]!.args, [
			"--what=sleep:idle",
			"--who=ompr",
			"--why=omp session is working",
			"--mode=block",
			"sleep",
			"infinity",
		]);
		assert.deepEqual(calls[0]!.options, { stdio: "ignore" });
		assert.equal(children[0]!.unrefd, true);
		inh.setBusy(false);
		assert.equal(inh.active, false);
		assert.deepEqual(children[0]!.killed, ["SIGTERM"]);
	});

	it("is idempotent", () => {
		const { inh, children } = harness();
		inh.setBusy(true);
		inh.setBusy(true);
		assert.equal(children.length, 1);
		inh.setBusy(false);
		inh.setBusy(false);
		assert.equal(children[0]!.killed.length, 1);
	});

	it("does nothing when disabled", () => {
		const { inh, calls } = harness({ enabled: false });
		inh.setBusy(true);
		assert.equal(inh.active, false);
		assert.equal(calls.length, 0);
	});

	it("ENOENT logs once and becomes a permanent no-op", () => {
		const { inh, children, logs } = harness();
		inh.setBusy(true);
		children[0]!.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" }));
		assert.equal(inh.active, false);
		assert.equal(logs.length, 1);
		inh.setBusy(false);
		inh.setBusy(true);
		assert.equal(children.length, 1);
		assert.equal(logs.length, 1);
	});

	it("respawns after 2s when the child dies while busy", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const { inh, children } = harness();
		inh.setBusy(true);
		children[0]!.emit("exit", 1, null);
		assert.equal(inh.active, false);
		mock.timers.tick(1999);
		assert.equal(children.length, 1);
		mock.timers.tick(1);
		assert.equal(children.length, 2);
		assert.equal(inh.active, true);
	});

	it("gives up after 5 consecutive quick failures", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const { inh, children, logs } = harness();
		inh.setBusy(true);
		for (let i = 0; i < 5; i++) {
			children[i]!.emit("exit", 1, null);
			mock.timers.tick(2000);
		}
		assert.equal(children.length, 5);
		assert.equal(inh.active, false);
		assert.equal(logs.length, 1);
	});

	it("idle during the respawn delay cancels the respawn", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const { inh, children } = harness();
		inh.setBusy(true);
		children[0]!.emit("exit", 1, null);
		inh.setBusy(false);
		mock.timers.tick(5000);
		assert.equal(children.length, 1);
	});

	it("close releases and never respawns", () => {
		const { inh, children } = harness();
		inh.setBusy(true);
		inh.close();
		assert.equal(inh.active, false);
		assert.deepEqual(children[0]!.killed, ["SIGTERM"]);
		inh.setBusy(true);
		assert.equal(children.length, 1);
		assert.equal(inh.active, false);
	});
});
