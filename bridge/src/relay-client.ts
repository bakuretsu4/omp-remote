/**
 * L0 host client (PROTOCOL.md §2): connects as `role=host` to one relay, reconnects with backoff, and
 * surfaces `peer-joined` / `peer-left` / `room-closed` plus binary frames from guests.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { packEnvelope, unpackEnvelope } from "../../protocol/src/crypto.ts";
import { isRecord } from "./guards.ts";

export interface RelayConnectionOptions {
	url: string;
	roomId: string;
	/** Short diagnostic label, e.g. `r0`. */
	label: string;
	log: (m: string) => void;
	/** Backoff bounds in ms. */
	minDelayMs?: number;
	maxDelayMs?: number;
}

const KEEPALIVE_MS = 25_000;
const PONG_TIMEOUT_MS = 20_000;
const MAX_FRAME = 1024 * 1024 + 64;

/**
 * Events: `open`, `close(reason)`, `peer-joined(peer)`, `peer-left(peer)`, `room-closed`,
 * `frame(peerId, payload)`.
 */
export class RelayConnection extends EventEmitter {
	readonly url: string;
	readonly label: string;
	readonly #o: RelayConnectionOptions;
	#ws: WebSocket | undefined;
	#stopped = false;
	#attempt = 0;
	#retry: NodeJS.Timeout | undefined;
	#keepalive: NodeJS.Timeout | undefined;
	#pongDeadline: NodeJS.Timeout | undefined;
	#openedAt = 0;
	#connected = false;

	constructor(o: RelayConnectionOptions) {
		super();
		this.#o = o;
		this.url = o.url;
		this.label = o.label;
	}

	get connected(): boolean {
		return this.#connected;
	}

	start(): void {
		this.#stopped = false;
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#retry);
		this.#clearKeepalive();
		const ws = this.#ws;
		this.#ws = undefined;
		this.#connected = false;
		ws?.removeAllListeners();
		ws?.on("error", () => {});
		try {
			ws?.close(1000);
		} catch {
			// already closed
		}
	}

	/** Sends one frame payload to guest `peerId` (0 broadcasts). Returns false when not connected. */
	send(peerId: number, payload: Uint8Array): boolean {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return false;
		ws.send(packEnvelope(peerId, payload), { binary: true });
		return true;
	}

	#endpoint(): string {
		return `${this.url.replace(/\/+$/, "")}/r/${this.#o.roomId}?role=host`;
	}

	#connect(): void {
		if (this.#stopped) return;
		const ws = new WebSocket(this.#endpoint(), { perMessageDeflate: false, maxPayload: MAX_FRAME, handshakeTimeout: 15_000 });
		this.#ws = ws;
		ws.on("open", () => {
			this.#connected = true;
			this.#openedAt = Date.now();
			this.#o.log(`[${this.label}] connected to ${this.url}`);
			this.#startKeepalive(ws);
			this.emit("open");
		});
		ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
		ws.on("pong", () => clearTimeout(this.#pongDeadline));
		ws.on("error", e => this.#o.log(`[${this.label}] socket error: ${(e as Error).message}`));
		ws.on("close", code => {
			if (this.#ws !== ws) return;
			this.#ws = undefined;
			const was = this.#connected;
			this.#connected = false;
			this.#clearKeepalive();
			if (was) this.emit("close", `closed ${code}`);
			if (code === 4009) this.#o.log(`[${this.label}] room already has a host (stale connection? retrying)`);
			// A connection that stayed up resets the backoff.
			if (was && Date.now() - this.#openedAt > 60_000) this.#attempt = 0;
			this.#scheduleRetry(code === 4009);
		});
	}

	#onMessage(data: WebSocket.RawData, isBinary: boolean): void {
		if (!isBinary) {
			let ctl: unknown;
			try {
				ctl = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (!isRecord(ctl)) return;
			if (ctl.t === "peer-joined" && typeof ctl.peer === "number") this.emit("peer-joined", ctl.peer);
			else if (ctl.t === "peer-left" && typeof ctl.peer === "number") this.emit("peer-left", ctl.peer);
			else if (ctl.t === "room-closed") this.emit("room-closed");
			return;
		}
		const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
		const env = unpackEnvelope(buf);
		if (!env || env.payload.length === 0) return;
		this.emit("frame", env.peerId, env.payload);
	}

	#scheduleRetry(longer: boolean): void {
		if (this.#stopped) return;
		const min = this.#o.minDelayMs ?? 1000;
		const max = this.#o.maxDelayMs ?? 30_000;
		const base = Math.min(max, min * 2 ** this.#attempt++);
		const delay = Math.min(max, (longer ? Math.max(base, 5000) : base) * (1 + Math.random() * 0.25));
		this.#retry = setTimeout(() => this.#connect(), delay);
	}

	#startKeepalive(ws: WebSocket): void {
		this.#clearKeepalive();
		this.#keepalive = setInterval(() => {
			if (ws.readyState !== WebSocket.OPEN) return;
			try {
				ws.ping();
			} catch {
				return;
			}
			clearTimeout(this.#pongDeadline);
			this.#pongDeadline = setTimeout(() => {
				this.#o.log(`[${this.label}] keepalive timeout; reconnecting`);
				ws.terminate();
			}, PONG_TIMEOUT_MS);
		}, KEEPALIVE_MS);
	}

	#clearKeepalive(): void {
		clearInterval(this.#keepalive);
		clearTimeout(this.#pongDeadline);
	}
}
