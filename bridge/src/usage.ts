/**
 * `usage.get`: account quota windows from `omp usage --json`, normalised to the wire `UsageResult`.
 * The omp output contains account emails: it is parsed here and never logged or stored.
 */
import { execFile } from "node:child_process";
import type { UsageAccount, UsageLimit, UsageResult } from "../../protocol/src/index.ts";
import { OpError, unsupported } from "./errors.ts";
import { isRecord } from "./guards.ts";

const RUN_TIMEOUT_MS = 60_000;
const CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_STR = 256;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, MAX_STR) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function usedFraction(amount: unknown): number | null {
	if (!isRecord(amount)) return null;
	let f = num(amount.usedFraction);
	if (f === undefined) {
		const used = num(amount.used);
		const limit = num(amount.limit);
		if (used !== undefined && limit !== undefined && limit > 0) f = used / limit;
	}
	return f === undefined ? null : Math.min(1, Math.max(0, f));
}

function normaliseLimit(raw: unknown, fallbackId: string): UsageLimit | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id) ?? fallbackId;
	return {
		id,
		label: text(raw.label) ?? id,
		status: text(raw.status) ?? "unknown",
		usedFraction: usedFraction(raw.amount),
		resetsAt: isRecord(raw.window) ? (num(raw.window.resetsAt) ?? null) : null,
	};
}

/** Maps the `omp usage --json` document to the wire shape. Unknown or malformed entries are skipped, never thrown on. */
export function normaliseUsage(doc: unknown, now: number): UsageResult {
	if (!isRecord(doc)) throw new OpError("internal", "omp usage returned an unexpected document");
	const accounts: UsageAccount[] = [];
	for (const rep of Array.isArray(doc.reports) ? doc.reports : []) {
		if (!isRecord(rep)) continue;
		const provider = text(rep.provider);
		if (!provider) continue;
		const meta = isRecord(rep.metadata) ? rep.metadata : {};
		const limits: UsageLimit[] = [];
		for (const [i, l] of (Array.isArray(rep.limits) ? rep.limits : []).entries()) {
			const n = normaliseLimit(l, `${provider}:${i}`);
			if (n) limits.push(n);
		}
		accounts.push(account(provider, meta, limits));
	}
	for (const acc of Array.isArray(doc.accountsWithoutUsage) ? doc.accountsWithoutUsage : []) {
		if (!isRecord(acc)) continue;
		const provider = text(acc.provider);
		if (provider) accounts.push(account(provider, acc, []));
	}
	return { generatedAt: num(doc.generatedAt) ?? now, accounts };
}

function account(provider: string, meta: Record<string, unknown>, limits: UsageLimit[]): UsageAccount {
	const a: UsageAccount = { provider, limits };
	const email = text(meta.email);
	const org = text(meta.orgName);
	if (email) a.email = email;
	if (org) a.org = org;
	return a;
}

function firstLine(s: string): string {
	return (s.split("\n").find(l => l.trim().length > 0) ?? "").trim().slice(0, 200);
}

export interface UsageOptions {
	bin: string;
	timeoutMs?: number;
	cacheMs?: number;
	now?: () => number;
}

/** Runs `omp usage --json` at most once per cache window; concurrent callers share one run. Failures are not cached. */
export class UsageService {
	readonly #o: Required<UsageOptions>;
	#cached: { at: number; value: UsageResult } | undefined;
	#inflight: Promise<UsageResult> | undefined;

	constructor(o: UsageOptions) {
		this.#o = { timeoutMs: RUN_TIMEOUT_MS, cacheMs: CACHE_MS, now: Date.now, ...o };
	}

	get(): Promise<UsageResult> {
		const c = this.#cached;
		if (c && this.#o.now() - c.at < this.#o.cacheMs) return Promise.resolve(c.value);
		this.#inflight ??= this.#fetch().then(
			value => {
				this.#cached = { at: this.#o.now(), value };
				this.#inflight = undefined;
				return value;
			},
			(e: unknown) => {
				this.#inflight = undefined;
				throw e;
			},
		);
		return this.#inflight;
	}

	#fetch(): Promise<UsageResult> {
		const { promise, resolve, reject } = Promise.withResolvers<UsageResult>();
		const child = execFile(
			this.#o.bin, ["usage", "--json"],
			{ timeout: this.#o.timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true },
			(err, stdout, stderr) => {
				if (err) return reject(runError(err, this.#o.timeoutMs, String(stderr)));
				let doc: unknown;
				try {
					doc = JSON.parse(stdout);
				} catch {
					return reject(new OpError("internal", "omp usage did not return valid JSON (is omp up to date?)"));
				}
				try {
					resolve(normaliseUsage(doc, this.#o.now()));
				} catch (e) {
					reject(e);
				}
			},
		);
		child.stdin?.end();
		return promise;
	}
}

function runError(err: Error & { code?: string | number | null; killed?: boolean }, timeoutMs: number, stderr: string): OpError {
	if (err.code === "ENOENT" || err.code === "EACCES") return unsupported("the omp binary could not be run on this PC (check omp.bin in the bridge config)");
	if (err.killed) return new OpError("timeout", `omp usage did not finish within ${Math.round(timeoutMs / 1000)} s`);
	if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new OpError("internal", "omp usage produced too much output");
	const line = firstLine(stderr);
	return new OpError("internal", `omp usage failed (exit ${String(err.code)})${line ? `: ${line}` : ""}; is omp up to date?`);
}

/** True when this omp has a working `usage` command (`omp usage --help` exits 0). Never throws. */
export function probeUsage(bin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const child = execFile(bin, ["usage", "--help"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, windowsHide: true }, err => resolve(!err));
	child.stdin?.end();
	return promise;
}
