/**
 * Process + JSONL client for `omp --mode rpc-ui` (omp://rpc.md): frame decoding with `rpc_chunk`
 * reassembly (protocol v2), request/response correlation, stderr tail, orderly shutdown.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { isRecord } from "../guards.ts";

export class RpcError extends Error {
	readonly code: string | undefined;
	readonly command: string;
	constructor(command: string, message: string, code?: string) {
		super(message);
		this.name = "RpcError";
		this.command = command;
		this.code = code;
	}
}

const MAX_REASSEMBLED = 64 * 1024 * 1024;

interface Partial {
	chunkId: string;
	count: number;
	byteLength: number;
	parts: Buffer[];
	bytes: number;
}

/** Validates and reassembles `rpc_chunk` sequences; ordinary frames pass through. */
export class RpcFrameDecoder {
	#partial: Partial | undefined;

	/** Returns a complete frame, or undefined when more chunks are needed. Throws on protocol violations. */
	push(line: string): Record<string, unknown> | undefined {
		const frame: unknown = JSON.parse(line);
		if (!isRecord(frame)) throw new Error("frame is not an object");
		if (frame.type !== "rpc_chunk") {
			if (this.#partial) {
				this.#partial = undefined;
				throw new Error("rpc_chunk sequence interrupted by another frame");
			}
			return frame;
		}
		const { chunkId, index, count, byteLength, data } = frame;
		if (typeof chunkId !== "string" || typeof index !== "number" || typeof count !== "number" || typeof byteLength !== "number" || typeof data !== "string") {
			throw new Error("malformed rpc_chunk");
		}
		if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || byteLength < 0 || byteLength > MAX_REASSEMBLED) {
			throw new Error("invalid rpc_chunk header");
		}
		let p = this.#partial;
		if (index === 0) {
			if (p) throw new Error("rpc_chunk sequence restarted before completion");
			p = this.#partial = { chunkId, count, byteLength, parts: [], bytes: 0 };
		}
		if (!p || p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || index !== p.parts.length) {
			this.#partial = undefined;
			throw new Error("rpc_chunk out of sequence");
		}
		const buf = Buffer.from(data, "base64");
		p.parts.push(buf);
		p.bytes += buf.byteLength;
		if (p.bytes > MAX_REASSEMBLED) {
			this.#partial = undefined;
			throw new Error("rpc_chunk exceeds the reassembly limit");
		}
		if (p.parts.length < p.count) return undefined;
		this.#partial = undefined;
		if (p.bytes !== p.byteLength) throw new Error("rpc_chunk byteLength mismatch");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(p.parts));
		const inner: unknown = JSON.parse(text);
		if (!isRecord(inner)) throw new Error("reassembled frame is not an object");
		return inner;
	}
}

export interface OmpProcessOptions {
	bin: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam. */
	spawn?: typeof nodeSpawn;
}

interface Pending {
	command: string;
	resolve: (data: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Events: `frame(frame)` for every non-response frame (after `ready`), `exit(code, signal)`.
 */
export class OmpProcess extends EventEmitter {
	readonly #o: OmpProcessOptions;
	#child: ChildProcess | undefined;
	readonly #pending = new Map<string, Pending>();
	readonly #decoder = new RpcFrameDecoder();
	#seq = 0;
	#stderr = "";
	#exited = false;
	#exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	#ready: ((f: Record<string, unknown>) => void) | undefined;

	constructor(o: OmpProcessOptions) {
		super();
		this.#o = o;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get exited(): boolean {
		return this.#exited;
	}

	/** Last few KiB of stderr, for diagnostics. */
	get stderrTail(): string {
		return this.#stderr;
	}

	/** Spawns and resolves with omp's `ready` frame. */
	start(timeoutMs = 60_000): Promise<Record<string, unknown>> {
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const spawn = this.#o.spawn ?? nodeSpawn;
		let child: ChildProcess;
		try {
			child = spawn(this.#o.bin, this.#o.args, { cwd: this.#o.cwd, env: this.#o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			reject(e as Error);
			return promise;
		}
		this.#child = child;
		const timer = setTimeout(() => {
			this.kill("SIGKILL");
			reject(new Error(`omp did not become ready within ${timeoutMs} ms${this.#stderr ? `: ${this.#stderr.trim().slice(-300)}` : ""}`));
		}, timeoutMs);
		this.#ready = f => {
			clearTimeout(timer);
			resolve(f);
		};
		child.once("error", e => {
			clearTimeout(timer);
			this.#onExit(null, null);
			reject(e);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (this.#ready) {
				this.#ready = undefined;
				reject(new Error(`omp exited before ready (code ${code}${signal ? `, ${signal}` : ""})${this.#stderr ? `: ${this.#stderr.trim().slice(-300)}` : ""}`));
			}
			this.#onExit(code, signal);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (d: string) => {
			this.#stderr = (this.#stderr + d).slice(-8192);
		});
		child.stdin?.on("error", () => {
			// EPIPE after exit; the exit handler reports it
		});
		child.stdout?.setEncoding("utf8");
		createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", line => this.#onLine(line));
		return promise;
	}

	#onLine(line: string): void {
		if (line.length === 0) return;
		let frame: Record<string, unknown> | undefined;
		try {
			frame = this.#decoder.push(line);
		} catch (e) {
			this.emit("protocol-error", e as Error);
			return;
		}
		if (!frame) return;
		if (frame.type === "ready" && this.#ready) {
			const r = this.#ready;
			this.#ready = undefined;
			r(frame);
			return;
		}
		if (frame.type === "response") {
			const id = frame.id;
			if (typeof id === "string") {
				const p = this.#pending.get(id);
				if (p) {
					this.#pending.delete(id);
					clearTimeout(p.timer);
					if (frame.success === true) p.resolve(frame.data);
					else p.reject(new RpcError(p.command, typeof frame.error === "string" ? frame.error : "command failed", typeof frame.code === "string" ? frame.code : undefined));
					return;
				}
			}
			// Responses without a known id (e.g. `parse` failures) carry no correlation; surface them.
		}
		this.emit("frame", frame);
	}

	#onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#exitInfo = { code, signal };
		for (const [id, p] of this.#pending) {
			clearTimeout(p.timer);
			p.reject(new RpcError(p.command, `omp exited (code ${code}${signal ? `, ${signal}` : ""})`, "exited"));
			this.#pending.delete(id);
		}
		this.emit("exit", code, signal);
	}

	get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
		return this.#exitInfo;
	}

	request<T = unknown>(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
		if (this.#exited || !this.#child?.stdin?.writable) return Promise.reject(new RpcError(type, "omp is not running", "exited"));
		const id = `b${++this.#seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new RpcError(type, `${type} timed out after ${timeoutMs} ms`, "timeout"));
		}, timeoutMs);
		this.#pending.set(id, { command: type, resolve: resolve as (d: unknown) => void, reject, timer });
		this.#write({ id, type, ...params });
		return promise;
	}

	/** Fire-and-forget frame (extension_ui_response, host_tool_result, ...). */
	notify(frame: Record<string, unknown>): void {
		if (this.#exited) return;
		this.#write(frame);
	}

	#write(frame: Record<string, unknown>): void {
		this.#child?.stdin?.write(`${JSON.stringify(frame)}\n`);
	}

	/** Closes stdin (omp drains and exits 0), escalating to SIGTERM/SIGKILL. */
	async shutdown(graceMs = 4000): Promise<void> {
		if (this.#exited) return;
		const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
		this.once("exit", () => resolveDone());
		try {
			this.#child?.stdin?.end();
		} catch {
			// already closed
		}
		const t1 = setTimeout(() => this.kill("SIGTERM"), graceMs);
		const t2 = setTimeout(() => this.kill("SIGKILL"), graceMs + 3000);
		await done;
		clearTimeout(t1);
		clearTimeout(t2);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			this.#child?.kill(signal);
		} catch {
			// already gone
		}
	}
}
