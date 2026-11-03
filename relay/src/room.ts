/**
 * Runtime-independent relay logic (PROTOCOL.md §2). No I/O, no Node/Workers APIs:
 * sockets are abstracted behind `Peer`. The relay is blind: it only ever looks at the
 * first 4 bytes of a binary frame (the peer-id header) and never at the payload.
 */

export const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_GUESTS = 16;

/** Close codes. 4001/4004/4009 are wire-identical to omp's local-relay; 4008 and 1009 are additions. */
export const CLOSE = {
	roomClosed: 4001,
	noSuchRoom: 4004,
	roomFull: 4008,
	hostExists: 4009,
	tooBig: 1009,
	goingAway: 1001,
} as const;

export type Role = "host" | "guest";

export interface Peer {
	send(data: Uint8Array | string): void;
	close(code: number, reason: string): void;
}

/** Handle returned by `join`; the transport forwards frames and the close event into it. */
export interface Session {
	onMessage(data: Uint8Array | string): void;
	onClose(): void;
}

const NOOP_SESSION: Session = { onMessage() {}, onClose() {} };

export function parseRoomRequest(
	pathname: string,
	role: string | null,
): { roomId: string; role: Role } | null {
	const m = ROOM_PATH_RE.exec(pathname);
	if (!m || (role !== "host" && role !== "guest")) return null;
	return { roomId: m[1]!, role };
}

/** Big-endian uint32 peer id at bytes 0..3, or null when the frame is too short. */
export function readEnvelopePeer(frame: Uint8Array): number | null {
	if (frame.byteLength < 4) return null;
	return new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
}

/** Returns a copy of `frame` with its first 4 bytes set to `peerId`. */
export function withEnvelopePeer(frame: Uint8Array, peerId: number): Uint8Array {
	const out = new Uint8Array(frame);
	new DataView(out.buffer, out.byteOffset, 4).setUint32(0, peerId, false);
	return out;
}

export const peerJoinedText = (peer: number): string => JSON.stringify({ t: "peer-joined", peer });
export const peerLeftText = (peer: number): string => JSON.stringify({ t: "peer-left", peer });
export const ROOM_CLOSED_TEXT = JSON.stringify({ t: "room-closed" });

function safeSend(peer: Peer, data: Uint8Array | string): void {
	try {
		peer.send(data);
	} catch {
		// A dead socket is cleaned up by its own close event.
	}
}

function safeClose(peer: Peer, code: number, reason: string): void {
	try {
		peer.close(code, reason);
	} catch {
		// already closed
	}
}

interface Room {
	host: Peer;
	guests: Map<number, Peer>;
	nextPeerId: number;
}

export interface RegistryLimits {
	maxFrameBytes?: number;
	maxGuests?: number;
}

export class RoomRegistry {
	readonly #rooms = new Map<string, Room>();
	readonly #maxFrame: number;
	readonly #maxGuests: number;

	constructor(limits: RegistryLimits = {}) {
		this.#maxFrame = limits.maxFrameBytes ?? MAX_FRAME_BYTES;
		this.#maxGuests = limits.maxGuests ?? MAX_GUESTS;
	}

	get roomCount(): number {
		return this.#rooms.size;
	}

	get guestCount(): number {
		let n = 0;
		for (const r of this.#rooms.values()) n += r.guests.size;
		return n;
	}

	join(roomId: string, role: Role, peer: Peer): Session {
		return role === "host" ? this.#joinHost(roomId, peer) : this.#joinGuest(roomId, peer);
	}

	/** Relay shutdown: guests get room-closed + 4001, hosts get 1001. */
	closeAll(): void {
		const rooms = [...this.#rooms.values()];
		this.#rooms.clear();
		for (const room of rooms) {
			this.#evictGuests(room);
			safeClose(room.host, CLOSE.goingAway, "relay shutting down");
		}
	}

	#evictGuests(room: Room): void {
		for (const guest of room.guests.values()) {
			safeSend(guest, ROOM_CLOSED_TEXT);
			safeClose(guest, CLOSE.roomClosed, "room closed");
		}
		room.guests.clear();
	}

	#joinHost(roomId: string, peer: Peer): Session {
		if (this.#rooms.has(roomId)) {
			safeClose(peer, CLOSE.hostExists, "a host is already connected for this room");
			return NOOP_SESSION;
		}
		const room: Room = { host: peer, guests: new Map(), nextPeerId: 1 };
		this.#rooms.set(roomId, room);
		let closed = false;
		const teardown = (): void => {
			if (closed) return;
			closed = true;
			if (this.#rooms.get(roomId) === room) this.#rooms.delete(roomId);
			this.#evictGuests(room);
		};
		return {
			onMessage: (data) => {
				if (closed || typeof data === "string") return;
				if (data.byteLength > this.#maxFrame) {
					safeClose(peer, CLOSE.tooBig, "frame too large");
					teardown();
					return;
				}
				const target = readEnvelopePeer(data);
				if (target === null) return;
				if (target === 0) {
					for (const guest of room.guests.values()) safeSend(guest, data);
				} else {
					const guest = room.guests.get(target);
					if (guest) safeSend(guest, data);
				}
			},
			onClose: teardown,
		};
	}

	#joinGuest(roomId: string, peer: Peer): Session {
		const room = this.#rooms.get(roomId);
		if (!room) {
			safeClose(peer, CLOSE.noSuchRoom, "no such room");
			return NOOP_SESSION;
		}
		if (room.guests.size >= this.#maxGuests) {
			safeClose(peer, CLOSE.roomFull, "room is full");
			return NOOP_SESSION;
		}
		const peerId = room.nextPeerId++;
		room.guests.set(peerId, peer);
		safeSend(room.host, peerJoinedText(peerId));
		let closed = false;
		const leave = (): void => {
			if (closed) return;
			closed = true;
			if (room.guests.get(peerId) === peer) {
				room.guests.delete(peerId);
				safeSend(room.host, peerLeftText(peerId));
			}
		};
		return {
			onMessage: (data) => {
				if (closed || typeof data === "string") return;
				if (data.byteLength > this.#maxFrame) {
					safeClose(peer, CLOSE.tooBig, "frame too large");
					leave();
					return;
				}
				if (data.byteLength < 4) return;
				safeSend(room.host, withEnvelopePeer(data, peerId));
			},
			onClose: leave,
		};
	}
}

/** Fixed-window per-key limiter. `now` is injectable for tests. */
export class RateLimiter {
	readonly #max: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	readonly #hits = new Map<string, { start: number; count: number }>();

	constructor(max: number, windowMs: number, now: () => number = Date.now) {
		this.#max = max;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** True if the attempt is allowed (and counted). */
	allow(key: string): boolean {
		const t = this.#now();
		let e = this.#hits.get(key);
		if (!e || t - e.start >= this.#windowMs) {
			e = { start: t, count: 0 };
			this.#hits.set(key, e);
		}
		e.count++;
		return e.count <= this.#max;
	}

	/** Drops expired windows; call periodically so the map cannot grow unbounded. */
	sweep(): void {
		const t = this.#now();
		for (const [k, e] of this.#hits) if (t - e.start >= this.#windowMs) this.#hits.delete(k);
	}
}
