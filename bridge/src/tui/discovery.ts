/**
 * TuiDiscovery — finds live omp TUI collab hosts on this machine and attaches a {@link TuiBackend} to each.
 *
 * Source of truth is omp's private host registry, reached through the CLI:
 *   `omp collab list --json`                      metadata only (no links), polled every few seconds
 *   `omp collab link <instanceId> [--view] --json`  one deliberate per-host link, bound to the listed generation
 * Each `(instanceId, generation)` is joined at most once while it stays live; a generation change (the TUI
 * switched sessions: /new, /resume, /fork) replaces the backend under a new sid; a host that is absent from
 * the listing for `missesBeforeGone` consecutive polls is gone.
 */
import { execFile } from "node:child_process";
import type { BlobStore } from "../backend.ts";
import { isRecord } from "../guards.ts";
import { parseCollabLink, type ParsedCollabLink } from "./collab-link.ts";
import { TuiBackend, type RegistryHost, type TuiBackendOptions } from "./tui-backend.ts";

export interface TuiDiscoveryOptions {
	blobs: BlobStore;
	log?: (message: string) => void;
	/** `omp` executable. Default `$OMP_BIN`, else `omp` from PATH. */
	ompBin?: string;
	/** Environment for the `omp collab` child processes (selects the omp config root whose registry is read). */
	env?: NodeJS.ProcessEnv;
	/** Gap between listings. Default 3000. */
	pollMs?: number;
	/** Deadline for one CLI invocation. Default 10000. */
	cliTimeoutMs?: number;
	/** Guest display name shown to the TUI host. Default `ompr-bridge`. */
	guestName?: string;
	/** Consecutive listings a host may be missing before it counts as gone (a busy TUI can miss the query deadline). Default 2. */
	missesBeforeGone?: number;
	/** First retry delay after a failed join; doubles up to one minute. Default 3000. */
	joinRetryBaseMs?: number;
	/** Collab client tuning (tests). */
	client?: TuiBackendOptions["client"];
	/**
	 * Ask for CONTROL links (the phone may prompt/abort/answer inside live TUI sessions). Default false: only
	 * `--view` links are used and TUI sessions are read-only.
	 */
	control?: boolean;
}

/** Must not start with `-`: the id goes into omp's argv. */
const INSTANCE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const MAX_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_JOIN_BACKOFF_MS = 60_000;

/** `t_<instanceId>` for the first room generation, `t_<instanceId>g<generation>` afterwards. */
export function sidFor(instanceId: string, generation: number): string {
	return generation === 1 ? `t_${instanceId}` : `t_${instanceId}g${generation}`;
}

function parseHost(value: unknown): RegistryHost | null {
	if (!isRecord(value)) return null;
	const { instanceId, generation, pid, sessionId, sessionName, cwd, model, startedAt, participants, relayConnected, inputRequired, busy, access } = value;
	if (typeof instanceId !== "string" || !INSTANCE_ID_RE.test(instanceId)) return null;
	if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return null;
	if (typeof pid !== "number" || typeof sessionId !== "string" || typeof cwd !== "string") return null;
	if (typeof startedAt !== "number" || typeof participants !== "number") return null;
	if (typeof relayConnected !== "boolean" || typeof inputRequired !== "boolean") return null;
	if (access !== "view" && access !== "control") return null;
	return {
		instanceId,
		generation,
		pid,
		sessionId,
		sessionName: typeof sessionName === "string" ? sessionName : null,
		cwd,
		model: isRecord(model) && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : null,
		startedAt,
		participants,
		relayConnected,
		inputRequired,
		busy: typeof busy === "boolean" ? busy : null,
		access,
	};
}

/** Thin wrapper over the `omp collab` CLI. Never logs link output. */
export class OmpCollabCli {
	readonly #bin: string;
	readonly #env: NodeJS.ProcessEnv | undefined;
	readonly #timeoutMs: number;

	constructor(opts: { bin: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) {
		this.#bin = opts.bin;
		this.#env = opts.env;
		this.#timeoutMs = opts.timeoutMs;
	}

	#run(args: string[]): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(
			this.#bin,
			args,
			{ env: this.#env, timeout: this.#timeoutMs, maxBuffer: MAX_CLI_OUTPUT_BYTES, windowsHide: true },
			(err, stdout, stderr) => {
				if (!err) return resolve(stdout);
				const detail = String(stderr).trim().split("\n", 1)[0] ?? "";
				reject(new Error(`omp ${args[1] ?? ""} failed: ${(detail || err.message).slice(0, 300)}`));
			},
		);
		return promise;
	}

	async list(): Promise<RegistryHost[]> {
		const parsed: unknown = JSON.parse(await this.#run(["collab", "list", "--json"]));
		if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.hosts)) {
			throw new Error("unsupported `omp collab list --json` output");
		}
		return parsed.hosts.flatMap(h => {
			const host = parseHost(h);
			return host ? [host] : [];
		});
	}

	/** One link for exactly `generation`; the host refuses with `stale_generation` if it rotated meanwhile. */
	async link(instanceId: string, access: "control" | "view"): Promise<{ url: string; generation: number; access: "control" | "view" }> {
		const args = ["collab", "link", instanceId, ...(access === "view" ? ["--view"] : []), "--json"];
		const parsed: unknown = JSON.parse(await this.#run(args));
		if (
			!isRecord(parsed) || parsed.version !== 1 || parsed.instanceId !== instanceId ||
			typeof parsed.generation !== "number" || typeof parsed.url !== "string" ||
			(parsed.access !== "control" && parsed.access !== "view")
		) {
			throw new Error("unsupported `omp collab link --json` output");
		}
		return { url: parsed.url, generation: parsed.generation, access: parsed.access };
	}
}

interface Tracked {
	instanceId: string;
	generation: number;
	sid: string;
	host: RegistryHost;
	backend?: TuiBackend;
	announced: boolean;
	/** The room ended cleanly (host `bye`): do not rejoin this generation. */
	endedByHost: boolean;
	joining: boolean;
	misses: number;
	attempts: number;
	nextAttemptAt: number;
	dropped: boolean;
}

export class TuiDiscovery {
	readonly #opts: TuiDiscoveryOptions;
	readonly #cli: OmpCollabCli;
	readonly #log: (message: string) => void;
	readonly #tracked = new Map<string, Tracked>();
	#onFound: ((backend: TuiBackend) => void) | undefined;
	#onGone: ((sid: string) => void) | undefined;
	#timer: NodeJS.Timeout | undefined;
	#refreshing: Promise<void> | undefined;
	#running = false;
	#lastListError = "";

	constructor(opts: TuiDiscoveryOptions) {
		this.#opts = opts;
		this.#log = opts.log ?? (() => {});
		this.#cli = new OmpCollabCli({
			bin: opts.ompBin ?? process.env.OMP_BIN ?? "omp",
			env: opts.env,
			timeoutMs: opts.cliTimeoutMs ?? 10_000,
		});
	}

	/** Begin polling. `onFound` fires once per attached backend (after its first snapshot); `onGone(sid)` when it is removed. */
	start(onFound: (backend: TuiBackend) => void, onGone: (sid: string) => void): void {
		if (this.#running) return;
		this.#running = true;
		this.#onFound = onFound;
		this.#onGone = onGone;
		this.#schedule(0);
	}

	/** Stop polling and leave every room. Does not call `onGone`. */
	async stop(): Promise<void> {
		this.#running = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#refreshing;
		const all = [...this.#tracked.values()];
		this.#tracked.clear();
		for (const t of all) t.dropped = true;
		await Promise.all(all.map(t => t.backend?.close()));
	}

	/** Re-list now (coalesced with a listing already in flight). Resolves after joins were *started*, not completed. */
	refresh(): Promise<void> {
		this.#refreshing ??= this.#refreshOnce().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	#schedule(delayMs: number): void {
		if (!this.#running) return;
		this.#timer = setTimeout(() => {
			void this.refresh().finally(() => this.#schedule(this.#opts.pollMs ?? 3000));
		}, delayMs);
		this.#timer.unref();
	}

	async #refreshOnce(): Promise<void> {
		let hosts: RegistryHost[];
		try {
			hosts = await this.#cli.list();
			this.#lastListError = "";
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message !== this.#lastListError) this.#log(`tui discovery: listing failed: ${message}`);
			this.#lastListError = message;
			return; // a failed listing says nothing about which hosts are alive
		}
		if (!this.#running) return;
		const seen = new Set<string>();
		for (const host of hosts) {
			seen.add(host.instanceId);
			const tracked = this.#tracked.get(host.instanceId);
			if (tracked && tracked.generation === host.generation) {
				tracked.misses = 0;
				tracked.host = host;
				tracked.backend?.updateHost(host);
				this.#maybeJoin(tracked);
				continue;
			}
			if (tracked) await this.#drop(tracked, "the TUI started a new session");
			if (!host.relayConnected) continue; // room not joinable yet; the next listing picks it up
			const created: Tracked = {
				instanceId: host.instanceId,
				generation: host.generation,
				sid: sidFor(host.instanceId, host.generation),
				host,
				announced: false,
				endedByHost: false,
				joining: false,
				misses: 0,
				attempts: 0,
				nextAttemptAt: 0,
				dropped: false,
			};
			this.#tracked.set(host.instanceId, created);
			this.#maybeJoin(created);
		}
		const missesBeforeGone = this.#opts.missesBeforeGone ?? 2;
		for (const tracked of [...this.#tracked.values()]) {
			if (seen.has(tracked.instanceId)) continue;
			if (++tracked.misses >= missesBeforeGone) await this.#drop(tracked, "the TUI session is gone");
		}
	}

	#maybeJoin(tracked: Tracked): void {
		if (tracked.backend || tracked.joining || tracked.endedByHost || tracked.dropped) return;
		if (!tracked.host.relayConnected || Date.now() < tracked.nextAttemptAt) return;
		tracked.joining = true;
		void this.#join(tracked).finally(() => {
			tracked.joining = false;
		});
	}

	async #join(tracked: Tracked): Promise<void> {
		const { instanceId, generation, sid } = tracked;
		let backend: TuiBackend | undefined;
		try {
			const link = await this.#acquireLink(tracked);
			if (tracked.dropped) return;
			backend = await TuiBackend.attach({
				sid,
				link,
				blobs: this.#opts.blobs,
				host: tracked.host,
				name: this.#opts.guestName,
				log: this.#log,
				client: this.#opts.client,
			});
		} catch (err) {
			tracked.attempts++;
			tracked.nextAttemptAt = this.#retryAt(tracked.attempts);
			this.#log(`tui discovery: joining ${instanceId} (generation ${generation}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (tracked.dropped) {
			await backend.close();
			return;
		}
		tracked.backend = backend;
		tracked.attempts = 0;
		backend.onClosed(reason => this.#onBackendClosed(tracked, backend, reason));
		tracked.announced = true;
		this.#log(`tui discovery: attached ${sid} (${backend.summary().cwd}${backend.summary().caps.includes("prompt") ? "" : ", read-only"})`);
		this.#onFound?.(backend);
	}

	/** Control link only when `control` is enabled AND the registry offers it (view-only fallback); otherwise the view link. */
	async #acquireLink(tracked: Tracked): Promise<ParsedCollabLink> {
		const { instanceId, generation, host } = tracked;
		const order: ("control" | "view")[] = this.#opts.control === true && host.access === "control" ? ["control", "view"] : ["view"];
		let lastError: unknown;
		for (const access of order) {
			try {
				const result = await this.#cli.link(instanceId, access);
				if (result.generation !== generation) throw new Error("stale_generation: the TUI started a new session");
				const parsed = parseCollabLink(result.url);
				if ("error" in parsed) throw new Error(parsed.error);
				if (access === "view" && order[0] === "control") this.#log(`tui discovery: ${instanceId}: control link unavailable, attaching read-only`);
				return parsed;
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	#retryAt(attempts: number): number {
		const base = this.#opts.joinRetryBaseMs ?? 3000;
		return Date.now() + Math.min(MAX_JOIN_BACKOFF_MS, base * 2 ** Math.min(attempts - 1, 5));
	}

	#onBackendClosed(tracked: Tracked, backend: TuiBackend, reason: string): void {
		if (tracked.dropped || tracked.backend !== backend) return;
		tracked.backend = undefined;
		if (backend.endedByHost) {
			tracked.endedByHost = true; // the successor room (next generation) arrives through the listing
			this.#log(`tui discovery: ${tracked.sid} ended by the host (${reason})`);
			return;
		}
		tracked.attempts++;
		tracked.nextAttemptAt = this.#retryAt(tracked.attempts);
		this.#log(`tui discovery: ${tracked.sid} detached (${reason}); will retry`);
	}

	async #drop(tracked: Tracked, reason: string): Promise<void> {
		tracked.dropped = true;
		this.#tracked.delete(tracked.instanceId);
		const backend = tracked.backend;
		tracked.backend = undefined;
		await backend?.close();
		if (tracked.announced) {
			this.#log(`tui discovery: ${tracked.sid} gone (${reason})`);
			this.#onGone?.(tracked.sid);
		}
	}
}
