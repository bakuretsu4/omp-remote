import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE, RateLimiter, RoomRegistry, parseRoomRequest, type Peer } from "../src/room.ts";

class Fake implements Peer {
	sent: (Uint8Array | string)[] = [];
	closed: { code: number; reason: string } | null = null;
	send(d: Uint8Array | string): void {
		this.sent.push(d);
	}
	close(code: number, reason: string): void {
		this.closed = { code, reason };
	}
}

const frame = (peer: number, ...body: number[]): Uint8Array => {
	const b = new Uint8Array(4 + body.length);
	new DataView(b.buffer).setUint32(0, peer, false);
	b.set(body, 4);
	return b;
};
const peerOf = (d: Uint8Array | string | undefined): number => new DataView((d as Uint8Array).buffer, (d as Uint8Array).byteOffset).getUint32(0);
const ROOM = "room-abcdefghij";

function setup(limits = {}) {
	const reg = new RoomRegistry(limits);
	const h = new Fake();
	const hs = reg.join(ROOM, "host", h);
	return { reg, h, hs };
}

test("parseRoomRequest", () => {
	assert.deepEqual(parseRoomRequest("/r/" + ROOM, "host"), { roomId: ROOM, role: "host" });
	assert.equal(parseRoomRequest("/r/short", "host"), null);
	assert.equal(parseRoomRequest("/r/" + ROOM, "x"), null);
	assert.equal(parseRoomRequest("/r/" + ROOM + "/", "guest"), null);
});

test("guest -> host: peer id rewritten, peer-joined sent, original untouched", () => {
	const { reg, h } = setup();
	const g1 = new Fake(), g2 = new Fake();
	const s1 = reg.join(ROOM, "guest", g1);
	const s2 = reg.join(ROOM, "guest", g2);
	assert.deepEqual(h.sent.slice(0, 2), ['{"t":"peer-joined","peer":1}', '{"t":"peer-joined","peer":2}']);
	const spoof = frame(99, 7, 8);
	s1.onMessage(spoof);
	s2.onMessage(frame(0, 9));
	assert.equal(peerOf(h.sent[2] as Uint8Array), 1);
	assert.deepEqual([...(h.sent[2] as Uint8Array).subarray(4)], [7, 8]);
	assert.equal(peerOf(h.sent[3] as Uint8Array), 2);
	assert.equal(peerOf(spoof), 99);
});

test("host -> guests: broadcast (0) and targeted, forwarded unchanged", () => {
	const { reg, hs } = setup();
	const g1 = new Fake(), g2 = new Fake();
	reg.join(ROOM, "guest", g1);
	reg.join(ROOM, "guest", g2);
	const b = frame(0, 1);
	hs.onMessage(b);
	assert.equal(g1.sent[0], b);
	assert.equal(g2.sent[0], b);
	const t = frame(2, 5);
	hs.onMessage(t);
	assert.equal(g1.sent.length, 1);
	assert.equal(g2.sent[1], t);
	hs.onMessage(frame(42, 1)); // unknown target: dropped
	hs.onMessage(new Uint8Array(2)); // too short: dropped
	hs.onMessage("text"); // text ignored
	assert.equal(g1.sent.length, 1);
	assert.equal(g2.sent.length, 2);
});

test("second host gets 4009 and does not disturb the room", () => {
	const { reg, h } = setup();
	const h2 = new Fake();
	const s = reg.join(ROOM, "host", h2);
	assert.equal(h2.closed?.code, CLOSE.hostExists);
	s.onClose();
	assert.equal(reg.roomCount, 1);
	assert.equal(h.closed, null);
});

test("guest to missing room gets 4004", () => {
	const reg = new RoomRegistry();
	const g = new Fake();
	reg.join(ROOM, "guest", g);
	assert.equal(g.closed?.code, CLOSE.noSuchRoom);
});

test("host leaves: room-closed text + 4001 to guests, room GC'd, id reusable", () => {
	const { reg, hs } = setup();
	const g = new Fake();
	const gs = reg.join(ROOM, "guest", g);
	hs.onClose();
	assert.equal(g.sent.at(-1), '{"t":"room-closed"}');
	assert.equal(g.closed?.code, CLOSE.roomClosed);
	assert.equal(reg.roomCount, 0);
	gs.onClose(); // late close event must not throw or notify
	const h2 = new Fake();
	reg.join(ROOM, "host", h2);
	assert.equal(h2.closed, null);
	assert.deepEqual(h2.sent, []);
});

test("guest leaves: peer-left to host, once", () => {
	const { reg, h } = setup();
	const gs = reg.join(ROOM, "guest", new Fake());
	gs.onClose();
	gs.onClose();
	assert.deepEqual(h.sent, ['{"t":"peer-joined","peer":1}', '{"t":"peer-left","peer":1}']);
});

test("peer ids are never reused", () => {
	const { reg, h } = setup();
	reg.join(ROOM, "guest", new Fake()).onClose();
	reg.join(ROOM, "guest", new Fake());
	assert.equal(h.sent.at(-1), '{"t":"peer-joined","peer":2}');
});

test("oversize guest frame: 1009, dropped, peer-left", () => {
	const { reg, h } = setup({ maxFrameBytes: 16 });
	const g = new Fake();
	const gs = reg.join(ROOM, "guest", g);
	gs.onMessage(frame(0, ...new Array(20).fill(1)));
	assert.equal(g.closed?.code, CLOSE.tooBig);
	assert.equal(h.sent.length, 2); // joined + left, no frame
	assert.equal(h.sent[1], '{"t":"peer-left","peer":1}');
});

test("oversize host frame: 1009 and room torn down", () => {
	const { reg, h, hs } = setup({ maxFrameBytes: 16 });
	const g = new Fake();
	reg.join(ROOM, "guest", g);
	hs.onMessage(frame(0, ...new Array(20).fill(1)));
	assert.equal(h.closed?.code, CLOSE.tooBig);
	assert.equal(g.closed?.code, CLOSE.roomClosed);
	assert.equal(reg.roomCount, 0);
});

test("guest cap", () => {
	const { reg } = setup({ maxGuests: 3 });
	for (let i = 0; i < 3; i++) {
		const g = new Fake();
		reg.join(ROOM, "guest", g);
		assert.equal(g.closed, null);
	}
	const over = new Fake();
	reg.join(ROOM, "guest", over);
	assert.equal(over.closed?.code, CLOSE.roomFull);
	assert.equal(reg.guestCount, 3);
});

test("default guest cap is 16", () => {
	const { reg } = setup();
	const gs = Array.from({ length: 17 }, () => new Fake());
	for (const g of gs) reg.join(ROOM, "guest", g);
	assert.equal(gs.slice(0, 16).every((g) => g.closed === null), true);
	assert.equal(gs[16]!.closed?.code, CLOSE.roomFull);
});

test("rate limiter window", () => {
	let t = 0;
	const rl = new RateLimiter(2, 1000, () => t);
	assert.equal(rl.allow("a"), true);
	assert.equal(rl.allow("a"), true);
	assert.equal(rl.allow("a"), false);
	assert.equal(rl.allow("b"), true);
	t = 1000;
	assert.equal(rl.allow("a"), true);
});
