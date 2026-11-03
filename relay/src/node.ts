import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
	MAX_FRAME_BYTES,
	RateLimiter,
	RoomRegistry,
	parseRoomRequest,
	type Peer,
} from "./room.ts";

export interface RelayOptions {
	port: number;
	host: string;
	/** Max new WebSocket connections per IP per window. Default 120 per 60 s. */
	rateLimit?: { max: number; windowMs: number };
	/** Trust the first X-Forwarded-For hop (only behind your own reverse proxy). Default false. */
	trustProxy?: boolean;
	/** Ping a connection that has been silent this long. Default 120 000. */
	idleMs?: number;
	/** Drop a pinged connection that does not pong within this time. Default 20 000. */
	pongTimeoutMs?: number;
	maxGuests?: number;
	maxFrameBytes?: number;
	/** Max simultaneously open guest sockets per client IP (default 8). Hosts are not counted. */
	maxGuestsPerIp?: number;
}

export interface RunningRelay {
	port: number;
	close(): Promise<void>;
}

function toBytes(data: RawData): Uint8Array {
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return data;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const xff = req.headers["x-forwarded-for"];
		const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
		if (first) return first;
	}
	return req.socket.remoteAddress ?? "unknown";
}

function reject(socket: Duplex, status: string): void {
	socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function startRelay(opts: RelayOptions): Promise<RunningRelay> {
	const maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
	const idleMs = opts.idleMs ?? 120_000;
	const pongTimeoutMs = opts.pongTimeoutMs ?? 20_000;
	const registry = new RoomRegistry({ maxFrameBytes, maxGuests: opts.maxGuests });
	const limiter = new RateLimiter(opts.rateLimit?.max ?? 120, opts.rateLimit?.windowMs ?? 60_000);
	const maxGuestsPerIp = opts.maxGuestsPerIp ?? 8;
	const guestsByIp = new Map<string, number>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: false });

	const http = createServer((req, res) => {
		const path = (req.url ?? "").split("?", 1)[0];
		if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
			res.writeHead(200, { "content-type": "text/plain", "content-length": 3 });
			res.end(req.method === "HEAD" ? undefined : "ok\n");
			return;
		}
		res.writeHead(path?.startsWith("/r/") ? 426 : 404, { "content-length": 0 });
		res.end();
	});

	http.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://relay");
		const parsed = parseRoomRequest(url.pathname, url.searchParams.get("role"));
		if (!parsed) return reject(socket, "404 Not Found");
		const ip = clientIp(req, opts.trustProxy ?? false);
		if (!limiter.allow(ip)) return reject(socket, "429 Too Many Requests");
		if (parsed.role === "guest" && (guestsByIp.get(ip) ?? 0) >= maxGuestsPerIp) return reject(socket, "429 Too Many Requests");
		if (parsed.role === "guest") guestsByIp.set(ip, (guestsByIp.get(ip) ?? 0) + 1);
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (parsed.role === "guest") {
				ws.once("close", () => {
					const n = (guestsByIp.get(ip) ?? 1) - 1;
					if (n <= 0) guestsByIp.delete(ip);
					else guestsByIp.set(ip, n);
				});
			}
			attach(ws, parsed.roomId, parsed.role);
		});
	});

	const timers = new Set<NodeJS.Timeout>();

	function attach(ws: WebSocket, roomId: string, role: "host" | "guest"): void {
		const peer: Peer = {
			send: (d) => {
				if (ws.readyState === ws.OPEN) ws.send(d, { binary: typeof d !== "string" });
			},
			close: (code, reason) => ws.close(code, reason),
		};
		const session = registry.join(roomId, role, peer);

		let pingTimer: NodeJS.Timeout | undefined;
		let deadTimer: NodeJS.Timeout | undefined;
		const arm = (): void => {
			clearTimeout(pingTimer);
			clearTimeout(deadTimer);
			timers.delete(pingTimer!);
			timers.delete(deadTimer!);
			pingTimer = setTimeout(() => {
				if (ws.readyState !== ws.OPEN) return;
				ws.ping();
				deadTimer = setTimeout(() => ws.terminate(), pongTimeoutMs);
				timers.add(deadTimer);
			}, idleMs);
			timers.add(pingTimer);
		};
		arm();

		ws.on("message", (data, isBinary) => {
			arm();
			if (!isBinary) return; // clients never send TEXT
			session.onMessage(toBytes(data));
		});
		ws.on("pong", arm);
		ws.on("error", () => ws.terminate());
		ws.on("close", () => {
			clearTimeout(pingTimer);
			clearTimeout(deadTimer);
			timers.delete(pingTimer!);
			timers.delete(deadTimer!);
			session.onClose();
		});
	}

	const sweeper = setInterval(() => limiter.sweep(), 60_000);
	sweeper.unref();

	return new Promise((resolve, reject_) => {
		http.once("error", reject_);
		http.listen(opts.port, opts.host, () => {
			http.off("error", reject_);
			const addr = http.address();
			const port = typeof addr === "object" && addr ? addr.port : opts.port;
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						clearInterval(sweeper);
						for (const t of timers) clearTimeout(t);
						timers.clear();
						registry.closeAll();
						for (const c of wss.clients) c.close(1001, "relay shutting down");
						const force = setTimeout(() => {
							for (const c of wss.clients) c.terminate();
							http.closeAllConnections();
						}, 1000);
						http.close(() => {
							clearTimeout(force);
							done();
						});
						http.closeIdleConnections();
					}),
			});
		});
	});
}
