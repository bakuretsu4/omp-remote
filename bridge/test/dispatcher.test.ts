import assert from "node:assert/strict";
import { once } from "node:events";
import {
	existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type {
	AppToBridge, HostEvent, SessionEvent, SessionSnapshot, SessionSummary,
} from "../../protocol/src/index.ts";
import { AttentionInbox } from "../src/attention.ts";
import type { SessionBackend } from "../src/backend.ts";
import type { Channel, Outgoing } from "../src/channel.ts";
import { parseConfig } from "../src/config.ts";
import { DeviceStore } from "../src/devices.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { OpError } from "../src/errors.ts";
import { HostToolRouter } from "../src/hosttools.ts";
import { SessionLauncher } from "../src/launcher.ts";
import { createBlobStore } from "../src/normalize/blobs.ts";
import { realpathUnder, resolveRoots } from "../src/safefs.ts";
import { SessionRegistry } from "../src/sessions.ts";
import { UploadManager, sanitizeName } from "../src/uploads.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-disp-")));
const root = join(tmp, "root");
const outside = join(tmp, "outside");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

before(() => {
	mkdirSync(join(root, "proj", "sub"), { recursive: true });
	mkdirSync(join(root, "repo", ".git", "info"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "top secret");
	writeFileSync(join(root, "proj", "a.txt"), "hello");
	symlinkSync(outside, join(root, "proj", "escape"));
	symlinkSync(join(root, "proj", "sub"), join(root, "proj", "inside-link"));
	symlinkSync(join(outside, "secret.txt"), join(root, "proj", "secret-link"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

class FakeChannel {
	id = "f#1";
	did = "did1";
	isOpen = true;
	out: Outgoing[] = [];
	send(m: Outgoing): void {
		this.out.push(m);
	}
	res(id: number): Extract<Outgoing, { t: "res" }> {
		return this.out.find((m): m is Extract<Outgoing, { t: "res" }> => m.t === "res" && m.id === id)!;
	}
}

class StubBackend implements SessionBackend {
	readonly kind = "managed" as const;
	listeners = new Set<(e: SessionEvent) => void>();
	closedL = new Set<(r: string) => void>();
	prompts: { message: string; atts: unknown[] }[] = [];
	cwd: string;
	readonly sid: string;
	constructor(sid: string, cwd: string) {
		this.sid = sid;
		this.cwd = cwd;
	}
	summary(): SessionSummary {
		return { sid: this.sid, kind: "managed", title: "stub", cwd: this.cwd, status: "idle", lastActivity: 1, pendingUi: 0, caps: ["prompt", "abort", "ui"] };
	}
	async snapshot(): Promise<SessionSnapshot> {
		return {
			summary: this.summary(), state: { isStreaming: false, isCompacting: false }, messages: [], hasMore: false,
			queue: { steering: [], followUp: [] }, todos: [], goal: null, pendingUi: [], subagents: [], runningTools: [],
		};
	}
	async history() {
		return { messages: [], hasMore: false };
	}
	subscribe(l: (e: SessionEvent) => void) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	emit(e: SessionEvent) {
		for (const l of this.listeners) l(e);
	}
	async prompt(a: { message: string }, atts: unknown[]) {
		this.prompts.push({ message: a.message, atts });
	}
	async abort() {
		return {};
	}
	async respondUi() {}
	async toolOutput() {
		return { text: "" };
	}
	ops = {};
	onAttention() {
		return () => {};
	}
	onSummaryChanged() {
		return () => {};
	}
	onClosed(l: (r: string) => void) {
		this.closedL.add(l);
		return () => this.closedL.delete(l);
	}
	async close() {}
}

async function rig() {
	const dir = join(tmp, `state${Math.random().toString(36).slice(2)}`);
	const config = parseConfig({ roots: [root], omp: { bin: "/nonexistent-omp" } });
	const roots = await resolveRoots(config.roots);
	const devices = new DeviceStore(dir);
	devices.add({ did: "did1", label: "t", dpk: "x", kDev: "k" });
	const inbox = new AttentionInbox();
	const registry = new SessionRegistry({ inbox, log: () => {} });
	const blobs = createBlobStore();
	const sessionCwd = new Map<string, string>();
	const uploads = new UploadManager({
		dir: join(dir, "uploads"), blobs, roots: () => roots,
		sessionCwd: sid => {
			const c = sessionCwd.get(sid);
			if (!c) throw new Error("no such session");
			return c;
		},
	});
	const chans: FakeChannel[] = [];
	const hostTools = new HostToolRouter({ channels: () => chans as unknown as Channel[], sendHev: () => {}, log: () => {} });
	const launcher = new SessionLauncher({
		config, registry, uploads, blobs, hostTools, roots: () => roots, log: () => {}, notice: () => {},
	});
	const disp = new Dispatcher({
		config, devices, registry, inbox, blobs, uploads, launcher, hostTools,
		hostInfo: () => ({ proto: 1, hostId: "h", name: "n", platform: "linux", bridgeVersion: "t", ompVersion: null, roots, push: false, now: 0 }),
		roots: () => roots, channels: () => chans as unknown as Channel[], log: () => {},
	});
	const ch = new FakeChannel();
	chans.push(ch);
	let id = 0;
	const call = async (op: string, a: unknown = {}) => {
		const rid = ++id;
		await disp.onRequest(ch as unknown as Channel, { q: rid, t: "req", id: rid, op, a } as AppToBridge as Extract<AppToBridge, { t: "req" }>);
		return ch.res(rid);
	};
	return { call, ch, disp, devices, inbox, registry, roots, blobs, uploads, sessionCwd };
}

const code = (r: { ok: boolean; e?: { code: string } }): string | undefined => (r.ok ? undefined : r.e?.code);

describe("fs", () => {
	it("lists beneath the root and hides symlinks that leave it", async () => {
		const { call, roots } = await rig();
		const roots_ = await call("fs.roots");
		assert.deepEqual((roots_ as { d: { roots: string[] } }).d.roots, roots);
		const r = (await call("fs.list", { path: join(root, "proj"), files: true })) as { ok: true; d: { entries: { name: string; dir: boolean }[] } };
		assert.ok(r.ok);
		const names = r.d.entries.map(e => e.name);
		assert.deepEqual(names.slice(0, 2), ["inside-link", "sub"]);
		assert.ok(names.includes("a.txt"));
		assert.ok(!names.includes("escape"), "symlink to outside dir hidden");
		assert.ok(!names.includes("secret-link"), "symlink to outside file hidden");
	});

	for (const [label, p] of [
		["parent traversal", join(root, "proj", "..", "..", "outside")],
		["absolute outside", outside],
		["/etc", "/etc"],
		["symlink escape", join(root, "proj", "escape")],
		["symlink then parent", `${join(root, "proj", "escape")}/../../..`],
		["prefix sibling", `${root}-evil`],
		["missing", join(root, "nope")],
	] as const) {
		it(`rejects ${label}`, async () => {
			const { call } = await rig();
			const r = await call("fs.list", { path: p });
			assert.equal(code(r as never), "forbidden_path");
		});
	}

	it("rejects NUL bytes with invalid", async () => {
		const { call } = await rig();
		assert.equal(code((await call("fs.list", { path: `${root}\0/x` })) as never), "invalid");
	});

	it("rejects non-string paths with invalid", async () => {
		const { call } = await rig();
		assert.equal(code((await call("fs.list", { path: 5 })) as never), "invalid");
	});

	it("realpathUnder follows symlinks that stay inside", async () => {
		const roots = await resolveRoots([root]);
		assert.equal(await realpathUnder(join(root, "proj", "inside-link"), roots), join(root, "proj", "sub"));
	});

	it("sessions.create refuses a cwd outside the roots (incl. via symlink) before spawning anything", async () => {
		const { call } = await rig();
		for (const cwd of [outside, join(root, "proj", "escape"), "/", join(root, "..")]) {
			assert.equal(code((await call("sessions.create", { cwd })) as never), "forbidden_path", cwd);
		}
	});

	it("sessions.open refuses files outside omp's session dir", async () => {
		const { call } = await rig();
		const f = join(root, "proj", "x.jsonl");
		writeFileSync(f, "{}\n");
		const r = await call("sessions.open", { sessionFile: f });
		assert.ok(["forbidden_path", "not_found"].includes(code(r as never)!));
	});
});

describe("dispatch basics", () => {
	it("answers unknown ops with unsupported", async () => {
		const { call } = await rig();
		assert.equal(code((await call("nope.nothing")) as never), "unsupported");
		assert.equal(code((await call("__proto__")) as never), "unsupported");
		assert.equal(code((await call("toString")) as never), "unsupported");
	});

	it("rejects non-object arguments", async () => {
		const { call } = await rig();
		assert.equal(code((await call("fs.list", "x")) as never), "invalid");
	});

	it("refuses everything for a revoked device", async () => {
		const { call, devices } = await rig();
		devices.revoke("did1");
		const rid = (await call("host.info")) as { ok: boolean };
		assert.equal(rid, undefined, "no response is sent to a revoked device");
	});

	it("a device that revokes itself still gets its reply, then silence", async () => {
		const { call, devices } = await rig();
		const r = (await call("devices.revoke", { did: "did1" })) as { ok: boolean };
		assert.equal(r.ok, true);
		assert.equal(devices.get("did1"), undefined);
		assert.equal((await call("host.info")) as unknown, undefined);
	});

	it("serves host.info", async () => {
		const { call } = await rig();
		const r = (await call("host.info")) as { ok: true; d: { proto: number } };
		assert.equal(r.d.proto, 1);
	});

	it("devices.list marks the current device, devices.revoke revokes", async () => {
		const { call, devices } = await rig();
		devices.add({ did: "did2", label: "other", dpk: "x", kDev: "k2" });
		const l = (await call("devices.list")) as { d: { devices: { did: string; current: boolean }[] } };
		assert.deepEqual(l.d.devices.map(d => [d.did, d.current]), [["did1", true], ["did2", false]]);
		assert.equal(((await call("devices.revoke", { did: "did2" })) as { ok: boolean }).ok, true);
		assert.equal(devices.get("did2"), undefined);
		assert.equal(code((await call("devices.revoke", { did: "did2" })) as never), "not_found");
	});

	it("push.register stores the token for this device only", async () => {
		const { call, devices } = await rig();
		devices.add({ did: "did2", label: "o", dpk: "x", kDev: "k2" });
		devices.setPush("did2", { provider: "fcm", token: "TOKEN" });
		await call("push.register", { provider: "fcm", token: "TOKEN" });
		assert.deepEqual(devices.get("did1")!.push, { provider: "fcm", token: "TOKEN" });
		assert.equal(devices.get("did2")!.push, undefined, "the same token moves to the newest registrant");
		assert.equal(code((await call("push.register", { provider: "apns", token: "x" })) as never), "invalid");
	});

	it("push.register accepts a public UnifiedPush endpoint, rejects an internal one, and push.unregister clears it", async () => {
		const { call, devices } = await rig();
		const registered = (await call("push.register", { provider: "unifiedpush", endpoint: "https://ntfy.sh/upX" })) as { ok: boolean }; // the test rig returns the untyped reply envelope
		assert.equal(registered.ok, true);
		assert.deepEqual(devices.get("did1")!.push, { provider: "unifiedpush", endpoint: "https://ntfy.sh/upX" });
		assert.equal(code((await call("push.register", { provider: "unifiedpush", endpoint: "https://192.168.1.5/x" })) as never), "invalid");
		assert.deepEqual(devices.get("did1")!.push, { provider: "unifiedpush", endpoint: "https://ntfy.sh/upX" }, "a rejected registration leaves the old one alone");
		const cleared = (await call("push.unregister")) as { ok: boolean }; // same untyped envelope
		assert.equal(cleared.ok, true);
		assert.equal(devices.get("did1")!.push, undefined);
	});

	it("blob.get pages bytes", async () => {
		const { call, blobs } = await rig();
		const ref = blobs.put(PNG, "image/png");
		const r = (await call("blob.get", { ref, off: 0, len: 10 })) as { d: { data: string; total: number; mimeType: string } };
		assert.equal(r.d.total, PNG.length);
		assert.equal(Buffer.from(r.d.data, "base64").length, 10);
		const r2 = (await call("blob.get", { ref, off: 10, len: 1000 })) as { d: { data: string } };
		assert.deepEqual(Buffer.concat([Buffer.from(r.d.data, "base64"), Buffer.from(r2.d.data, "base64")]), PNG);
		assert.equal(code((await call("blob.get", { ref: "b_nope" })) as never), "not_found");
	});

	it("attention.list / dismiss", async () => {
		const { call, inbox } = await rig();
		const it1 = inbox.add({ sid: "s", sessionTitle: "t", kind: "approval", summary: "x", uiReqId: "u1" })!;
		const l = (await call("attention.list", { since: 0 })) as { d: { items: { id: string }[] } };
		assert.equal(l.d.items[0]!.id, it1.id);
		await call("attention.dismiss", { id: it1.id });
		assert.equal(inbox.get(it1.id)!.resolved, true);
	});
});

describe("session subscription", () => {
	it("returns n at subscribe time and delivers later events with n+1…, buffered ones after the response", async () => {
		const { call, ch, registry } = await rig();
		const b = new StubBackend("m_1", root);
		registry.add(b);
		b.emit({ k: "agent.start" }); // seq 1 before subscribing
		const r = (await call("session.open", { sid: "m_1" })) as { d: { n: number } };
		assert.equal(r.d.n, 1);
		b.emit({ k: "agent.end", yielded: true, settled: true });
		b.emit({ k: "notice", level: "info", message: "x" });
		const evs = ch.out.filter(m => m.t === "ev") as Extract<Outgoing, { t: "ev" }>[];
		assert.deepEqual(evs.map(e => e.n), [2, 3]);
		await call("session.close", { sid: "m_1" });
		b.emit({ k: "notice", level: "info", message: "y" });
		assert.equal(ch.out.filter(m => m.t === "ev").length, 2);
	});

	it("sends a closed event and drops the subscription when the session is removed", async () => {
		const { call, ch, registry } = await rig();
		const b = new StubBackend("m_2", root);
		registry.add(b);
		await call("session.open", { sid: "m_2" });
		registry.remove("m_2");
		const evs = ch.out.filter(m => m.t === "ev") as Extract<Outgoing, { t: "ev" }>[];
		assert.equal(evs.at(-1)!.e.k, "closed");
	});

	it("rejects opening a recent sid with invalid and an unknown sid with not_found", async () => {
		const { call } = await rig();
		assert.equal(code((await call("session.open", { sid: "r_abc" })) as never), "invalid");
		assert.equal(code((await call("session.open", { sid: "m_zzz" })) as never), "not_found");
	});

	it("broadcasts sessions.changed and attention host events", async () => {
		const { ch, registry, inbox } = await rig();
		const hevs: HostEvent[] = [];
		const orig = ch.send.bind(ch);
		ch.send = m => {
			if (m.t === "hev") hevs.push(m.e);
			orig(m);
		};
		registry.add(new StubBackend("m_3", root));
		const item = inbox.add({ sid: "m_3", sessionTitle: "t", kind: "done", summary: "ok" })!;
		inbox.resolve(item.id);
		await once(registry, "changed");
		const kinds = hevs.map(e => e.k);
		assert.ok(kinds.includes("sessions.changed"));
		assert.ok(kinds.includes("attention"));
		assert.ok(kinds.includes("attention.resolved"));
	});

	it("prompt with an image attachment resolves the upload ref to base64 image content", async () => {
		const { call, registry, blobs } = await rig();
		const b = new StubBackend("m_4", root);
		registry.add(b);
		const ref = blobs.put(PNG, "image/png");
		const r = await call("session.prompt", { sid: "m_4", message: "look", attachments: [{ ref }] });
		assert.ok((r as { ok: boolean }).ok);
		assert.deepEqual(b.prompts[0]!.atts, [{ kind: "image", mimeType: "image/png", dataBase64: PNG.toString("base64") }]);
		assert.equal(code((await call("session.prompt", { sid: "m_4", message: "x", attachments: [{ ref: "b_missing" }] })) as never), "invalid");
		assert.equal(code((await call("session.prompt", { sid: "m_4", message: "x", behavior: "later" })) as never), "invalid");
	});
});

describe("uploads", () => {
	const upload = async (call: Awaited<ReturnType<typeof rig>>["call"], a: Record<string, unknown>, bytes: Buffer, chunk = 7) => {
		const b = (await call("upload.begin", a)) as { ok: boolean; d: { uploadId: string }; e?: { code: string } };
		if (!b.ok) return { b };
		let i = 0;
		for (let off = 0; off < bytes.length; off += chunk) {
			const c = await call("upload.chunk", { uploadId: b.d.uploadId, i: i++, d: bytes.subarray(off, off + chunk).toString("base64") });
			assert.ok((c as { ok: boolean }).ok);
		}
		const e = (await call("upload.end", { uploadId: b.d.uploadId })) as { ok: boolean; d: { ref: string; path?: string }; e?: { code: string } };
		return { b, e };
	};

	it("stores an image as a blob ref and refuses non-images", async () => {
		const { call, blobs } = await rig();
		const { e } = await upload(call, { name: "p.png", mime: "image/png", size: PNG.length, purpose: "image" }, PNG);
		assert.ok(e!.ok);
		assert.deepEqual(Buffer.from(blobs.get(e!.d.ref)!.bytes), PNG);
		const bad = await upload(call, { name: "p.png", mime: "image/png", size: 5, purpose: "image" }, Buffer.from("hello"));
		assert.equal(bad.e!.e!.code, "invalid");
		const badMime = await call("upload.begin", { name: "p.svg", mime: "image/svg+xml", size: 5, purpose: "image" });
		assert.equal(code(badMime as never), "invalid");
	});

	it("writes files into <cwd>/.ompr-inbox (0700/0600), sanitises the name, excludes it from git", async () => {
		const { call, registry, sessionCwd } = await rig();
		const cwd = join(root, "repo");
		sessionCwd.set("m_f", cwd);
		registry.add(new StubBackend("m_f", cwd));
		const data = Buffer.from("file body\n");
		const { e } = await upload(call, { name: "../../we ird/na me.txt", mime: "text/plain", size: data.length, purpose: "file", sid: "m_f" }, data);
		assert.ok(e!.ok, JSON.stringify(e));
		const p = e!.d.path!;
		assert.ok(p.startsWith(join(cwd, ".ompr-inbox") + "/"));
		assert.match(p.slice(p.lastIndexOf("/") + 1), /^\d+-na_me\.txt$/);
		assert.equal(readFileSync(p, "utf8"), "file body\n");
		assert.equal(statSync(p).mode & 0o777, 0o600);
		assert.equal(statSync(join(cwd, ".ompr-inbox")).mode & 0o777, 0o700);
		assert.match(readFileSync(join(cwd, ".git", "info", "exclude"), "utf8"), /^\.ompr-inbox\/$/m);
		const again = await upload(call, { name: "x.txt", mime: "text/plain", size: 1, purpose: "file", sid: "m_f" }, Buffer.from("x"));
		assert.ok(again.e!.ok);
		const ex = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
		assert.equal(ex.split("\n").filter(l => l === ".ompr-inbox/").length, 1, "exclude line is not duplicated");
	});

	it("a file ref becomes an appended-path attachment", async () => {
		const { call, registry, sessionCwd } = await rig();
		const cwd = join(root, "proj");
		sessionCwd.set("m_g", cwd);
		const b = new StubBackend("m_g", cwd);
		registry.add(b);
		const { e } = await upload(call, { name: "n.txt", mime: "text/plain", size: 2, purpose: "file", sid: "m_g" }, Buffer.from("hi"));
		await call("session.prompt", { sid: "m_g", message: "see", attachments: [{ ref: e!.d.ref }] });
		const att = b.prompts[0]!.atts[0] as { kind: string; path: string };
		assert.equal(att.kind, "file");
		assert.equal(att.path, e!.d.path);
	});

	it("refuses an inbox that is a symlink", async () => {
		const { call, registry, sessionCwd } = await rig();
		const cwd = join(root, "linked");
		mkdirSync(cwd, { recursive: true });
		symlinkSync(outside, join(cwd, ".ompr-inbox"));
		sessionCwd.set("m_h", cwd);
		registry.add(new StubBackend("m_h", cwd));
		const { e } = await upload(call, { name: "n.txt", mime: "text/plain", size: 2, purpose: "file", sid: "m_h" }, Buffer.from("hi"));
		assert.equal(e!.e!.code, "forbidden_path");
		assert.ok(!existsSync(join(outside, "n.txt")));
	});

	it("refuses a session cwd that resolves outside the roots", async () => {
		const { call, sessionCwd } = await rig();
		sessionCwd.set("m_i", join(root, "proj", "escape"));
		const r = await call("upload.begin", { name: "n", mime: "text/plain", size: 1, purpose: "file", sid: "m_i" });
		assert.equal(code(r as never), "forbidden_path");
	});

	it("enforces the 64 MiB cap, ordered chunks, declared size and ownership", async () => {
		const { call, uploads } = await rig();
		assert.equal(code((await call("upload.begin", { name: "big", mime: "image/png", size: 64 * 1024 * 1024 + 1, purpose: "image" })) as never), "invalid");
		const b = (await call("upload.begin", { name: "a.png", mime: "image/png", size: 4, purpose: "image" })) as { d: { uploadId: string } };
		const id = b.d.uploadId;
		assert.equal(code((await call("upload.chunk", { uploadId: id, i: 1, d: "AAAA" })) as never), "invalid", "out of order");
		assert.equal(code((await call("upload.chunk", { uploadId: id, i: 0, d: Buffer.alloc(5).toString("base64") })) as never), "invalid", "more than declared");
		assert.equal(code((await call("upload.chunk", { uploadId: id, i: 0, d: Buffer.alloc(300 * 1024).toString("base64") })) as never), "invalid", "chunk too large");
		await call("upload.chunk", { uploadId: id, i: 0, d: Buffer.alloc(2).toString("base64") });
		assert.equal(code((await call("upload.end", { uploadId: id })) as never), "invalid", "incomplete");
		assert.equal(uploads.activeCount, 0, "a failed end discards the upload");
		assert.equal(code((await call("upload.chunk", { uploadId: "u_nope", i: 0, d: "" })) as never), "not_found");
		assert.equal(uploads.activeCount, 0);
	});

	it("another device cannot touch someone else's upload", async () => {
		const { call, uploads } = await rig();
		const b = (await call("upload.begin", { name: "a.png", mime: "image/png", size: 4, purpose: "image" })) as { d: { uploadId: string } };
		assert.throws(() => uploads.chunk("other-did", { uploadId: b.d.uploadId, i: 0, d: "AAAA" }), (e: unknown) => e instanceof OpError && e.code === "not_found");
	});

	it("sanitizeName", () => {
		assert.equal(sanitizeName("../../etc/passwd"), "passwd");
		assert.equal(sanitizeName(".hidden"), "hidden");
		assert.equal(sanitizeName("a b/c d.png"), "c_d.png");
		assert.equal(sanitizeName("..."), "file");
		assert.ok(sanitizeName(`${"x".repeat(300)}.txt`).length <= 100);
		assert.ok(lstatSync(tmp).isDirectory());
	});
});
