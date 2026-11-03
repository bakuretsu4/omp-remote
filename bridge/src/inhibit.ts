import type { ChildProcess, spawn as spawnFn } from "node:child_process";
import { spawn as realSpawn } from "node:child_process";

const RESPAWN_DELAY_MS = 2000;
const MAX_QUICK_FAILURES = 5;
/** A child that lived at least this long is not counted as a quick failure. */
const QUICK_MS = 10_000;

export class SleepInhibitor {
	private readonly enabled: boolean;
	private readonly log: (m: string) => void;
	private readonly spawnFn: typeof spawnFn;
	private readonly bin: string;
	private child: ChildProcess | undefined;
	private busy = false;
	private closed = false;
	private disabled = false;
	private quickFailures = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(opts: { enabled: boolean; log?: (m: string) => void; spawn?: typeof spawnFn; bin?: string }) {
		this.enabled = opts.enabled;
		this.log = opts.log ?? (() => {});
		this.spawnFn = opts.spawn ?? realSpawn;
		this.bin = opts.bin ?? "systemd-inhibit";
	}

	get active(): boolean {
		return this.child !== undefined;
	}

	setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		if (busy) {
			this.quickFailures = 0;
			this.start();
		} else {
			this.release();
		}
	}

	close(): void {
		this.closed = true;
		this.busy = false;
		this.release();
	}

	private release(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const c = this.child;
		if (c) {
			this.child = undefined;
			c.kill("SIGTERM");
		}
	}

	private start(): void {
		if (!this.enabled || this.closed || this.disabled || !this.busy || this.child || this.timer) return;
		let child: ChildProcess;
		try {
			child = this.spawnFn(
				this.bin,
				[
					"--what=sleep:idle",
					"--who=ompr",
					"--why=omp session is working",
					"--mode=block",
					"sleep",
					"infinity",
				],
				{ stdio: "ignore" },
			);
		} catch (e) {
			this.disable(e);
			return;
		}
		const startedAt = Date.now();
		this.child = child;
		child.on("error", (e: NodeJS.ErrnoException) => {
			if (this.child === child) this.child = undefined;
			this.disable(e);
		});
		child.on("exit", () => {
			if (this.child !== child) return;
			this.child = undefined;
			if (!this.busy || this.closed || this.disabled) return;
			if (Date.now() - startedAt < QUICK_MS) this.quickFailures++;
			else this.quickFailures = 0;
			if (this.quickFailures >= MAX_QUICK_FAILURES) {
				this.disabled = true;
				this.log("sleep inhibitor: child keeps exiting; giving up");
				return;
			}
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.start();
			}, RESPAWN_DELAY_MS);
			this.timer.unref();
		});
		child.unref();
	}

	private disable(e: unknown): void {
		if (this.disabled) return;
		this.disabled = true;
		const code = (e as NodeJS.ErrnoException)?.code;
		this.log(
			code === "ENOENT"
				? `sleep inhibitor disabled: ${this.bin} not found`
				: `sleep inhibitor disabled: ${code ?? (e as Error)?.message ?? "spawn failed"}`,
		);
	}
}
