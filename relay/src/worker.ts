/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Worker + Durable Object relay. Same contract as node.ts (PROTOCOL.md §2).
 * One RelayRoom Durable Object per roomId, using the WebSocket Hibernation API so an idle room
 * costs nothing. Per-socket state lives in the WebSocket attachment; the next guest peer id lives
 * in DO storage; everything is wiped when the host leaves (room GC).
 *
 * Liveness: Cloudflare's edge answers protocol-level pings and drops dead TCP connections itself,
 * so no app-level ping timer is run here. Per-IP connection rate limiting should be configured as a
 * Cloudflare WAF rate-limiting rule on `/r/*` (see README) — Workers have no stable per-IP memory.
 */
import { DurableObject } from "cloudflare:workers";
import {
	CLOSE,
	MAX_FRAME_BYTES,
	MAX_GUESTS,
	ROOM_CLOSED_TEXT,
	parseRoomRequest,
	peerJoinedText,
	peerLeftText,
	readEnvelopePeer,
	withEnvelopePeer,
	type Role,
} from "./room.ts";

export interface Env {
	RELAY_ROOM: DurableObjectNamespace<RelayRoom>;
}

interface Attachment {
	role: Role;
	peerId: number;
	/** Set once this socket's departure has been processed (or it was evicted by room close). */
	gone?: boolean;
}

const NEXT_PEER_KEY = "nextPeerId";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });
		const parsed = parseRoomRequest(url.pathname, url.searchParams.get("role"));
		if (!parsed) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}
		return env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(parsed.roomId)).fetch(request);
	},
} satisfies ExportedHandler<Env>;

function safeSend(ws: WebSocket, data: string | ArrayBuffer | ArrayBufferView): void {
	try {
		ws.send(data);
	} catch {
		// socket already gone; its close handler cleans up
	}
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		// already closed
	}
}

export class RelayRoom extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const parsed = parseRoomRequest(url.pathname, url.searchParams.get("role"));
		if (!parsed) return new Response("not found", { status: 404 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		const reject = (code: number, reason: string): Response => {
			server.accept();
			server.close(code, reason);
			return new Response(null, { status: 101, webSocket: client });
		};

		const host = this.#host();
		if (parsed.role === "host") {
			if (host) return reject(CLOSE.hostExists, "a host is already connected for this room");
			this.ctx.acceptWebSocket(server, ["host"]);
			server.serializeAttachment({ role: "host", peerId: 0 } satisfies Attachment);
			await this.ctx.storage.put(NEXT_PEER_KEY, 1);
			return new Response(null, { status: 101, webSocket: client });
		}

		if (!host) return reject(CLOSE.noSuchRoom, "no such room");
		if (this.ctx.getWebSockets("guest").length >= MAX_GUESTS) return reject(CLOSE.roomFull, "room is full");

		const peerId = (await this.ctx.storage.get<number>(NEXT_PEER_KEY)) ?? 1;
		await this.ctx.storage.put(NEXT_PEER_KEY, peerId + 1);
		this.ctx.acceptWebSocket(server, ["guest", `g${peerId}`]);
		server.serializeAttachment({ role: "guest", peerId } satisfies Attachment);
		safeSend(host, peerJoinedText(peerId));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === "string") return; // clients never send TEXT
		const att = ws.deserializeAttachment() as Attachment | null;
		if (!att) return;
		if (message.byteLength > MAX_FRAME_BYTES) {
			safeClose(ws, CLOSE.tooBig, "frame too large");
			await this.#left(ws, att);
			return;
		}
		const frame = new Uint8Array(message);
		if (att.role === "host") {
			const target = readEnvelopePeer(frame);
			if (target === null) return;
			if (target === 0) {
				for (const g of this.ctx.getWebSockets("guest")) safeSend(g, message);
			} else {
				for (const g of this.ctx.getWebSockets(`g${target}`)) safeSend(g, message);
			}
			return;
		}
		if (frame.byteLength < 4) return;
		const host = this.#host();
		if (host) safeSend(host, withEnvelopePeer(frame, att.peerId));
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment | null;
		// 1005/1006/1015 are reserved and must not be echoed back in a close frame.
		safeClose(ws, code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
		if (att) await this.#left(ws, att);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment | null;
		safeClose(ws, 1011, "error");
		if (att) await this.#left(ws, att);
	}

	#host(): WebSocket | undefined {
		return this.ctx.getWebSockets("host").find((w) => !(w.deserializeAttachment() as Attachment | null)?.gone);
	}

	async #left(ws: WebSocket, att: Attachment): Promise<void> {
		if (att.gone) return;
		ws.serializeAttachment({ ...att, gone: true } satisfies Attachment);
		if (att.role === "host") {
			for (const g of this.ctx.getWebSockets("guest")) {
				const ga = g.deserializeAttachment() as Attachment | null;
				if (ga) g.serializeAttachment({ ...ga, gone: true } satisfies Attachment);
				safeSend(g, ROOM_CLOSED_TEXT);
				safeClose(g, CLOSE.roomClosed, "room closed");
			}
			await this.ctx.storage.deleteAll();
			return;
		}
		const host = this.#host();
		if (host) safeSend(host, peerLeftText(att.peerId));
	}
}
