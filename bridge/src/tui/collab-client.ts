/**
 * Standalone omp collab guest client (proto v3). Connects to a collab relay room as `role=guest`, seals/opens
 * AES-256-GCM frames, performs `hello` → `welcome` → `snapshot-chunk…` assembly, then forwards live frames in
 * arrival order. Reconnects with backoff (a reconnect re-handshakes and delivers a fresh snapshot).
 *
 * Behavioural reference: omp `collab/guest.ts` + `collab/relay-client.ts` (join timeouts, close-code policy,
 * ping/silence heartbeat). Never logs keys, links or frame plaintext.
 */
import WebSocket from "ws";
import type { RawData } from "ws";
import type { ParsedCollabLink } from "./collab-link.ts";
import {
	COLLAB_PROTO,
	openFrame,
	packEnvelope,
	sealFrame,
	unpackEnvelope,
	type GuestFrame,
	type HostFrame,
	type WireAgent,
	type WireEntry,
	type WireHeader,
	type WireImage,
	type WireState,
} from "./collab-wire.ts";
import { OpError } from "../errors.ts";

export const DEFAULT_GUEST_NAME = "ompr-bridge";

const RELAY_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

/** The first assembled snapshot (or a resync snapshot after a reconnect). */
export interface SnapshotData {
	header: WireHeader;
	state: WireState;
	agents: WireAgent[];
	/** Entries in host order; at most `maxRetainedEntries` — older ones are counted in `dropped`. */
	entries: WireEntry[];
	dropped: number;
	readOnly: boolean;
}

export type LiveFrame = Extract<
	HostFrame,
	{ t: "entry" | "event" | "state" | "bus" | "agents" | "ui-request" | "ui-request-end" | "error" }
>;

export interface CollabClientHandlers {
	/** Fired when the welcome + snapshot are fully assembled. `resync` is true after a reconnect. */
	onSnapshot(snapshot: SnapshotData, resync: boolean): void;
	/** Live frames, strictly after the snapshot they belong to (frames that raced the snapshot are replayed after it). */
	onFrame(frame: LiveFrame): void;
	/**
	 * Transport state change. `willReconnect:false` is terminal: the client is shut down and will not call again.
	 * `willReconnect:true`: the socket dropped; a new snapshot follows once the re-handshake succeeds.
	 */
	onClose(reason: string, willReconnect: boolean): void;
	/** The host said goodbye (session switched / sharing stopped). Terminal; `onClose` is not called afterwards. */
	onBye(reason: string): void;
}

export interface CollabClientOptions {
	link: ParsedCollabLink;
	/** Display name shown to the host (≤64 chars). Default `ompr-bridge`. */
	name?: string;
	welcomeTimeoutMs?: number;
	snapshotProgressTimeoutMs?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
	/** Continuous outage after which a reconnecting client gives up (terminal). Default 10 min. */
	giveUpAfterMs?: number;
	/** Entries retained from a snapshot (newest win). Default 5000. */
	maxRetainedEntries?: number;
	/** Live frames buffered while a snapshot is still streaming in. Default 20000. */
	maxBufferedFrames?: number;
	/** Largest sealed envelope this client will send (relays reject ≥1 MiB). Default 1_000_000. */
	maxFrameBytes?: number;
	pingIntervalMs?: number;
	silenceLimitMs?: number;
	transcriptTimeoutMs?: number;
	log?: (message: string) => void;
}

interface PendingSnapshot {
	header: WireHeader;
	state: WireState;
	agents: WireAgent[];
	readOnly: boolean;
	entryCount: number;
	received: number;
	dropped: number;
	entries: WireEntry[];
	buffered: LiveFrame[];
	resync: boolean;
}

export interface TranscriptReply {
	text: string;
	newSize: number;
	error?: string;
}

const MAX_PENDING_TRANSCRIPTS = 16;
const MAX_HELLO_RETRIES = 5;

function rawToBytes(data: RawData): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return data;
}

export class CollabGuestClient {
	readonly #opts: Required<Omit<CollabClientOptions, "log" | "link">> & Pick<CollabClientOptions, "log">;
	readonly #link: ParsedCollabLink;
	readonly #handlers: CollabClientHandlers;
	readonly #writeToken: string | undefined;
	#ws: WebSocket | null = null;
	#closed = false;
	#everWelcomed = false;
	#welcomed = false;
	#readOnly: boolean;
	#pending: PendingSnapshot | null = null;
	#attempt = 0;
	#retryTimer: NodeJS.Timeout | undefined;
	#welcomeTimer: NodeJS.Timeout | undefined;
	#snapshotTimer: NodeJS.Timeout | undefined;
	#helloRetryTimer: NodeJS.Timeout | undefined;
	#helloRetries = 0;
	#heartbeat: NodeJS.Timeout | undefined;
	#lastHeard = 0;
	/** Set once the relay closed the room (4001): a later 4004 means the host is re-creating it, not "wrong room". */
	#retryMissingRoom = false;
	#outageSince = 0;
	#reqSeq = 0;
	readonly #transcripts = new Map<number, { resolve: (r: TranscriptReply | null) => void; timer: NodeJS.Timeout }>();

	constructor(opts: CollabClientOptions, handlers: CollabClientHandlers) {
		this.#link = opts.link;
		this.#handlers = handlers;
		this.#writeToken = opts.link.writeToken ? Buffer.from(opts.link.writeToken).toString("base64url") : undefined;
		this.#readOnly = this.#writeToken === undefined;
		this.#opts = {
			name: opts.name ?? DEFAULT_GUEST_NAME,
			welcomeTimeoutMs: opts.welcomeTimeoutMs ?? 30_000,
			snapshotProgressTimeoutMs: opts.snapshotProgressTimeoutMs ?? 30_000,
			backoffBaseMs: opts.backoffBaseMs ?? 1_000,
			backoffMaxMs: opts.backoffMaxMs ?? 30_000,
			giveUpAfterMs: opts.giveUpAfterMs ?? 10 * 60_000,
			maxRetainedEntries: opts.maxRetainedEntries ?? 5_000,
			maxBufferedFrames: opts.maxBufferedFrames ?? 20_000,
			maxFrameBytes: opts.maxFrameBytes ?? 1_000_000,
			pingIntervalMs: opts.pingIntervalMs ?? 15_000,
			silenceLimitMs: opts.silenceLimitMs ?? 40_000,
			transcriptTimeoutMs: opts.transcriptTimeoutMs ?? 20_000,
			log: opts.log,
		};
	}

	/** True once welcome + snapshot are in and the socket is open. */
	get live(): boolean {
		return this.#welcomed && this.#ws?.readyState === WebSocket.OPEN;
	}

	/** True when this guest cannot prompt/abort/control (view link, or the host did not accept the write token). */
	get readOnly(): boolean {
		return this.#readOnly;
	}

	get closed(): boolean {
		return this.#closed;
	}

	connect(): void {
		if (this.#closed || this.#ws || this.#retryTimer) return;
		this.#openSocket();
	}

	/** Leave the room. Idempotent; never calls the handlers. */
	close(): void {
		if (this.#closed) return;
		this.#shutdown();
	}

	// ───────────────────────────── guest → host ─────────────────────────────

	sendPrompt(text: string, images?: WireImage[]): void {
		this.#requireWritable("prompting");
		this.#send({ t: "prompt", text, images: images && images.length > 0 ? images : undefined });
	}

	sendAbort(): void {
		this.#requireWritable("interrupting");
		this.#send({ t: "abort" });
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#requireWritable("agent control");
		this.#send({ t: "agent-cmd", cmd, agentId, text });
	}

	/** Answer a host `ui-request`. `value: undefined` cancels. The host settles the first answer; later ones are no-ops. */
	sendUiResponse(reqId: number, value?: string): void {
		this.#requireWritable("answering");
		this.#send({ t: "ui-response", reqId, value });
	}

	/** Incremental subagent transcript read. Resolves `null` on transient failure (timeout, disconnect). */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptReply | null> {
		if (!this.live) return Promise.resolve(null);
		if (this.#transcripts.size >= MAX_PENDING_TRANSCRIPTS) {
			return Promise.reject(new OpError("busy", "too many transcript requests in flight"));
		}
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptReply | null>();
		const timer = setTimeout(() => {
			this.#transcripts.delete(reqId);
			resolve(null);
		}, this.#opts.transcriptTimeoutMs);
		this.#transcripts.set(reqId, { resolve, timer });
		try {
			this.#send({ t: "fetch-transcript", reqId, agentId, fromByte });
		} catch (err) {
			clearTimeout(timer);
			this.#transcripts.delete(reqId);
			resolve(null);
			this.#opts.log?.(`fetch-transcript send failed: ${String(err)}`);
		}
		return promise;
	}

	#requireWritable(action: string): void {
		if (this.#readOnly) throw new OpError("readonly", `${action} is disabled on a read-only collab link`);
	}

	#send(frame: GuestFrame): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN || (!this.#welcomed && frame.t !== "hello")) {
			throw new OpError("session_closed", "collab connection is not established");
		}
		const envelope = packEnvelope(0, sealFrame(this.#link.key, frame));
		if (envelope.byteLength > this.#opts.maxFrameBytes) {
			throw new OpError("invalid", `message too large for a collab frame (${envelope.byteLength} bytes)`);
		}
		ws.send(envelope);
	}

	// ───────────────────────────── transport ─────────────────────────────

	#openSocket(): void {
		const ws = new WebSocket(`${this.#link.wsUrl}?role=guest`, {
			perMessageDeflate: false,
			handshakeTimeout: 15_000,
			maxPayload: 16 * 1024 * 1024,
		});
		this.#ws = ws;
		ws.on("open", () => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			this.#startHeartbeat(ws);
			this.#sendHello(ws);
			this.#armWelcomeTimer();
		});
		ws.on("message", (data, isBinary) => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			if (!isBinary) return; // relay control text (`room-closed`): the close code that follows carries the policy
			this.#onBinary(rawToBytes(data));
		});
		ws.on("pong", () => {
			if (this.#ws === ws) this.#lastHeard = Date.now();
		});
		ws.on("error", () => {
			// The paired close event carries the actionable state.
		});
		ws.on("close", (code, reason) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#stopHeartbeat();
			this.#handleClose(code, reason.toString("utf8"));
		});
	}

	#sendHello(ws: WebSocket): void {
		const hello: GuestFrame = { t: "hello", proto: COLLAB_PROTO, name: this.#opts.name, writeToken: this.#writeToken };
		ws.send(packEnvelope(0, sealFrame(this.#link.key, hello)));
	}

	#startHeartbeat(ws: WebSocket): void {
		this.#stopHeartbeat();
		this.#heartbeat = setInterval(() => {
			if (this.#ws !== ws) return this.#stopHeartbeat();
			if (Date.now() - this.#lastHeard <= this.#opts.silenceLimitMs) {
				try {
					ws.ping();
				} catch {
					// a failed write surfaces as the socket's close event
				}
				return;
			}
			this.#opts.log?.("collab relay connection went silent; reconnecting");
			this.#ws = null;
			this.#stopHeartbeat();
			ws.terminate();
			this.#handleClose(1006, "relay stopped responding");
		}, this.#opts.pingIntervalMs);
		this.#heartbeat.unref();
	}

	#stopHeartbeat(): void {
		clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotTimer();
		this.#clearHelloRetry();
		this.#pending = null;
		this.#welcomed = false;
		this.#flushTranscripts();
		const fatal = RELAY_CLOSE_REASONS[code];
		const text = fatal ?? (reason || `connection lost (code ${code})`);
		const retryRoom = code === 4001 || (code === 4004 && this.#retryMissingRoom);
		if (code === 4001) this.#retryMissingRoom = true;
		const retryable = retryRoom || fatal === undefined;
		// Never joined (or never completed a join): the caller learns synchronously and decides on its own retry.
		if (!this.#everWelcomed || !retryable) {
			this.#terminate(text);
			return;
		}
		if (this.#outageSince === 0) this.#outageSince = Date.now();
		if (Date.now() - this.#outageSince > this.#opts.giveUpAfterMs) {
			this.#terminate(`${text} (gave up reconnecting after ${Math.round(this.#opts.giveUpAfterMs / 1000)}s)`);
			return;
		}
		this.#safe(() => this.#handlers.onClose(text, true));
		const base = Math.min(this.#opts.backoffBaseMs * 2 ** this.#attempt++, this.#opts.backoffMaxMs);
		this.#retryTimer = setTimeout(
			() => {
				this.#retryTimer = undefined;
				if (!this.#closed) this.#openSocket();
			},
			base * (0.75 + Math.random() * 0.5),
		);
	}

	/** Terminal shutdown reported through `onClose(reason, false)`. */
	#terminate(reason: string): void {
		if (this.#closed) return;
		this.#shutdown();
		this.#safe(() => this.#handlers.onClose(reason, false));
	}

	#shutdown(): void {
		this.#closed = true;
		this.#welcomed = false;
		this.#pending = null;
		this.#clearWelcomeTimer();
		this.#clearSnapshotTimer();
		this.#clearHelloRetry();
		this.#stopHeartbeat();
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#flushTranscripts();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing
			}
			ws.removeAllListeners("message");
			ws.on("error", () => {});
		}
	}

	#safe(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.#opts.log?.(`collab handler threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ───────────────────────────── frames ─────────────────────────────

	#onBinary(bytes: Uint8Array): void {
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		let frame: HostFrame;
		try {
			frame = openFrame(this.#link.key, envelope.payload) as HostFrame;
		} catch {
			this.#terminate("bad key or corrupted frame");
			return;
		}
		this.#attempt = 0;
		this.#outageSince = 0;
		this.#handleFrame(frame);
	}

	#handleFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				this.#beginWelcome(frame);
				return;
			case "snapshot-chunk":
				this.#accumulate(frame);
				return;
			case "bye": {
				if (this.#closed) return;
				this.#shutdown();
				this.#safe(() => this.#handlers.onBye(String(frame.reason ?? "")));
				return;
			}
			case "transcript": {
				const waiter = this.#transcripts.get(frame.reqId);
				if (!waiter) return;
				this.#transcripts.delete(frame.reqId);
				clearTimeout(waiter.timer);
				waiter.resolve({ text: String(frame.text ?? ""), newSize: Number(frame.newSize) || 0, error: frame.error });
				return;
			}
			case "error":
				if (!this.#welcomed && !this.#pending) {
					this.#preWelcomeError(String(frame.message ?? ""));
					return;
				}
				this.#live(frame);
				return;
			case "entry":
			case "event":
			case "state":
			case "bus":
			case "agents":
			case "ui-request":
			case "ui-request-end":
				this.#live(frame);
				return;
			default:
				return; // unknown frame from a newer host
		}
	}

	#live(frame: LiveFrame): void {
		const pending = this.#pending;
		if (pending) {
			// Frames that raced the snapshot are replayed after it. Streaming deltas are droppable under pressure.
			if (pending.buffered.length >= this.#opts.maxBufferedFrames) {
				if (frame.t === "event" && (frame.event.type === "message_update" || frame.event.type === "tool_execution_update")) return;
			}
			pending.buffered.push(frame);
			return;
		}
		if (!this.#welcomed) return; // before welcome there is nothing to apply the frame to
		this.#safe(() => this.#handlers.onFrame(frame));
	}

	#beginWelcome(frame: Extract<HostFrame, { t: "welcome" }>): void {
		this.#clearWelcomeTimer();
		this.#clearHelloRetry();
		this.#welcomed = false;
		this.#pending = {
			header: frame.header,
			state: frame.state,
			agents: Array.isArray(frame.agents) ? frame.agents : [],
			readOnly: frame.readOnly === true || this.#writeToken === undefined,
			entryCount: Number(frame.entryCount) || 0,
			received: 0,
			dropped: 0,
			entries: [],
			buffered: [],
			resync: this.#everWelcomed,
		};
		if (this.#pending.entryCount === 0) {
			this.#finalizeSnapshot();
			return;
		}
		this.#armSnapshotTimer();
	}

	#accumulate(frame: Extract<HostFrame, { t: "snapshot-chunk" }>): void {
		const pending = this.#pending;
		if (!pending) return; // orphan chunk (e.g. the empty final chunk after an entryCount of 0)
		const entries = Array.isArray(frame.entries) ? frame.entries : [];
		for (const entry of entries) pending.entries.push(entry);
		pending.received += entries.length;
		const max = this.#opts.maxRetainedEntries;
		if (pending.entries.length > max * 2) {
			const drop = pending.entries.length - max;
			pending.entries.splice(0, drop);
			pending.dropped += drop;
		}
		if (frame.final || pending.received >= pending.entryCount) this.#finalizeSnapshot();
		else this.#armSnapshotTimer();
	}

	#finalizeSnapshot(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = null;
		this.#clearSnapshotTimer();
		const max = this.#opts.maxRetainedEntries;
		if (pending.entries.length > max) {
			pending.dropped += pending.entries.length - max;
			pending.entries.splice(0, pending.entries.length - max);
		}
		this.#welcomed = true;
		this.#everWelcomed = true;
		this.#readOnly = pending.readOnly;
		const snapshot: SnapshotData = {
			header: pending.header,
			state: pending.state,
			agents: pending.agents,
			entries: pending.entries,
			dropped: pending.dropped,
			readOnly: pending.readOnly,
		};
		this.#safe(() => this.#handlers.onSnapshot(snapshot, pending.resync));
		for (const frame of pending.buffered) {
			if (this.#closed || !this.#welcomed) return;
			this.#safe(() => this.#handlers.onFrame(frame));
		}
	}

	/** A pre-welcome `error` is the host's targeted reply to our hello (protocol mismatch, session transition…). */
	#preWelcomeError(message: string): void {
		this.#clearWelcomeTimer();
		if (!this.#everWelcomed) {
			this.#terminate(`host refused the join: ${message}`);
			return;
		}
		// A resync during a session transition: ask again shortly instead of giving up on a live room.
		if (this.#helloRetries >= MAX_HELLO_RETRIES) {
			this.#terminate(`host refused the rejoin: ${message}`);
			return;
		}
		this.#helloRetries++;
		this.#opts.log?.(`host refused rejoin (${message}); retrying hello`);
		this.#helloRetryTimer = setTimeout(() => {
			this.#helloRetryTimer = undefined;
			const ws = this.#ws;
			if (!this.#closed && ws && ws.readyState === WebSocket.OPEN) {
				this.#sendHello(ws);
				this.#armWelcomeTimer();
			}
		}, 2_000);
	}

	// ───────────────────────────── timers ─────────────────────────────

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = undefined;
			this.#stalled("timed out waiting for the host's welcome");
		}, this.#opts.welcomeTimeoutMs);
	}

	#clearWelcomeTimer(): void {
		clearTimeout(this.#welcomeTimer);
		this.#welcomeTimer = undefined;
	}

	#armSnapshotTimer(): void {
		this.#clearSnapshotTimer();
		this.#snapshotTimer = setTimeout(() => {
			this.#snapshotTimer = undefined;
			this.#stalled("timed out waiting for the host's session snapshot");
		}, this.#opts.snapshotProgressTimeoutMs);
	}

	#clearSnapshotTimer(): void {
		clearTimeout(this.#snapshotTimer);
		this.#snapshotTimer = undefined;
	}

	#clearHelloRetry(): void {
		clearTimeout(this.#helloRetryTimer);
		this.#helloRetryTimer = undefined;
	}

	/** Join never completed: terminal on the first join, forced reconnect afterwards. */
	#stalled(reason: string): void {
		if (this.#closed) return;
		if (!this.#everWelcomed) {
			this.#terminate(reason);
			return;
		}
		const ws = this.#ws;
		if (!ws) return;
		this.#ws = null;
		this.#stopHeartbeat();
		ws.terminate();
		this.#handleClose(1006, reason);
	}

	#flushTranscripts(): void {
		for (const waiter of this.#transcripts.values()) {
			clearTimeout(waiter.timer);
			waiter.resolve(null);
		}
		this.#transcripts.clear();
	}
}
