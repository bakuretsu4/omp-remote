/**
 * Two-way session, blob, and project working-tree sync between this PC and a 24/7 companion server over SSH/rsync.
 *
 * Invariants:
 * 1. Lease safety: a session currently held (`omp session lease`) on the remote peer is never overwritten by a push;
 *    a session currently held locally is never overwritten by a pull.
 * 2. Monotonic transcript winner: when neither side holds a session, the larger/newer `.jsonl` wins (`toPush` vs `toPull`)
 *    and drives both the `.jsonl` (+ companion artifact directory) and its `cwd` project directory sync.
 * 3. Project root confinement: `isSyncableProjectDir` refuses to sync a root directory itself (e.g. `/home/alyx` or `/tmp`)
 *    or any hidden dot-directory under `$HOME` (`.ssh`, `.config`, `.omp`, `.local`, `.cache`, …).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { PeerConfig } from "./config.ts";
import { isRecord } from "./guards.ts";
import { readSessionInfo } from "./recent.ts";
import { expandPath, isUnder } from "./safefs.ts";

export interface SessionFileStat {
	/** Path relative to `sessionsDir`, e.g. `-tmp/2026-11-04T00-00-00-000Z_019c....jsonl`. Always `/` separated. */
	relPath: string;
	sessionId?: string;
	size: number;
	mtimeSec: number;
	/** True when a companion `<stem>/` artifact directory exists beside the `.jsonl` file. */
	hasArtifactDir: boolean;
}

export interface SyncPlan {
	toPush: SessionFileStat[];
	toPull: SessionFileStat[];
}

export interface SyncReport {
	ok: boolean;
	pushedSessions: string[];
	pulledSessions: string[];
	pushedProjects: string[];
	pulledProjects: string[];
	durationMs: number;
	error?: string;
}

const SESSION_ID_FROM_FILE = /_([0-9a-fA-F-]{8,80})\.jsonl$/;

export function extractSessionIdFromFilename(relPath: string): string | undefined {
	return SESSION_ID_FROM_FILE.exec(relPath)?.[1];
}

/** `a` is strictly newer than `b`: longer transcript, or same length and a later mtime. Transcripts are append-only. */
function wins(a: SessionFileStat, b: SessionFileStat): boolean {
	return a.size > b.size || (a.size === b.size && a.mtimeSec > b.mtimeSec);
}

/**
 * Pure decision function (unit-tested): given local and remote `.jsonl` inventories and the sets of actively held
 * session IDs on each machine, decides which sessions push (Local → Remote) and which pull (Remote → Local).
 */
export function planSessionSync(
	local: readonly SessionFileStat[],
	remote: readonly SessionFileStat[],
	localHeld: ReadonlySet<string>,
	remoteHeld: ReadonlySet<string>,
): SyncPlan {
	const localByRel = new Map(local.map(s => [s.relPath, s]));
	const remoteByRel = new Map(remote.map(s => [s.relPath, s]));
	const allRels = new Set([...localByRel.keys(), ...remoteByRel.keys()]);
	const toPush: SessionFileStat[] = [];
	const toPull: SessionFileStat[] = [];

	for (const rel of allRels) {
		const l = localByRel.get(rel);
		const r = remoteByRel.get(rel);
		const sid = l?.sessionId ?? r?.sessionId ?? extractSessionIdFromFilename(rel);
		const heldLocal = sid ? localHeld.has(sid) : false;
		const heldRemote = sid ? remoteHeld.has(sid) : false;

		if (heldLocal && heldRemote) continue; // both sides claim it; touch neither
		// A held session is only ever written to the side that does not hold it, and only with a strictly newer copy.
		if (heldLocal) {
			if (l && (!r || wins(l, r))) toPush.push(l);
			continue;
		}
		if (heldRemote) {
			if (r && (!l || wins(r, l))) toPull.push(r);
			continue;
		}
		if (l && !r) {
			toPush.push(l);
		} else if (r && !l) {
			toPull.push(r);
		} else if (l && r) {
			if (wins(l, r)) toPush.push(l);
			else if (wins(r, l)) toPull.push(r);
		}
	}
	return { toPush, toPull };
}

/**
 * Pure guard (unit-tested): true only when `cwd` is a concrete project subdirectory beneath one of `realRoots`,
 * never a root itself (`/home/alyx`, `/tmp`) and never inside a hidden dot-directory under `homeDir` (`.ssh`, `.config`, `.omp`, …).
 */
export function isSyncableProjectDir(cwd: string, realRoots: readonly string[], homeDir: string = homedir()): boolean {
	const abs = resolve(cwd);
	const home = resolve(homeDir);
	if (abs === home || abs === "/tmp" || abs === "/var/tmp" || abs === "/") return false;
	const matchingRoot = realRoots.find(r => isUnder(abs, resolve(r)) && abs !== resolve(r));
	if (!matchingRoot) return false;
	if (isUnder(abs, home)) {
		const rel = relative(home, abs).split(sep);
		if (rel.some(part => part.startsWith("."))) return false;
	}
	const base = basename(abs);
	if (base.startsWith(".")) return false;
	return true;
}

export function scanLocalSessions(sessionsDir: string): SessionFileStat[] {
	const out: SessionFileStat[] = [];
	if (!existsSync(sessionsDir)) return out;
	let buckets: string[];
	try {
		buckets = readdirSync(sessionsDir);
	} catch {
		return out;
	}
	for (const b of buckets) {
		const bPath = join(sessionsDir, b);
		let st;
		try {
			st = statSync(bPath);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		let entries: string[];
		try {
			entries = readdirSync(bPath);
		} catch {
			continue;
		}
		const entrySet = new Set(entries);
		for (const name of entries) {
			if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
			const full = join(bPath, name);
			let fst;
			try {
				fst = statSync(full);
			} catch {
				continue;
			}
			if (!fst.isFile() || fst.size === 0) continue;
			const stem = name.slice(0, -".jsonl".length);
			const relPath = `${b}/${name}`;
			out.push({
				relPath,
				sessionId: extractSessionIdFromFilename(name),
				size: fst.size,
				mtimeSec: Math.floor(fst.mtimeMs / 1000),
				hasArtifactDir: entrySet.has(stem),
			});
		}
	}
	return out;
}

const PROJECT_EXCLUDES = [
	"--exclude=node_modules/",
	"--exclude=.gradle/",
	"--exclude=build/",
	"--exclude=target/",
	"--exclude=.wrangler/",
	"--exclude=__pycache__/",
	"--exclude=.venv/",
	"--exclude=.ompr-inbox/",
];

const SSH_ARGS = "-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new";

/** `ssh` joins its trailing argv with spaces and runs it through the remote shell, so every remote word must be quoted. */
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

function runCmd(bin: string, args: string[], timeoutMs = 600_000, input?: string): Promise<{ stdout: string; stderr: string }> {
	const { promise, resolve: res, reject: rej } = Promise.withResolvers<{ stdout: string; stderr: string }>();
	const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
		if (err) rej(new Error(`${bin} failed: ${(stderr || err.message).trim()}`));
		else res({ stdout, stderr });
	});
	child.stdin?.end(input);
	return promise;
}

export interface PeerSyncDeps {
	peer: PeerConfig;
	localOmpBin: string;
	localSessionsDir: string;
	localBlobsDir: string;
	roots: () => string[];
	/** Session files currently open in `ompr` on this machine. */
	liveSessionFiles: () => Set<string>;
	log: (m: string) => void;
}

export class PeerSync {
	readonly #d: PeerSyncDeps;
	#timer: NodeJS.Timeout | undefined;
	#debounce: NodeJS.Timeout | undefined;
	#inFlight: Promise<SyncReport> | undefined;
	#queued = false;
	#stopped = false;
	lastReport: SyncReport | null = null;

	constructor(d: PeerSyncDeps) {
		this.#d = d;
	}

	start(): void {
		if (this.#d.peer.intervalSec > 0) {
			this.#timer = setInterval(() => {
				void this.syncNow().catch(() => {});
			}, this.#d.peer.intervalSec * 1000);
			this.#timer.unref();
		}
		void this.syncNow().catch(e => this.#d.log(`peer sync (startup): ${(e as Error).message}`));
	}

	/** Coalesced trigger called when a turn finishes or a session closes. */
	notifyActivity(delayMs = 1500): void {
		if (this.#stopped) return;
		clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => {
			this.#debounce = undefined;
			void this.syncNow().catch(e => this.#d.log(`peer sync: ${(e as Error).message}`));
		}, delayMs);
		this.#debounce.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		clearTimeout(this.#debounce);
		try {
			await this.syncNow();
		} catch {
			// best-effort final push on shutdown
		}
	}

	syncNow(): Promise<SyncReport> {
		if (this.#inFlight) {
			this.#queued = true;
			return this.#inFlight;
		}
		const run = this.#runOnce().finally(() => {
			this.#inFlight = undefined;
			if (this.#queued && !this.#stopped) {
				this.#queued = false;
				void this.syncNow().catch(() => {});
			}
		});
		this.#inFlight = run;
		return run;
	}

	async #runOnce(): Promise<SyncReport> {
		const t0 = Date.now();
		try {
			const localSessionsDir = expandPath(this.#d.localSessionsDir);
			const localBlobsDir = expandPath(this.#d.localBlobsDir);
			mkdirSync(localSessionsDir, { recursive: true });
			mkdirSync(localBlobsDir, { recursive: true });

			const localStats = scanLocalSessions(localSessionsDir);
			const remoteProbe = await this.#probeRemote(localStats.map(s => s.sessionId).filter((x): x is string => Boolean(x)));
			const localHeld = await this.#probeLocalHeld(localStats);

			const plan = planSessionSync(localStats, remoteProbe.sessions, localHeld, remoteProbe.held);
			const pushedSessions: string[] = [];
			const pulledSessions: string[] = [];
			const pushedProjects: string[] = [];
			const pulledProjects: string[] = [];

			if (plan.toPush.length > 0) {
				if (existsSync(localBlobsDir)) {
					await runCmd("rsync", ["-azs", "--ignore-existing", "-e", `ssh ${SSH_ARGS}`, `${localBlobsDir}/`, `${this.#d.peer.ssh}:${remoteProbe.blobsDir}/`]);
				}
				await this.#rsyncSessionFiles(plan.toPush, localSessionsDir, `${this.#d.peer.ssh}:${remoteProbe.sessionsDir}`);
				pushedSessions.push(...plan.toPush.map(s => s.relPath));
			}

			if (plan.toPull.length > 0) {
				await runCmd("rsync", ["-azs", "--ignore-existing", "-e", `ssh ${SSH_ARGS}`, `${this.#d.peer.ssh}:${remoteProbe.blobsDir}/`, `${localBlobsDir}/`]);
				await this.#rsyncSessionFiles(plan.toPull, `${this.#d.peer.ssh}:${remoteProbe.sessionsDir}`, localSessionsDir);
				pulledSessions.push(...plan.toPull.map(s => s.relPath));
			}

			if (this.#d.peer.syncProjects) {
				const roots = this.#d.roots();
				const pushCwds = new Set<string>();
				for (const s of plan.toPush) {
					const info = await readSessionInfo(join(localSessionsDir, s.relPath));
					if (info?.cwd && isSyncableProjectDir(info.cwd, roots) && existsSync(info.cwd)) pushCwds.add(resolve(info.cwd));
				}
				const pullCwds = new Set<string>();
				for (const s of plan.toPull) {
					const info = await readSessionInfo(join(localSessionsDir, s.relPath));
					if (info?.cwd && isSyncableProjectDir(info.cwd, roots) && !pushCwds.has(resolve(info.cwd))) pullCwds.add(resolve(info.cwd));
				}

				for (const cwd of pushCwds) {
					await this.#ensureRemoteDir(cwd);
					await runCmd("rsync", ["-azs", "--update", ...PROJECT_EXCLUDES, "-e", `ssh ${SSH_ARGS}`, `${cwd}/`, `${this.#d.peer.ssh}:${cwd}/`]);
					pushedProjects.push(cwd);
				}
				for (const cwd of pullCwds) {
					mkdirSync(cwd, { recursive: true });
					await runCmd("rsync", ["-azs", "--update", ...PROJECT_EXCLUDES, "-e", `ssh ${SSH_ARGS}`, `${this.#d.peer.ssh}:${cwd}/`, `${cwd}/`]);
					pulledProjects.push(cwd);
				}
			}

			const report: SyncReport = {
				ok: true,
				pushedSessions,
				pulledSessions,
				pushedProjects,
				pulledProjects,
				durationMs: Date.now() - t0,
			};
			this.lastReport = report;
			if (pushedSessions.length || pulledSessions.length) {
				this.#d.log(`peer sync: pushed ${pushedSessions.length} session(s) / ${pushedProjects.length} project(s), pulled ${pulledSessions.length} session(s) / ${pulledProjects.length} project(s) in ${report.durationMs}ms`);
			}
			return report;
		} catch (e) {
			const report: SyncReport = {
				ok: false,
				pushedSessions: [],
				pulledSessions: [],
				pushedProjects: [],
				pulledProjects: [],
				durationMs: Date.now() - t0,
				error: (e as Error).message,
			};
			this.lastReport = report;
			throw e;
		}
	}

	async #rsyncSessionFiles(items: SessionFileStat[], srcRoot: string, dstRoot: string): Promise<void> {
		const rels: string[] = [];
		for (const item of items) {
			rels.push(item.relPath);
			if (item.hasArtifactDir) rels.push(item.relPath.slice(0, -".jsonl".length));
		}
		const listFile = join(tmpdir(), `ompr-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lst`);
		writeFileSync(listFile, `${rels.join("\n")}\n`, { mode: 0o600 });
		try {
			await runCmd("rsync", ["-azs", "--update", "-r", `--files-from=${listFile}`, "-e", `ssh ${SSH_ARGS}`, srcRoot, dstRoot]);
		} finally {
			try {
				unlinkSync(listFile);
			} catch {
				// ignore
			}
		}
	}

	async #ensureRemoteDir(dir: string): Promise<void> {
		await runCmd("ssh", [...SSH_ARGS.split(" "), this.#d.peer.ssh, "mkdir", "-p", "--", shq(dir)], 15_000);
	}

	/**
	 * Session ids a live local process holds. Fails closed: when the lease check cannot run or cannot classify an id,
	 * the sync aborts (or treats the id as held) rather than risk overwriting a transcript an open terminal is appending to.
	 */
	async #probeLocalHeld(localStats: SessionFileStat[]): Promise<Set<string>> {
		const held = new Set<string>();
		for (const f of this.#d.liveSessionFiles()) {
			const sid = extractSessionIdFromFilename(f);
			if (sid) held.add(sid);
		}
		const ids = [...new Set(localStats.map(s => s.sessionId).filter((x): x is string => Boolean(x)))];
		for (let i = 0; i < ids.length; i += 64) {
			const { stdout } = await runCmd(this.#d.localOmpBin, ["session", "lease", "--json", "--", ...ids.slice(i, i + 64)], 20_000);
			const j: unknown = JSON.parse(stdout);
			if (!isRecord(j) || !Array.isArray(j.held)) throw new Error("unexpected `omp session lease` output");
			for (const id of [...j.held, ...(Array.isArray(j.unknown) ? j.unknown : [])]) if (typeof id === "string") held.add(id);
		}
		return held;
	}

	async #probeRemote(localIds: string[]): Promise<{ sessions: SessionFileStat[]; held: Set<string>; sessionsDir: string; blobsDir: string }> {
		// The script runs as `python3 - <sessionsDir> <blobsDir> <ompBin>` with the script itself on stdin.
		const py = [
			`EXTRA = ${JSON.stringify(localIds)}`,
			"import os, sys, json, subprocess",
			"sdir = os.path.expanduser(sys.argv[1])",
			"bdir = os.path.expanduser(sys.argv[2])",
			"omp = os.path.expanduser(sys.argv[3])",
			"os.makedirs(sdir, exist_ok=True); os.makedirs(bdir, exist_ok=True)",
			"sessions = []; ids = set(EXTRA)",
			"for b in os.listdir(sdir):",
			"  bp = os.path.join(sdir, b)",
			"  if not os.path.isdir(bp): continue",
			"  try: entries = os.listdir(bp)",
			"  except Exception: continue",
			"  eset = set(entries)",
			"  for n in entries:",
			"    if not n.endswith('.jsonl') or n.startswith('.'): continue",
			"    fp = os.path.join(bp, n)",
			"    try: st = os.stat(fp)",
			"    except Exception: continue",
			"    if st.st_size == 0: continue",
			"    stem = n[:-6]",
			"    sid = stem.split('_', 1)[1] if '_' in stem else None",
			"    if sid: ids.add(sid)",
			"    sessions.append({'relPath': b + '/' + n, 'sessionId': sid, 'size': st.st_size, 'mtimeSec': int(st.st_mtime), 'hasArtifactDir': stem in eset})",
			"held = []",
			"lst = sorted(ids)",
			"if lst and not os.path.exists(omp): print(json.dumps({'error': 'omp not found at ' + omp})); sys.exit(0)",
			"for i in range(0, len(lst), 64):",
			"  r = subprocess.run([omp, 'session', 'lease', '--json', '--'] + lst[i:i+64], capture_output=True, text=True, timeout=20)",
			"  if r.returncode != 0: print(json.dumps({'error': 'omp session lease failed: ' + r.stderr.strip()[:200]})); sys.exit(0)",
			"  j = json.loads(r.stdout); held += j.get('held', []) + j.get('unknown', [])",
			"print(json.dumps({'sessions': sessions, 'held': held, 'sessionsDir': sdir, 'blobsDir': bdir}))",
		].join("\n");
		const p = this.#d.peer;
		const { stdout } = await runCmd("ssh", [...SSH_ARGS.split(" "), p.ssh, "python3", "-", shq(p.sessionsDir), shq(p.blobsDir), shq(p.ompBin)], 90_000, py);
		const parsed: unknown = JSON.parse(stdout.trim());
		if (!isRecord(parsed)) throw new Error("unexpected remote probe output");
		if (typeof parsed.error === "string") throw new Error(`peer lease check failed, nothing was synced: ${parsed.error}`);
		if (!Array.isArray(parsed.sessions) || typeof parsed.sessionsDir !== "string" || typeof parsed.blobsDir !== "string") throw new Error("unexpected remote probe output");
		return {
			sessions: parsed.sessions as SessionFileStat[],
			held: new Set(Array.isArray(parsed.held) ? parsed.held.filter((x): x is string => typeof x === "string") : []),
			sessionsDir: parsed.sessionsDir,
			blobsDir: parsed.blobsDir,
		};
	}
}
