/**
 * Test helpers: a fake omp collab host (speaks proto v3 through the real relay), entry builders and wait utilities.
 * The host reuses the production sealing code, so a passing test also proves the client interoperates with it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { startRelay, type RunningRelay } from "../../../relay/src/node.ts";
import { formatCollabLink, parseCollabLink, type ParsedCollabLink } from "../../src/tui/collab-link.ts";
import {
	COLLAB_PROTO, openFrame, packEnvelope, sealFrame, unpackEnvelope,
	type GuestFrame, type HostFrame, type WireAgent, type WireEntry, type WireHeader, type WireState, type WireUiRequest,
} from "../../src/tui/collab-wire.ts";

export async function startTestRelay(): Promise<{ relay: RunningRelay; url: string }> {
	const relay = await startRelay({ port: 0, host: "127.0.0.1" });
	return { relay, url: `ws://127.0.0.1:${relay.port}` };
}

export async function waitUntil(cond: () => boolean | undefined, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 10));
	}
}

export function parseLink(text: string): ParsedCollabLink {
	const parsed = parseCollabLink(text);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ───────────────────────────── entry builders ─────────────────────────────

let entrySeq = 0;
const nextId = (): string => `e${(++entrySeq).toString(16).padStart(6, "0")}`;
const iso = (ms: number): string => new Date(ms).toISOString();

export function userEntry(text: string, ts = Date.now(), id = nextId()): WireEntry {
	return { id, parentId: null, timestamp: iso(ts), type: "message", message: { role: "user", content: text, timestamp: ts } };
}

export function collabPromptEntry(text: string, from: string, ts = Date.now(), id = nextId()): WireEntry {
	return { id, parentId: null, timestamp: iso(ts), type: "custom_message", customType: "collab-prompt", content: text, details: { from }, display: true };
}

export function assistantMessage(content: unknown[], ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant", content, model: "test-model", stopReason: "stop", timestamp: ts,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.25 } },
		...extra,
	};
}

export function assistantEntry(content: unknown[], ts = Date.now(), id = nextId(), extra: Record<string, unknown> = {}): WireEntry {
	return { id, parentId: null, timestamp: iso(ts), type: "message", message: assistantMessage(content, ts, extra) };
}

export function toolResultEntry(callId: string, tool: string, text: string, ts = Date.now(), id = nextId()): WireEntry {
	return {
		id, parentId: null, timestamp: iso(ts), type: "message",
		message: { role: "toolResult", toolCallId: callId, toolName: tool, content: [{ type: "text", text }], isError: false, timestamp: ts },
	};
}

export const HEADER: WireHeader = { type: "session", id: "sess-1", title: "Test session", timestamp: iso(1_700_000_000_000), cwd: "/work/proj" };

export function makeState(over: Partial<WireState> = {}): WireState {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "Test session",
		cwd: "/work/proj",
		model: { id: "claude-test", name: "Claude Test", provider: "anthropic", contextWindow: 200_000 },
		thinkingLevel: "medium",
		contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 },
		participants: [{ name: "host", role: "host" }],
		...over,
	};
}

// ───────────────────────────── fake host ─────────────────────────────

export interface FakeHostOptions {
	relayUrl: string;
	entries?: WireEntry[];
	header?: WireHeader;
	state?: WireState;
	agents?: WireAgent[];
	/** Entries per snapshot-chunk frame (default: all in one). */
	chunkSize?: number;
	/** Never answer hello (welcome-timeout tests). */
	ignoreHello?: boolean;
	/** Answer hello with this error frame instead of a welcome. */
	helloError?: string;
	roomId?: string;
}

export class FakeCollabHost {
	readonly roomId: string;
	readonly key = randomBytes(32);
	readonly writeToken = randomBytes(16);
	readonly opts: FakeHostOptions;
	entries: WireEntry[];
	header: WireHeader;
	state: WireState;
	agents: WireAgent[];
	readonly peers = new Map<number, { name: string; canWrite: boolean }>();
	readonly received: { peer: number; frame: GuestFrame }[] = [];
	readonly pendingUi = new Map<number, WireUiRequest>();
	helloCount = 0;
	#ws: WebSocket | undefined;
	#uiSeq = 0;
	#sendChain: Promise<void> = Promise.resolve();

	constructor(opts: FakeHostOptions) {
		this.opts = opts;
		this.roomId = opts.roomId ?? randomBytes(16).toString("base64url");
		this.entries = opts.entries ?? [];
		this.header = opts.header ?? HEADER;
		this.state = opts.state ?? makeState();
		this.agents = opts.agents ?? [];
	}

	get link(): string {
		return formatCollabLink(this.opts.relayUrl, this.roomId, this.key, this.writeToken);
	}

	get viewLink(): string {
		return formatCollabLink(this.opts.relayUrl, this.roomId, this.key);
	}

	start(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const ws = new WebSocket(`${this.opts.relayUrl}/r/${this.roomId}?role=host`);
		this.#ws = ws;
		ws.on("open", () => resolve());
		ws.on("error", reject);
		ws.on("message", (data, isBinary) => {
			if (!isBinary) {
				const msg: unknown = JSON.parse(String(data));
				if (typeof msg === "object" && msg !== null && "t" in msg && msg.t === "peer-left" && "peer" in msg) this.peers.delete(Number(msg.peer));
				return;
			}
			const raw = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
			const env = unpackEnvelope(raw);
			if (!env) return;
			let frame: GuestFrame;
			try {
				frame = openFrame(this.key, env.payload) as GuestFrame;
			} catch {
				return;
			}
			this.#onGuest(frame, env.peerId);
		});
		return promise;
	}

	/** Drop the relay connection abruptly (relay tears the room down, guests get 4001). */
	dropRelay(): void {
		this.#ws?.terminate();
		this.#ws = undefined;
		this.peers.clear();
	}

	async reconnect(): Promise<void> {
		await this.start();
	}

	async close(): Promise<void> {
		await this.#sendChain;
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws && ws.readyState === WebSocket.OPEN) {
			const closed = new Promise<void>(r => ws.once("close", () => r()));
			ws.close(1000);
			await closed;
		}
	}

	send(frame: HostFrame, peer = 0): void {
		const sealed = sealFrame(this.key, frame);
		const ws = this.#ws;
		this.#sendChain = this.#sendChain.then(() => {
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(packEnvelope(peer, sealed));
		});
	}

	#onGuest(frame: GuestFrame, peer: number): void {
		this.received.push({ peer, frame });
		if (frame.t === "hello") this.#hello(frame, peer);
		if (frame.t === "ui-response") {
			const writer = this.peers.get(peer)?.canWrite === true;
			if (writer && this.pendingUi.has(frame.reqId)) this.answerUi(frame.reqId);
			else this.send({ t: "ui-request-end", reqId: frame.reqId }, peer);
		}
	}

	#hello(frame: Extract<GuestFrame, { t: "hello" }>, peer: number): void {
		this.helloCount++;
		if (this.opts.ignoreHello) return;
		if (this.opts.helloError) {
			this.send({ t: "error", message: this.opts.helloError }, peer);
			return;
		}
		if (frame.proto !== COLLAB_PROTO) {
			this.send({ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${frame.proto}` }, peer);
			return;
		}
		const token = frame.writeToken ? Buffer.from(frame.writeToken, "base64url") : undefined;
		const canWrite = token !== undefined && token.byteLength === this.writeToken.byteLength && timingSafeEqual(token, this.writeToken);
		this.peers.set(peer, { name: frame.name.trim().slice(0, 64), canWrite });
		this.send(
			{ t: "welcome", proto: COLLAB_PROTO, header: this.header, state: this.state, agents: this.agents, entryCount: this.entries.length, readOnly: canWrite ? undefined : true },
			peer,
		);
		const size = this.opts.chunkSize ?? Math.max(1, this.entries.length);
		if (this.entries.length === 0) this.send({ t: "snapshot-chunk", entries: [], final: true }, peer);
		for (let i = 0; i < this.entries.length; i += size) {
			this.send({ t: "snapshot-chunk", entries: this.entries.slice(i, i + size), final: i + size >= this.entries.length }, peer);
		}
		if (canWrite) for (const request of this.pendingUi.values()) this.send({ t: "ui-request", request }, peer);
	}

	/** Broadcast a host dialog to every writable guest (like `requestGuestUi`). Returns the reqId. */
	uiRequest(draft: DistributiveOmit<WireUiRequest, "reqId">): number {
		const reqId = ++this.#uiSeq;
		const request = { ...draft, reqId } as WireUiRequest;
		this.pendingUi.set(reqId, request);
		for (const [peer, info] of this.peers) if (info.canWrite) this.send({ t: "ui-request", request }, peer);
		return reqId;
	}

	/** Settle a dialog: the first answer wins and every writable guest gets `ui-request-end`. */
	answerUi(reqId: number): void {
		if (!this.pendingUi.delete(reqId)) return;
		for (const [peer, info] of this.peers) if (info.canWrite) this.send({ t: "ui-request-end", reqId }, peer);
	}

	appendEntry(entry: WireEntry): void {
		this.entries.push(entry);
		this.send({ t: "entry", entry });
	}

	responses(reqId?: number): Extract<GuestFrame, { t: "ui-response" }>[] {
		return this.received.flatMap(r => (r.frame.t === "ui-response" && (reqId === undefined || r.frame.reqId === reqId) ? [r.frame] : []));
	}

	framesOf<T extends GuestFrame["t"]>(t: T): Extract<GuestFrame, { t: T }>[] {
		return this.received.flatMap(r => (r.frame.t === t ? [r.frame as Extract<GuestFrame, { t: T }>] : []));
	}
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
