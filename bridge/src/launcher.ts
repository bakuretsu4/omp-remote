/** Creates / opens / hands over managed sessions and answers `models.list`. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApprovalMode, CreateSessionArgs, Ops, ThinkingLevel } from "../../protocol/src/index.ts";
import type { BlobStore } from "./backend.ts";
import { APPROVAL_MODES, ompSessionsDir, type Config } from "./config.ts";
import { OpError, busy, forbidden, forbiddenPath, invalid, notFound } from "./errors.ts";
import { isRecord } from "./guards.ts";
import type { HostToolHost } from "./hosttools.ts";
import { ManagedBackend } from "./managed/backend.ts";
import { mapModelListing } from "./managed/mappers.ts";
import { OmpProcess } from "./managed/rpc.ts";
import { readSessionInfo } from "./recent.ts";
import { isUnder, realpathUnder } from "./safefs.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { UploadManager } from "./uploads.ts";

const MODEL_PART = /^[A-Za-z0-9][\w.:@+/-]{0,99}$/;
const THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
type ModelList = Ops["models.list"]["d"]["models"];

export interface LauncherDeps {
	config: Config;
	registry: SessionRegistry;
	uploads: UploadManager;
	blobs: BlobStore;
	hostTools: HostToolHost;
	roots: () => string[];
	log: (m: string) => void;
	/** Raised for non-fatal problems after a session was created (e.g. the goal could not be set). */
	notice: (level: "info" | "warning" | "error", message: string) => void;
	/** Test seam. */
	spawn?: ConstructorParameters<typeof OmpProcess>[0]["spawn"];
}

export class SessionLauncher {
	readonly #d: LauncherDeps;
	#modelCache: { at: number; models: ModelList } | undefined;
	#probe: Promise<ModelList> | undefined;

	constructor(d: LauncherDeps) {
		this.#d = d;
	}

	/** Throws `forbidden` unless the config's `allowedApprovalModes` contains `mode`. */
	assertApprovalAllowed(mode: ApprovalMode): void {
		if (!APPROVAL_MODES.includes(mode)) throw invalid("unknown approvalMode");
		if (!this.#d.config.allowedApprovalModes.includes(mode)) {
			throw forbidden(`approval mode "${mode}" is not allowed on this PC (allowed: ${this.#d.config.allowedApprovalModes.join(", ")}). Add it to allowedApprovalModes in config.json to enable it.`);
		}
	}

	async create(a: CreateSessionArgs): Promise<{ sid: string }> {
		if (!isRecord(a)) throw invalid("arguments must be an object");
		const cwd = await this.#dir(a.cwd);
		const approval = a.approvalMode ?? this.#d.config.defaultApprovalMode;
		this.assertApprovalAllowed(approval);
		if (a.thinkingLevel !== undefined && !THINKING.includes(a.thinkingLevel)) throw invalid("unknown thinkingLevel");
		let model: { provider: string; id: string } | undefined;
		if (a.model !== undefined) {
			// Neither part may start with "-": the value goes into omp's argv as `--model <provider>/<id>`.
			if (!isRecord(a.model) || typeof a.model.provider !== "string" || typeof a.model.id !== "string" || !MODEL_PART.test(a.model.provider) || !MODEL_PART.test(a.model.id)) {
				throw invalid("model must be {provider, id}");
			}
			model = { provider: a.model.provider, id: a.model.id };
		}
		if (a.prompt !== undefined && (typeof a.prompt !== "string" || a.prompt.length > 200_000)) throw invalid("prompt must be a string");
		const attachments = this.#d.uploads.resolve(a.attachments);
		if (a.goal !== undefined && (!isRecord(a.goal) || typeof a.goal.objective !== "string" || !a.goal.objective.trim())) throw invalid("goal needs an objective");

		const backend = await this.#launch({ cwd, approvalMode: approval, model, thinkingLevel: a.thinkingLevel, hostTools: a.hostTools === true });
		if (a.goal) {
			try {
				const goal = backend.ops["session.goal"];
				await goal?.({ sid: backend.sid, op: "create", objective: a.goal.objective, tokenBudget: a.goal.tokenBudget });
			} catch (e) {
				this.#d.notice("warning", `Goal could not be set: ${(e as Error).message}`);
			}
		}
		if (a.prompt) {
			try {
				await backend.prompt({ sid: backend.sid, message: a.prompt }, attachments);
			} catch (e) {
				this.#d.notice("warning", `The first prompt was not accepted: ${(e as Error).message}`);
			}
		}
		return { sid: backend.sid };
	}

	/** Opens a persisted omp session file as a managed session (or returns the live one). */
	async openFile(sessionFile: unknown): Promise<{ sid: string }> {
		if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl") || sessionFile.includes("\0")) throw invalid("sessionFile must be a .jsonl path");
		let real: string;
		try {
			real = await realpath(resolve(sessionFile));
		} catch {
			throw notFound("session file not found");
		}
		const store = await realpath(ompSessionsDir(this.#d.config)).catch(() => undefined);
		if (!store || !isUnder(real, store)) throw forbiddenPath("session files must live in omp's session directory");
		for (const s of this.#d.registry.list()) {
			if (s.kind === "managed" && s.sessionFile === real) return { sid: s.sid };
		}
		const info = await readSessionInfo(real);
		if (!info?.cwd) throw invalid("not an omp session file");
		const cwd = await this.#dir(info.cwd);
		this.assertApprovalAllowed(this.#d.config.defaultApprovalMode);
		const backend = await this.#launch({ cwd, approvalMode: this.#d.config.defaultApprovalMode, resumeFile: real, hostTools: false });
		return { sid: backend.sid };
	}

	/** `sessions.handover`: only when the TUI no longer holds the session lease. */
	async handover(tuiSid: string): Promise<{ sid: string }> {
		const tui = this.#d.registry.get(tuiSid);
		if (!tui) throw notFound("no such session");
		if (tui.kind !== "tui") throw invalid("only tui sessions can be handed over");
		const sessionId = tui.ompSessionId?.();
		if (!sessionId || !/^[\w-]{8,80}$/.test(sessionId)) throw new OpError("unsupported", "this TUI did not report its session id");
		const lease = await this.#lease(sessionId);
		if (lease.held.includes(sessionId)) throw busy("the TUI still holds the session; close or release it first");
		if (lease.unknown.includes(sessionId)) throw busy("could not determine whether the TUI still holds the session");
		const file = this.#findSessionFile(sessionId);
		if (!file) throw notFound("the session file was not found");
		return this.openFile(file);
	}

	/** `models.list`: asks a live session, else a short-lived probe process (cached 5 min). */
	async models(sid: string | undefined): Promise<ModelList> {
		if (sid) {
			const b = this.#d.registry.get(sid);
			if (!b) throw notFound("no such session");
			if (b.listModels) return b.listModels();
		}
		if (this.#modelCache && Date.now() - this.#modelCache.at < 5 * 60_000) return this.#modelCache.models;
		const live = this.#d.registry.backends().find(b => b.listModels);
		if (live?.listModels) {
			const models = await live.listModels();
			this.#modelCache = { at: Date.now(), models };
			return models;
		}
		this.#probe ??= this.#probeModels().finally(() => {
			this.#probe = undefined;
		});
		const models = await this.#probe;
		this.#modelCache = { at: Date.now(), models };
		return models;
	}

	async #probeModels(): Promise<ModelList> {
		const cwd = this.#d.roots()[0];
		if (!cwd) throw new OpError("internal", "no usable root directory");
		const proc = new OmpProcess({
			bin: this.#d.config.omp.bin,
			args: ["--mode", "rpc-ui", "--approval-mode", "always-ask", "--no-session"],
			cwd,
			spawn: this.#d.spawn,
		});
		try {
			await proc.start();
			const d = await proc.request<{ models?: unknown[] }>("get_available_models", {}, 90_000);
			return (d?.models ?? []).flatMap(m => {
				const x = mapModelListing(m);
				return x ? [x] : [];
			});
		} catch (e) {
			throw new OpError("internal", `could not list models: ${(e as Error).message}`);
		} finally {
			await proc.shutdown(1500).catch(() => {});
		}
	}

	#lease(sessionId: string): Promise<{ held: string[]; unknown: string[] }> {
		const { promise, resolve: res, reject: rej } = Promise.withResolvers<{ held: string[]; unknown: string[] }>();
		execFile(this.#d.config.omp.bin, ["session", "lease", "--json", "--", sessionId], { timeout: 15_000 }, (err, stdout) => {
			if (err) {
				rej(new OpError("internal", `omp session lease failed: ${err.message}`));
				return;
			}
			try {
				const j: unknown = JSON.parse(stdout);
				const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
				if (!isRecord(j)) throw new Error("not an object");
				res({ held: list(j.held), unknown: list(j.unknown) });
			} catch (e) {
				rej(new OpError("internal", `unexpected output from omp session lease: ${(e as Error).message}`));
			}
		});
		return promise;
	}

	#findSessionFile(sessionId: string): string | undefined {
		const root = ompSessionsDir(this.#d.config);
		const suffix = `_${sessionId}.jsonl`;
		try {
			for (const bucket of readdirSync(root, { withFileTypes: true })) {
				if (!bucket.isDirectory()) continue;
				for (const f of readdirSync(join(root, bucket.name))) {
					if (f.endsWith(suffix)) return join(root, bucket.name, f);
				}
			}
			for (const f of readdirSync(root)) if (f.endsWith(suffix)) return join(root, f);
		} catch {
			// no session directory
		}
		return undefined;
	}

	async #dir(p: unknown): Promise<string> {
		const real = await realpathUnder(p, this.#d.roots());
		const st = await stat(real);
		if (!st.isDirectory()) throw invalid("cwd is not a directory");
		return real;
	}

	async #launch(o: {
		cwd: string;
		approvalMode: ApprovalMode;
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
		resumeFile?: string;
		hostTools: boolean;
	}): Promise<ManagedBackend> {
		if (this.#d.registry.managedCount() >= this.#d.config.maxManagedSessions) throw busy("too many managed sessions are running");
		const sid = `m_${randomBytes(9).toString("base64url")}`;
		const cfg = this.#d.config;
		const backend = await ManagedBackend.launch({
			sid,
			cwd: o.cwd,
			ompBin: cfg.omp.bin,
			approvalMode: o.approvalMode,
			model: o.model,
			thinkingLevel: o.thinkingLevel,
			resumeFile: o.resumeFile,
			sessionDir: cfg.omp.sessionDir,
			extraArgs: cfg.omp.extraArgs,
			blobs: this.#d.blobs,
			log: this.#d.log,
			hostTools: o.hostTools ? this.#d.hostTools : undefined,
			spawn: this.#d.spawn,
		});
		this.#d.registry.add(backend);
		return backend;
	}
}
