/**
 * L2 op routing (PROTOCOL.md §6). One `Dispatcher` serves every open channel: it validates arguments,
 * enforces filesystem roots, owns per-peer session subscriptions and assigns nothing to events itself
 * (the registry numbers them; the snapshot's `n` is the index at subscribe time).
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	AppToBridge, ApprovalMode, Cap, FsEntry, HostEvent, HostInfo, Message, OpName, Ops, SessionEvent,
	SessionSnapshot, SessionSummary, ThinkingLevel, UiAnswer,
} from "../../protocol/src/index.ts";
import type { AttentionInbox } from "./attention.ts";
import type { BlobStore, SessionBackend, SessionOpHandlers } from "./backend.ts";
import type { Channel, Outgoing } from "./channel.ts";
import { APPROVAL_MODES, ompSessionsDir, type Config } from "./config.ts";
import type { DeviceStore } from "./devices.ts";
import { OpError, invalid, notFound, toWireError, unsupported } from "./errors.ts";
import { isRecord } from "./guards.ts";
import type { HostToolRouter } from "./hosttools.ts";
import type { SessionLauncher } from "./launcher.ts";
import { listRecentSessions } from "./recent.ts";
import { expandPath, isUnder, realpathUnder } from "./safefs.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { UploadManager } from "./uploads.ts";

export interface DispatcherDeps {
	config: Config;
	devices: DeviceStore;
	registry: SessionRegistry;
	inbox: AttentionInbox;
	blobs: BlobStore;
	uploads: UploadManager;
	launcher: Pick<SessionLauncher, "create" | "openFile" | "handover" | "models" | "assertApprovalAllowed">;
	hostTools: HostToolRouter;
	hostInfo: () => HostInfo;
	/** Realpath'd roots. */
	roots: () => string[];
	channels: () => Channel[];
	log: (m: string) => void;
}

const MAX_INFLIGHT = 64;
const SNAPSHOT_BUDGET = 380_000;
const PAGE_BUDGET = 380_000;
const BLOB_CHUNK = 192 * 1024;
const BLOB_MAX = 256 * 1024;
const FS_LIST_MAX = 2000;
const FS_LIST_BUDGET = 360_000;
const THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Sub {
	/** Events received while the snapshot was being built; flushed right after the response. */
	buffer: { seq: number; e: SessionEvent }[] | null;
	lastSeq: number;
}

interface Peer {
	subs: Map<string, Sub>;
	inflight: number;
}

/** Collects work to run after the response frame has been sent. */
interface Ctx {
	ch: Channel;
	did: string;
	after(fn: () => void): void;
	/** The caller revoked itself: it still gets this one `res`, then silence. */
	allowReplyAfterRevoke(): void;
}

interface CallState {
	afters: (() => void)[];
	forceReply: boolean;
}

type Handlers = { [K in OpName]: (c: Ctx, a: Ops[K]["a"]) => Promise<Ops[K]["d"]> | Ops[K]["d"] };

function obj(a: unknown): Record<string, unknown> {
	if (!isRecord(a)) throw invalid("arguments must be an object");
	return a;
}

function str(a: Record<string, unknown>, key: string, max = 4096): string {
	const v = a[key];
	if (typeof v !== "string" || v.length === 0 || v.length > max) throw invalid(`${key} must be a non-empty string (≤${max} chars)`);
	return v;
}

const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

export class Dispatcher {
	readonly #d: DispatcherDeps;
	readonly #peers = new Map<Channel, Peer>();
	readonly #handlers: Handlers;

	constructor(d: DispatcherDeps) {
		this.#d = d;
		this.#handlers = this.#buildHandlers();
		d.registry.on("event", (sid: string, seq: number, e: SessionEvent) => this.#onSessionEvent(sid, seq, e));
		d.registry.on("removed", (sid: string) => this.#onSessionRemoved(sid));
		d.registry.on("changed", () => this.broadcast({ k: "sessions.changed" }));
		d.inbox.on("item", item => this.broadcast({ k: "attention", item }));
		d.inbox.on("resolved", item => this.broadcast({ k: "attention.resolved", id: item.id }));
	}

	/** Sends a host event to every open, authorised channel. */
	broadcast(e: HostEvent): void {
		for (const ch of this.#d.channels()) this.#sendHev(ch, e);
	}

	sendHev(ch: Channel, e: HostEvent): void {
		this.#sendHev(ch, e);
	}

	onChannelClosed(ch: Channel): void {
		this.#peers.delete(ch);
	}

	/** Entry point for one decoded `req`. Always answers (unless the channel is gone). */
	async onRequest(ch: Channel, req: Extract<AppToBridge, { t: "req" }>): Promise<void> {
		const peer = this.#peer(ch);
		if (peer.inflight >= MAX_INFLIGHT) {
			this.#send(ch, { t: "res", id: req.id, ok: false, e: { code: "busy", message: "too many requests in flight" } });
			return;
		}
		peer.inflight++;
		const state: CallState = { afters: [], forceReply: false };
		try {
			const d = await this.#run(ch, req, state);
			this.#send(ch, { t: "res", id: req.id, ok: true, d }, state.forceReply);
			for (const f of state.afters) f();
		} catch (e) {
			if (!(e instanceof OpError)) this.#d.log(`[${ch.id}] op ${req.op} failed: ${(e as Error).message}`);
			this.#send(ch, { t: "res", id: req.id, ok: false, e: toWireError(e) }, state.forceReply);
		} finally {
			peer.inflight--;
		}
	}

	async #run(ch: Channel, req: Extract<AppToBridge, { t: "req" }>, state: CallState): Promise<unknown> {
		const did = ch.did;
		if (!did || !this.#d.devices.get(did)) throw new OpError("unauthorized", "device not authorised");
		if (!Object.hasOwn(this.#handlers, req.op)) throw unsupported(`unknown op ${String(req.op).slice(0, 64)}`);
		const handler = this.#handlers[req.op] as (c: Ctx, a: unknown) => unknown;
		return await handler({ ch, did, after: f => state.afters.push(f), allowReplyAfterRevoke: () => (state.forceReply = true) }, req.a);
	}

	#peer(ch: Channel): Peer {
		let p = this.#peers.get(ch);
		if (!p) {
			p = { subs: new Map(), inflight: 0 };
			this.#peers.set(ch, p);
		}
		return p;
	}

	#authorised(ch: Channel): boolean {
		return ch.isOpen && ch.did !== undefined && this.#d.devices.get(ch.did) !== undefined;
	}

	#send(ch: Channel, msg: Outgoing, force = false): void {
		if (force ? !ch.isOpen : !this.#authorised(ch)) return;
		try {
			ch.send(msg);
		} catch (e) {
			this.#d.log(`[${ch.id}] send failed: ${(e as Error).message}`);
			if (msg.t === "res") {
				try {
					ch.send({ t: "res", id: msg.id, ok: false, e: { code: "internal", message: "response too large" } });
				} catch {
					// channel gone
				}
			}
		}
	}

	#sendHev(ch: Channel, e: HostEvent): void {
		this.#send(ch, { t: "hev", e });
	}

	// ───────────────────────────── session events ─────────────────────────────

	#onSessionEvent(sid: string, seq: number, e: SessionEvent): void {
		for (const [ch, peer] of this.#peers) {
			const sub = peer.subs.get(sid);
			if (!sub) continue;
			if (sub.buffer) {
				sub.buffer.push({ seq, e });
				continue;
			}
			this.#sendEv(ch, sid, seq, e);
			sub.lastSeq = seq;
			if (e.k === "closed") peer.subs.delete(sid);
		}
	}

	#onSessionRemoved(sid: string): void {
		for (const [ch, peer] of this.#peers) {
			const sub = peer.subs.get(sid);
			if (!sub) continue;
			peer.subs.delete(sid);
			if (!sub.buffer) this.#sendEv(ch, sid, sub.lastSeq + 1, { k: "closed", reason: "session ended" });
		}
	}

	#sendEv(ch: Channel, sid: string, n: number, e: SessionEvent): void {
		if (!this.#authorised(ch)) return;
		try {
			ch.send({ t: "ev", sid, n, e });
			return;
		} catch {
			// most likely over MAX_PLAINTEXT: degrade the event instead of losing it
		}
		const slim = shrinkEvent(e);
		try {
			ch.send({ t: "ev", sid, n, e: slim });
		} catch (err) {
			this.#d.log(`[${ch.id}] dropped oversized ${e.k} event: ${(err as Error).message}`);
		}
	}

	// ───────────────────────────── helpers ─────────────────────────────

	#backend(a: Record<string, unknown>): SessionBackend {
		const sid = str(a, "sid", 128);
		const b = this.#d.registry.get(sid);
		if (!b) {
			if (sid.startsWith("r_")) throw invalid("this is a recent session; open it with sessions.open first");
			throw notFound("no such session");
		}
		return b;
	}

	#require(b: SessionBackend, cap: Cap): void {
		if (!b.summary().caps.includes(cap)) throw new OpError("readonly", `this session does not support ${cap}`);
	}

	async #sessionOp<K extends keyof SessionOpHandlers>(op: K, a: unknown): Promise<unknown> {
		const args = obj(a);
		const b = this.#backend(args);
		const fn = b.ops[op] as ((x: unknown) => Promise<unknown>) | undefined;
		if (!fn) throw unsupported(`${op} is not available for this session`);
		return fn(args);
	}

	#recentCwdAllowed(cwd: string): boolean {
		const abs = resolve(cwd);
		return this.#d.roots().some(r => isUnder(abs, r)) || this.#d.config.roots.some(r => {
			try {
				return isUnder(abs, expandPath(r));
			} catch {
				return false;
			}
		});
	}

	// ───────────────────────────── handlers ─────────────────────────────

	#buildHandlers(): Handlers {
		const d = this.#d;
		return {
			"host.info": () => d.hostInfo(),

			"models.list": async (_c, a) => {
				const sid = obj(a).sid;
				if (sid !== undefined && typeof sid !== "string") throw invalid("sid must be a string");
				return { models: await d.launcher.models(sid) };
			},

			"fs.roots": () => ({ roots: d.roots() }),

			"fs.list": async (_c, a) => {
				const args = obj(a);
				const real = await realpathUnder(args.path, d.roots());
				if (!(await stat(real)).isDirectory()) throw invalid("not a directory");
				const files = args.files === true;
				const names = await readdir(real, { withFileTypes: true });
				const entries: FsEntry[] = [];
				let budget = 0;
				for (const ent of names) {
					if (entries.length >= FS_LIST_MAX || budget > FS_LIST_BUDGET) break;
					const p = join(real, ent.name);
					try {
						let target = p;
						if (ent.isSymbolicLink()) {
							target = await realpath(p);
							if (!d.roots().some(r => isUnder(target, r))) continue; // links leaving the roots are invisible
						}
						const st = await stat(target);
						const dir = st.isDirectory();
						if (!dir && !files) continue;
						const e: FsEntry = { name: ent.name, path: p, dir, mtime: Math.floor(st.mtimeMs) };
						if (!dir) e.size = st.size;
						entries.push(e);
						budget += byteLen(e);
					} catch {
						// vanished or unreadable entry
					}
				}
				entries.sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
				return { path: real, entries };
			},

			"attention.list": (_c, a) => {
				const since = obj(a).since;
				if (since !== undefined && typeof since !== "number") throw invalid("since must be a number");
				return { items: d.inbox.list(since ?? 0) };
			},

			"attention.dismiss": (_c, a) => {
				d.inbox.resolve(str(obj(a), "id", 64));
				return {};
			},

			"push.register": (c, a) => {
				const args = obj(a);
				if (args.provider !== "fcm") throw invalid("provider must be fcm");
				const token = str(args, "token", 4096);
				for (const dev of d.devices.list()) if (dev.did !== c.did) d.devices.clearPush(dev.did, token);
				d.devices.setPush(c.did, token);
				return {};
			},

			"devices.list": c => ({
				devices: d.devices.list().filter(x => !x.revoked).map(x => ({ did: x.did, label: x.label, lastSeen: x.lastSeen, current: x.did === c.did })),
			}),

			"devices.revoke": (c, a) => {
				const did = str(obj(a), "did", 64);
				if (did === c.did) c.allowReplyAfterRevoke();
				if (!d.devices.revoke(did)) throw notFound("no such active device");
				return {};
			},

			// Replaced by their feature modules; until then a bridge answers "unsupported" and does not list them in host.info features.
			"peer.sync": () => {
				throw unsupported("this bridge has no peer configured");
			},
			"usage.get": () => {
				throw unsupported("usage is not available on this bridge");
			},
			"fs.read": () => {
				throw unsupported("file reading is not available on this bridge");
			},
			"git.status": () => {
				throw unsupported("git is not available on this bridge");
			},
			"git.diff": () => {
				throw unsupported("git is not available on this bridge");
			},

			"sessions.list": async (_c, a) => {
				const recent = obj(a).recent;
				if (recent !== undefined && (!Number.isInteger(recent) || (recent as number) < 0)) throw invalid("recent must be a non-negative integer");
				const sessions: SessionSummary[] = d.registry.list();
				const want = Math.min((recent as number | undefined) ?? 0, 100);
				if (want > 0) {
					const infos = await listRecentSessions({ sessionsDir: ompSessionsDir(d.config), limit: want * 3, excludeFiles: d.registry.liveFiles() });
					for (const i of infos) {
						if (sessions.filter(s => s.kind === "recent").length >= want) break;
						if (!this.#recentCwdAllowed(i.cwd)) continue;
						sessions.push({
							sid: i.sid, kind: "recent", title: i.title, cwd: i.cwd, status: "offline", lastActivity: Math.floor(i.mtimeMs),
							pendingUi: 0, sessionFile: i.sessionFile, caps: [],
						});
					}
				}
				return { sessions };
			},

			"sessions.create": async (_c, a) => d.launcher.create(a),

			"sessions.open": async (_c, a) => d.launcher.openFile(obj(a).sessionFile),

			"sessions.stop": async (_c, a) => {
				const b = this.#backend(obj(a));
				if (b.kind !== "managed") throw new OpError("readonly", "only sessions started from the phone can be stopped here");
				await b.close();
				d.registry.remove(b.sid);
				return {};
			},

			"sessions.handover": async (_c, a) => d.launcher.handover(str(obj(a), "sid", 128)),

			"sessions.rename": async (_c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				if (!b.rename) throw unsupported("renaming is not available for this session");
				await b.rename(str(args, "name", 200));
				return {};
			},

			"session.open": async (c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				const limit = args.limit === undefined ? 200 : args.limit;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid("limit must be 1..1000");
				const peer = this.#peer(c.ch);
				const n = d.registry.seq(b.sid);
				const sub: Sub = { buffer: [], lastSeq: n };
				peer.subs.set(b.sid, sub);
				let snapshot: SessionSnapshot;
				try {
					snapshot = fitSnapshot(await b.snapshot(limit));
				} catch (e) {
					peer.subs.delete(b.sid);
					throw e;
				}
				c.after(() => {
					const buffered = sub.buffer ?? [];
					sub.buffer = null;
					for (const { seq, e } of buffered) {
						this.#sendEv(c.ch, b.sid, seq, e);
						sub.lastSeq = seq;
						if (e.k === "closed") peer.subs.delete(b.sid);
					}
				});
				return { snapshot, n };
			},

			"session.close": (c, a) => {
				this.#peer(c.ch).subs.delete(str(obj(a), "sid", 128));
				return {};
			},

			"session.history": async (_c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				const limit = args.limit === undefined ? 100 : args.limit;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid("limit must be 1..500");
				if (args.before !== undefined && typeof args.before !== "string") throw invalid("before must be a string");
				const page = await b.history(args.before, limit);
				return fitMessages(page.messages, page.hasMore, PAGE_BUDGET);
			},

			"tool.output": async (_c, a) => {
				const args = obj(a);
				const off = args.off === undefined ? 0 : args.off;
				if (typeof off !== "number" || !Number.isInteger(off) || off < 0) throw invalid("off must be a non-negative integer");
				return this.#backend(args).toolOutput(str(args, "callId", 256), off);
			},

			"blob.get": (_c, a) => {
				const args = obj(a);
				const blob = d.blobs.get(str(args, "ref", 128));
				if (!blob) throw notFound("unknown or expired blob");
				const off = args.off === undefined ? 0 : args.off;
				const len = args.len === undefined ? BLOB_CHUNK : args.len;
				if (typeof off !== "number" || !Number.isInteger(off) || off < 0) throw invalid("off must be a non-negative integer");
				if (typeof len !== "number" || !Number.isInteger(len) || len < 1) throw invalid("len must be a positive integer");
				const end = Math.min(blob.bytes.byteLength, off + Math.min(len, BLOB_MAX));
				const slice = off >= end ? Buffer.alloc(0) : Buffer.from(blob.bytes.subarray(off, end));
				return { data: slice.toString("base64"), total: blob.bytes.byteLength, mimeType: blob.mimeType };
			},

			"session.prompt": async (_c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				if (typeof args.message !== "string" || args.message.length > 200_000) throw invalid("message must be a string");
				const behavior = args.behavior;
				if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") throw invalid("behavior must be steer or followUp");
				const attachments = d.uploads.resolve(args.attachments as { ref: string }[] | undefined);
				if (args.message.trim().length === 0 && attachments.length === 0) throw invalid("empty prompt");
				this.#require(b, "prompt");
				await b.prompt(args as unknown as Ops["session.prompt"]["a"], attachments);
				return {};
			},

			"session.abort": async (_c, a) => {
				const b = this.#backend(obj(a));
				this.#require(b, "abort");
				const r = await b.abort();
				d.inbox.resolveSession(b.sid, ["approval", "question"]);
				return r;
			},

			"session.queue.remove": async (_c, a) => {
				const args = obj(a);
				str(args, "message", 100_000);
				if (args.queue !== "steering" && args.queue !== "followUp") throw invalid("queue must be steering or followUp");
				return (await this.#sessionOp("session.queue.remove", a)) as Ops["session.queue.remove"]["d"];
			},

			"session.queue.promote": async (_c, a) => {
				str(obj(a), "message", 100_000);
				return (await this.#sessionOp("session.queue.promote", a)) as Ops["session.queue.promote"]["d"];
			},

			"ui.respond": async (_c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				const reqId = str(args, "reqId", 256);
				if (!isRecord(args.answer)) throw invalid("answer must be an object");
				this.#require(b, "ui");
				await b.respondUi(reqId, args.answer as UiAnswer);
				d.inbox.resolveSession(b.sid, ["approval", "question"], reqId);
				return {};
			},

			"session.btw": async (_c, a) => {
				str(obj(a), "question", 8000);
				return (await this.#sessionOp("session.btw", a)) as Ops["session.btw"]["d"];
			},

			"session.set": async (_c, a) => {
				const args = obj(a);
				if (args.thinkingLevel !== undefined && !THINKING.includes(args.thinkingLevel as ThinkingLevel)) throw invalid("unknown thinkingLevel");
				if (args.approvalMode !== undefined) {
					if (!(APPROVAL_MODES as readonly unknown[]).includes(args.approvalMode)) throw invalid("unknown approvalMode");
					d.launcher.assertApprovalAllowed(args.approvalMode as ApprovalMode);
				}
				if (args.fastMode !== undefined && typeof args.fastMode !== "boolean") throw invalid("fastMode must be a boolean");
				if (args.autoCompaction !== undefined && typeof args.autoCompaction !== "boolean") throw invalid("autoCompaction must be a boolean");
				if (args.model !== undefined && (!isRecord(args.model) || typeof args.model.provider !== "string" || typeof args.model.id !== "string")) throw invalid("model must be {provider, id}");
				return (await this.#sessionOp("session.set", a)) as Ops["session.set"]["d"];
			},

			"session.compact": async (_c, a) => {
				const ins = obj(a).instructions;
				if (ins !== undefined && (typeof ins !== "string" || ins.length > 20_000)) throw invalid("instructions must be a string");
				return (await this.#sessionOp("session.compact", a)) as Ops["session.compact"]["d"];
			},

			"session.goal": async (_c, a) => {
				const args = obj(a);
				if (!["create", "pause", "resume", "drop"].includes(args.op as string)) throw invalid("op must be create, pause, resume or drop");
				if (args.objective !== undefined && typeof args.objective !== "string") throw invalid("objective must be a string");
				if (args.tokenBudget !== undefined && (typeof args.tokenBudget !== "number" || !(args.tokenBudget > 0))) throw invalid("tokenBudget must be a positive number");
				return (await this.#sessionOp("session.goal", a)) as Ops["session.goal"]["d"];
			},

			"session.todos.set": async (_c, a) => {
				if (!Array.isArray(obj(a).phases)) throw invalid("phases must be an array");
				return (await this.#sessionOp("session.todos.set", a)) as Ops["session.todos.set"]["d"];
			},

			"session.fork": async (_c, a) => {
				const args = obj(a);
				const b = this.#backend(args);
				if (!b.fork) throw unsupported("fork is not available for this session");
				if (args.entryId !== undefined && typeof args.entryId !== "string") throw invalid("entryId must be a string");
				const { sessionFile } = await b.fork(args.entryId);
				return d.launcher.openFile(sessionFile);
			},

			"subagent.cancel": async (_c, a) => {
				str(obj(a), "id", 256);
				return (await this.#sessionOp("subagent.cancel", a)) as Ops["subagent.cancel"]["d"];
			},

			"subagent.steer": async (_c, a) => {
				const args = obj(a);
				str(args, "id", 256);
				str(args, "message", 100_000);
				return (await this.#sessionOp("subagent.steer", a)) as Ops["subagent.steer"]["d"];
			},

			"upload.begin": async (c, a) => {
				const args = obj(a);
				return d.uploads.begin(c.did, {
					name: args.name as string, mime: args.mime as string, size: args.size as number,
					purpose: args.purpose as "image" | "file", sid: args.sid as string | undefined,
				});
			},

			"upload.chunk": (c, a) => {
				const args = obj(a);
				d.uploads.chunk(c.did, { uploadId: args.uploadId as string, i: args.i as number, d: args.d as string });
				return {};
			},

			"upload.end": async (c, a) => d.uploads.end(c.did, { uploadId: obj(a).uploadId as string }),

			"hosttool.result": (c, a) => {
				d.hostTools.handleResult(c.ch, obj(a) as unknown as Ops["hosttool.result"]["a"]);
				return {};
			},

			"live.connect": async (_c, a) => {
				const args = obj(a);
				if (typeof args.sdpOffer !== "string" || args.sdpOffer.length === 0 || args.sdpOffer.length > 64 * 1024) throw invalid("sdpOffer must be a string");
				return (await this.#sessionOp("live.connect", a)) as Ops["live.connect"]["d"];
			},

			"live.stop": async (_c, a) => (await this.#sessionOp("live.stop", a)) as Ops["live.stop"]["d"],

			"live.mute": async (_c, a) => {
				if (typeof obj(a).muted !== "boolean") throw invalid("muted must be a boolean");
				return (await this.#sessionOp("live.mute", a)) as Ops["live.mute"]["d"];
			},
		};
	}
}

/** Keeps a `res` under MAX_PLAINTEXT by dropping the oldest messages first. */
function fitMessages(messages: Message[], hasMore: boolean, budget: number): { messages: Message[]; hasMore: boolean } {
	let list = messages;
	let more = hasMore;
	while (list.length > 1 && byteLen(list) > budget) {
		list = list.slice(Math.ceil(list.length / 4));
		more = true;
	}
	return { messages: list, hasMore: more };
}

function fitSnapshot(s: SessionSnapshot): SessionSnapshot {
	if (byteLen(s) <= SNAPSHOT_BUDGET) return s;
	const rest = byteLen({ ...s, messages: [] });
	const fit = fitMessages(s.messages, s.hasMore, Math.max(40_000, SNAPSHOT_BUDGET - rest));
	return { ...s, messages: fit.messages, hasMore: fit.hasMore };
}

/** Cuts the big strings of an event that did not fit into one frame. */
function shrinkEvent(e: SessionEvent): SessionEvent {
	const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
	switch (e.k) {
		case "msg":
			return {
				...e,
				message: {
					...e.message,
					content: e.message.content.map(b => {
						if (b.type === "text") return { ...b, text: cut(b.text, 8192), truncated: true };
						if (b.type === "thinking") return { ...b, thinking: cut(b.thinking, 4096), truncated: true };
						if (b.type === "toolCall") return { ...b, arguments: { note: "arguments omitted (too large)" } };
						return b;
					}),
				},
			};
		case "tool.update":
		case "tool.end":
			return { ...e, output: cut(e.output, 8192), truncated: true };
		case "tool.start":
			return { ...e, args: { note: "arguments omitted (too large)" } };
		default:
			return e;
	}
}
