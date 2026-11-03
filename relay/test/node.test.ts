import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { startRelay, type RunningRelay } from "../src/node.ts";

let relay: RunningRelay;
before(async () => {
	relay = await startRelay({ port: 0, host: "127.0.0.1", maxGuests: 2, rateLimit: { max: 1000, windowMs: 60_000 } });
});
after(() => relay.close());

let n = 0;
const room = (): string => `room-test-${n++}-abcdefgh`;

interface Client {
	ws: WebSocket;
	msgs: { binary: boolean; data: Buffer }[];
	closed: Promise<{ code: number; reason: string }>;
	next(): Promise<{ binary: boolean; data: Buffer }>;
}
function connect(roomId: string, role: string, port = relay.port): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/r/${roomId}?role=${role}`);
	const msgs: Client["msgs"] = [];
	const waiters: ((m: Client["msgs"][0]) => void)[] = [];
	ws.on("message", (data, binary) => {
		const m = { binary, data: data as Buffer };
		const w = waiters.shift();
		if (w) w(m);
		else msgs.push(m);
	});
	const closed = new Promise<{ code: number; reason: string }>((res) =>
		ws.on("close", (code, reason) => res({ code, reason: reason.toString() })),
	);
	const c: Client = {
		ws,
		msgs,
		closed,
		next: () => (msgs.length ? Promise.resolve(msgs.shift()!) : new Promise((r) => waiters.push(r))),
	};
	return new Promise((res) => {
		ws.on("open", () => res(c));
		ws.on("error", () => res(c));
		ws.on("close", () => res(c));
	});
}
const frame = (peer: number, ...body: number[]): Buffer => {
	const b = Buffer.alloc(4 + body.length);
	b.writeUInt32BE(peer, 0);
	Buffer.from(body).copy(b, 4);
	return b;
};
const text = (m: { data: Buffer }): unknown => JSON.parse(m.data.toString());

test("/healthz", async () => {
	const r = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
	assert.equal(r.status, 200);
	assert.equal((await r.text()).trim(), "ok");
	assert.equal((await fetch(`http://127.0.0.1:${relay.port}/nope`)).status, 404);
});

test("non-room upgrade path -> 404", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/x`);
	const err = await new Promise<Error>((r) => ws.on("error", r));
	assert.match(err.message, /404/);
});

test("host/guest routing both ways with peer-id rewrite", async () => {
	const id = room();
	const host = await connect(id, "host");
	const g1 = await connect(id, "guest");
	assert.deepEqual(text(await host.next()), { t: "peer-joined", peer: 1 });
	const g2 = await connect(id, "guest");
	assert.deepEqual(text(await host.next()), { t: "peer-joined", peer: 2 });

	g2.ws.send(frame(77, 1, 2, 3));
	const up = await host.next();
	assert.equal(up.binary, true);
	assert.equal(up.data.readUInt32BE(0), 2);
	assert.deepEqual([...up.data.subarray(4)], [1, 2, 3]);

	host.ws.send(frame(0, 9));
	assert.deepEqual([...(await g1.next()).data], [0, 0, 0, 0, 9]);
	assert.deepEqual([...(await g2.next()).data], [0, 0, 0, 0, 9]);
	host.ws.send(frame(1, 5));
	assert.deepEqual([...(await g1.next()).data], [0, 0, 0, 1, 5]);
	assert.equal(g2.msgs.length, 0);

	g1.ws.close();
	assert.deepEqual(text(await host.next()), { t: "peer-left", peer: 1 });

	// room-closed + 4001
	host.ws.close();
	assert.deepEqual(text(await g2.next()), { t: "room-closed" });
	assert.equal((await g2.closed).code, 4001);
	// room GC'd: guest now 4004
	assert.equal((await (await connect(id, "guest")).closed).code, 4004);
});

test("4009 second host, 4004 missing room", async () => {
	const id = room();
	const host = await connect(id, "host");
	const h2 = await connect(id, "host");
	assert.equal((await h2.closed).code, 4009);
	// first host unaffected
	const g = await connect(id, "guest");
	assert.deepEqual(text(await host.next()), { t: "peer-joined", peer: 1 });
	g.ws.close();
	host.ws.close();
	assert.equal((await (await connect(room(), "guest")).closed).code, 4004);
});

test("guest cap -> 4008", async () => {
	const id = room();
	const host = await connect(id, "host");
	await connect(id, "guest");
	await connect(id, "guest");
	const over = await connect(id, "guest");
	assert.equal((await over.closed).code, 4008);
	host.ws.close();
});

test("oversize frame -> 1009", async () => {
	const id = room();
	const host = await connect(id, "host");
	const g = await connect(id, "guest");
	await host.next();
	g.ws.send(Buffer.alloc(1024 * 1024 + 1));
	assert.equal((await g.closed).code, 1009);
	assert.deepEqual(text(await host.next()), { t: "peer-left", peer: 1 });
	host.ws.close();
});

test("text frames from clients are ignored", async () => {
	const id = room();
	const host = await connect(id, "host");
	const g = await connect(id, "guest");
	await host.next();
	g.ws.send("hello");
	g.ws.send(frame(0, 4));
	assert.equal((await host.next()).binary, true);
	host.ws.close();
});

test("per-IP rate limit -> 429", async () => {
	const r = await startRelay({ port: 0, host: "127.0.0.1", rateLimit: { max: 2, windowMs: 60_000 } });
	try {
		const id = room();
		const a = await connect(id, "host", r.port);
		const b = await connect(id, "guest", r.port);
		const ws = new WebSocket(`ws://127.0.0.1:${r.port}/r/${id}?role=guest`);
		const err = await new Promise<Error>((res) => ws.on("error", res));
		assert.match(err.message, /429/);
		a.ws.close();
		b.ws.close();
	} finally {
		await r.close();
	}
});

test("finding 6: per-IP concurrent guest cap -> 429, freed when a guest leaves, hosts not counted", async () => {
	const r = await startRelay({ port: 0, host: "127.0.0.1", maxGuestsPerIp: 2, maxGuests: 16, rateLimit: { max: 1000, windowMs: 60_000 } });
	try {
		const id = room();
		const host = await connect(id, "host", r.port);
		const g1 = await connect(id, "guest", r.port);
		const g2 = await connect(id, "guest", r.port);
		const refused = new WebSocket(`ws://127.0.0.1:${r.port}/r/${id}?role=guest`);
		const err = await new Promise<Error>((res) => refused.on("error", res));
		assert.match(err.message, /429/);
		// another room's host is unaffected by the guest cap
		const other = await connect(room(), "host", r.port);
		g1.ws.close();
		await g1.closed;
		const g3 = await connect(id, "guest", r.port);
		for (const c of [host, g2, g3, other]) c.ws.close();
	} finally {
		await r.close();
	}
});

test("idle connection is pinged and dropped without pong", async () => {
	const r = await startRelay({ port: 0, host: "127.0.0.1", idleMs: 100, pongTimeoutMs: 100 });
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${r.port}/r/${room()}?role=host`, { autoPong: false });
		let pinged = false;
		ws.on("ping", () => (pinged = true));
		const code = await new Promise<number>((res) => ws.on("close", res));
		assert.equal(pinged, true);
		assert.equal(code, 1006);
	} finally {
		await r.close();
	}
});

test("close() sends room-closed to guests", async () => {
	const r = await startRelay({ port: 0, host: "127.0.0.1" });
	const id = room();
	const host = await connect(id, "host", r.port);
	const g = await connect(id, "guest", r.port);
	await host.next();
	await r.close();
	assert.deepEqual(text(await g.next()), { t: "room-closed" });
	assert.equal((await g.closed).code, 4001);
	assert.equal((await host.closed).code, 1001);
});
