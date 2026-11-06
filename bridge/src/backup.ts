/**
 * Local disk backup of omp's sessions and image blobs.
 *
 * Layout: `<dir>/YYYY-MM-DD/{sessions,blobs}`, one folder per local calendar day. Each run `rsync -a`s the sources into
 * today's folder with `--link-dest` pointing at the newest older snapshot, so files that did not change are hard links
 * (a snapshot costs only what changed) and today's folder is updated in place by later runs. Afterwards only folders
 * named exactly `YYYY-MM-DD` beyond the newest `keep` are removed.
 *
 * Guarantees: the source is only ever read (rsync gets it as a source argument, never as a destination); nothing is
 * deleted inside a snapshot (a session removed from the source today stays in today's snapshot, and is absent from
 * tomorrow's); parent folders of `dir` are never created. A transcript that is still growing can be copied up to a
 * partially written last line; omp tolerates that and the next run copies the rest.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { BackupConfig } from "./config.ts";
import { isUnder } from "./safefs.ts";

export interface BackupResult {
	ok: boolean;
	/** Epoch ms when the run finished. */
	at: number;
	durationMs: number;
	/** Today's snapshot folder name, when the run got that far. */
	snapshot?: string;
	/** Snapshot folders removed by retention. */
	pruned: string[];
	/** Human-readable failure, one line, never a stack. */
	error?: string;
}

export interface BackupDeps {
	config: BackupConfig;
	sessionsDir: string;
	blobsDir: string;
	log: (m: string) => void;
	/** Clock, injectable for tests. */
	now?: () => Date;
	/** rsync binary, injectable for tests. */
	rsyncBin?: string;
}

const SNAPSHOT_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;
const RSYNC_TIMEOUT_MS = 60 * 60_000;
/** rsync exit code "some files vanished before they could be transferred": routine while sessions are live. */
const RSYNC_VANISHED = 24;

/** Local calendar day as `YYYY-MM-DD`. */
export function snapshotName(d: Date): string {
	const p = (n: number, w = 2): string => String(n).padStart(w, "0");
	return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True only for a real calendar date in exactly `YYYY-MM-DD` form (so `2026-13-45` and `2026-11-05.bak` are not snapshots). */
export function isSnapshotName(name: string): boolean {
	const m = SNAPSHOT_NAME.exec(name);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Newest snapshot strictly older than `today`: the `--link-dest` base. */
export function previousSnapshot(names: readonly string[], today: string): string | undefined {
	return names.filter(n => isSnapshotName(n) && n < today).sort().at(-1);
}

/**
 * Snapshot folders to delete: every valid snapshot name beyond the newest `keep`. Names that are not snapshots are never
 * returned, and `protect` (the folder just written) is never returned even if clock changes made it look old.
 */
export function snapshotsToPrune(names: readonly string[], keep: number, protect?: string): string[] {
	const valid = [...new Set(names.filter(isSnapshotName))].sort().reverse();
	return valid.slice(keep).filter(n => n !== protect);
}

function oneLine(s: string, max = 300): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function runRsync(bin: string, args: string[]): Promise<void> {
	const { promise, resolve: res, reject } = Promise.withResolvers<void>();
	execFile(bin, args, { timeout: RSYNC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
		if (!err) return res();
		const code: unknown = err.code;
		if (code === RSYNC_VANISHED) return res();
		if (code === "ENOENT") return reject(new Error(`${bin} is not installed`));
		reject(new Error(`rsync failed${typeof code === "number" ? ` (exit ${code})` : ""}: ${oneLine(String(stderr) || err.message)}`));
	});
	return promise;
}

export class Backup {
	readonly #d: BackupDeps;
	#timer: NodeJS.Timeout | undefined;
	#debounce: NodeJS.Timeout | undefined;
	#inFlight: Promise<BackupResult> | undefined;
	#queued = false;
	#stopped = false;
	#lastLoggedError: string | undefined;
	lastResult: BackupResult | null = null;
	/** Set when startup validation refused the target: the backup is off for the life of this process. */
	disabledReason: string | undefined;

	constructor(d: BackupDeps) {
		this.#d = d;
	}

	/**
	 * Why `dir` cannot be a backup target right now, or undefined with the resolved real path when it can. Never creates
	 * anything. Order matters: a relative path is refused before it is stat'ed against whatever the cwd happens to be.
	 */
	async check(): Promise<{ refusal: string } | { dir: string }> {
		const { dir } = this.#d.config;
		if (!isAbsolute(dir)) return { refusal: `backup.dir must be an absolute path (got ${JSON.stringify(oneLine(dir, 120))})` };
		let real: string;
		try {
			real = await realpath(dir);
			if (!(await stat(real)).isDirectory()) return { refusal: `backup.dir is not a folder: ${dir}` };
		} catch {
			return { refusal: `backup.dir does not exist: ${dir} (create it first; the bridge does not create it)` };
		}
		try {
			await access(real, constants.W_OK | constants.X_OK);
		} catch {
			return { refusal: `backup.dir is not writable: ${dir}` };
		}
		for (const src of [this.#d.sessionsDir, this.#d.blobsDir]) {
			// A source that does not exist yet cannot contain the target through a symlink, so the lexical path is enough.
			const realSrc = await realpath(src).catch(() => resolve(src));
			if (isUnder(real, realSrc)) return { refusal: `backup.dir must not be inside omp's data (${src})` };
			// The reverse (sources inside the backup folder) would let a snapshot back itself up.
			if (isUnder(realSrc, real)) return { refusal: `omp's data (${src}) must not be inside backup.dir` };
		}
		return { dir: real };
	}

	/** Validates the target, logs a refusal once and disables, otherwise starts the schedule and an immediate run. */
	async start(): Promise<void> {
		const c = await this.check();
		if ("refusal" in c) {
			this.disabledReason = c.refusal;
			this.#d.log(`backup disabled: ${c.refusal}`);
			return;
		}
		if (this.#d.config.intervalSec > 0) {
			this.#timer = setInterval(() => {
				void this.runNow();
			}, this.#d.config.intervalSec * 1000);
			this.#timer.unref();
		}
		void this.runNow();
	}

	/** Coalesced trigger for a finished turn or a closed session. */
	notifyActivity(delayMs = 5000): void {
		if (this.#stopped || this.disabledReason) return;
		clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => {
			this.#debounce = undefined;
			void this.runNow();
		}, delayMs);
		this.#debounce.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		clearTimeout(this.#debounce);
		if (this.disabledReason) return;
		await this.#inFlight;
		// Final snapshot of what the shutdown just closed. #runOnce never rejects.
		await this.#runOnce();
	}

	/** Runs a backup now; concurrent calls share one run and at most one follow-up. Never rejects. */
	runNow(): Promise<BackupResult> {
		if (this.disabledReason) return Promise.resolve({ ok: false, at: Date.now(), durationMs: 0, pruned: [], error: this.disabledReason });
		if (this.#inFlight) {
			this.#queued = true;
			return this.#inFlight;
		}
		const run = this.#runOnce().finally(() => {
			this.#inFlight = undefined;
			if (this.#queued && !this.#stopped) {
				this.#queued = false;
				void this.runNow();
			}
		});
		this.#inFlight = run;
		return run;
	}

	#fail(t0: number, error: string, snapshot?: string): BackupResult {
		const r: BackupResult = { ok: false, at: Date.now(), durationMs: Date.now() - t0, pruned: [], error: oneLine(error) };
		if (snapshot) r.snapshot = snapshot;
		this.lastResult = r;
		if (r.error !== this.#lastLoggedError) this.#d.log(`backup failed: ${r.error}`);
		this.#lastLoggedError = r.error;
		return r;
	}

	async #runOnce(): Promise<BackupResult> {
		const t0 = Date.now();
		let snapshot: string | undefined;
		try {
			const c = await this.check();
			if ("refusal" in c) return this.#fail(t0, c.refusal);
			const root = c.dir;
			if (!(await stat(this.#d.sessionsDir).then(s => s.isDirectory(), () => false))) {
				return this.#fail(t0, `omp's sessions folder does not exist yet: ${this.#d.sessionsDir}`);
			}
			const today = snapshotName((this.#d.now ?? (() => new Date()))());
			snapshot = today;
			const before = await this.#snapshots(root);
			const prev = previousSnapshot(before, today);

			const todayDir = join(root, today);
			// Not recursive: `root` already exists (checked above), so only the final folder is ever created.
			await mkdir(todayDir).catch(async (e: NodeJS.ErrnoException) => {
				if (e.code !== "EEXIST") throw e;
				if (!(await lstat(todayDir)).isDirectory()) throw new Error(`${todayDir} exists and is not a folder`);
			});

			const rsync = this.#d.rsyncBin ?? "rsync";
			for (const [name, src] of [["sessions", this.#d.sessionsDir], ["blobs", this.#d.blobsDir]] as const) {
				if (!(await stat(src).then(s => s.isDirectory(), () => false))) continue; // blobs appear on first image
				const args = ["-a"];
				if (prev && (await stat(join(root, prev, name)).then(s => s.isDirectory(), () => false))) args.push(`--link-dest=${join(root, prev, name)}`);
				args.push("--", `${src.replace(/\/+$/, "")}/`, `${join(todayDir, name)}/`);
				await runRsync(rsync, args);
			}

			const pruned: string[] = [];
			for (const name of snapshotsToPrune(await this.#snapshots(root), this.#d.config.keep, today)) {
				await rm(join(root, name), { recursive: true, force: true });
				pruned.push(name);
			}
			const r: BackupResult = { ok: true, at: Date.now(), durationMs: Date.now() - t0, snapshot: today, pruned };
			this.lastResult = r;
			this.#lastLoggedError = undefined;
			if (pruned.length) this.#d.log(`backup: snapshot ${today} done, pruned ${pruned.join(", ")}`);
			return r;
		} catch (e) {
			return this.#fail(t0, (e as Error).message, snapshot);
		}
	}

	/** Real folders (not symlinks, not files) with snapshot names. */
	async #snapshots(root: string): Promise<string[]> {
		const out: string[] = [];
		for (const ent of await readdir(root, { withFileTypes: true })) {
			if (ent.isDirectory() && isSnapshotName(ent.name)) out.push(ent.name);
		}
		return out;
	}
}
