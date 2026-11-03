/**
 * The `ompr run` daemon: embedded relay(s), relay host connections, secure channels, dispatcher,
 * sessions, TUI discovery, push, sleep inhibition, and the local control socket used by the CLI.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { PROTO, type HostInfo } from "../../protocol/src/index.ts";
import { startRelay, type RunningRelay } from "../../relay/src/node.ts";
import { AttentionInbox } from "./attention.ts";
import { Channel, NonceCache, newPeerCounters, type PeerCounters } from "./channel.ts";
import { paths, type Config } from "./config.ts";
import { DeviceStore } from "./devices.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HostToolRouter } from "./hosttools.ts";
import { loadOrCreateIdentity, type Identity } from "./identity.ts";
import { SleepInhibitor } from "./inhibit.ts";
import { SessionLauncher } from "./launcher.ts";
import { createBlobStore, type CountingBlobStore } from "./normalize/blobs.ts";
import { PairingManager, type PairSession } from "./pairing.ts";
import { PushSender } from "./push.ts";
import { RelayConnection } from "./relay-client.ts";
import { assertPrivateDir, ensurePrivateDir, resolveRoots } from "./safefs.ts";
import { SessionRegistry } from "./sessions.ts";
import { TuiDiscovery } from "./tui/index.ts";
import { UploadManager } from "./uploads.ts";

export const BRIDGE_VERSION = "0.1.0";

export interface DaemonOptions {
	dir: string;
	config: Config;
	log?: (m: string) => void;
}

/** First non-internal private IPv4 address, preferring 192.168/10/172.16-31. */
export function detectLanAddress(): string | undefined {
	const cands: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) cands.push(i.address);
	}
	const priv = cands.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
	return priv ?? cands[0];
}

function ompVersion(bin: string): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
		resolve(err ? null : (/(\d+\.\d+\.\d+[\w.-]*)/.exec(String(stdout))?.[1] ?? null));
	});
	return promise;
}

type CtlRequest = { cmd: string; [k: string]: unknown };

export class BridgeDaemon {
	readonly dir: string;
	readonly config: Config;
	readonly log: (m: string) => void;
	identity!: Identity;
	devices!: DeviceStore;
	inbox!: AttentionInbox;
	registry!: SessionRegistry;
	pairing!: PairingManager;
	dispatcher!: Dispatcher;
	push!: PushSender;

	readonly #startedAt = Date.now();
	readonly #channels = new Map<string, Channel>();
	/** Shared by every channel: a HELLO nonce is accepted once. */
	readonly #nonces = new NonceCache();
	readonly #relays: RelayConnection[] = [];
	readonly #embedded: RunningRelay[] = [];
	#roots: string[] = [];
	#ompVersion: string | null = null;
	#ctl: Server | undefined;
	#tick: NodeJS.Timeout | undefined;
	#discovery: { stop(): Promise<void> } | undefined;
	#uploads: UploadManager | undefined;
	#hostTools!: HostToolRouter;
	#stopped = false;

	constructor(o: DaemonOptions) {
		this.dir = o.dir;
		this.config = o.config;
		this.log = o.log ?? ((m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`));
	}

	get relayUrlsForPairing(): string[] {
		const out: string[] = [];
		if (this.config.lan) {
			const ip = this.config.lanAddress ?? detectLanAddress();
			if (ip) out.push(`ws://${ip}:${this.config.lanPort}`);
		}
		out.push(...this.config.relays);
		return out;
	}

	hostInfo(): HostInfo {
		return {
			proto: PROTO,
			hostId: this.identity.hostId,
			name: this.config.name,
			platform: process.platform,
			bridgeVersion: BRIDGE_VERSION,
			ompVersion: this.#ompVersion,
			roots: this.#roots,
			push: this.push.enabled,
			now: Date.now(),
		};
	}

	openChannels(): Channel[] {
		return [...this.#channels.values()].filter(c => c.isOpen);
	}

	async start(): Promise<void> {
		if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("refusing to run as root");
		const cfg = this.config;
		const p = paths(this.dir);
		ensurePrivateDir(this.dir);
		assertPrivateDir(this.dir);
		await this.#claimControlSocket();

		this.identity = loadOrCreateIdentity(this.dir);
		this.devices = new DeviceStore(this.dir);
		this.inbox = new AttentionInbox(this.dir);
		this.#roots = await resolveRoots(cfg.roots);
		if (this.#roots.length === 0) this.log("warning: none of the configured roots exist; the phone cannot browse or start sessions");
		this.#ompVersion = await ompVersion(cfg.omp.bin);
		if (!this.#ompVersion) this.log(`warning: could not run \`${cfg.omp.bin} --version\``);

		const blobs = createBlobStore();
		const inhibitor = new SleepInhibitor({ enabled: cfg.inhibitSleepWhileWorking, log: this.log });
		this.registry = new SessionRegistry({ inbox: this.inbox, inhibitor, log: this.log });
		this.push = new PushSender({ serviceAccountPath: cfg.fcm.serviceAccountPath, hostId: this.identity.hostId, log: this.log });
		this.#hostTools = new HostToolRouter({
			channels: () => this.openChannels(),
			sendHev: (ch, e) => this.dispatcher.sendHev(ch, e),
			log: this.log,
		});
		this.#uploads = new UploadManager({
			dir: p.uploads,
			blobs,
			roots: () => this.#roots,
			sessionCwd: sid => {
				const b = this.registry.get(sid);
				if (!b) throw new Error("no such session");
				return b.summary().cwd;
			},
		});
		const launcher = new SessionLauncher({
			config: cfg,
			registry: this.registry,
			uploads: this.#uploads,
			blobs,
			hostTools: this.#hostTools,
			roots: () => this.#roots,
			log: this.log,
			notice: (level, message) => this.dispatcher.broadcast({ k: "host.notice", level, message }),
		});
		this.dispatcher = new Dispatcher({
			config: cfg,
			devices: this.devices,
			registry: this.registry,
			inbox: this.inbox,
			blobs,
			uploads: this.#uploads,
			launcher,
			hostTools: this.#hostTools,
			hostInfo: () => this.hostInfo(),
			roots: () => this.#roots,
			channels: () => this.openChannels(),
			log: this.log,
		});
		this.pairing = new PairingManager({ identity: this.identity, devices: this.devices, hostName: cfg.name, log: this.log });

		this.devices.on("revoked", (did: string) => {
			// Deferred so the revoking device still receives its own `res`.
			setImmediate(() => {
				for (const ch of this.#channels.values()) if (ch.did === did) ch.close("device revoked");
			});
		});
		this.inbox.on("item", () => void this.#maybePush());

		this.#embedded.push(await startRelay({ port: cfg.localPort, host: "127.0.0.1", maxGuestsPerIp: 64 }));
		this.log(`embedded relay on 127.0.0.1:${cfg.localPort}`);
		const urls = [`ws://127.0.0.1:${cfg.localPort}`];
		if (cfg.lan) {
			this.#embedded.push(await startRelay({ port: cfg.lanPort, host: "0.0.0.0", maxGuestsPerIp: cfg.lanMaxGuestsPerIp }));
			this.log(`embedded LAN relay on 0.0.0.0:${cfg.lanPort}`);
			urls.push(`ws://127.0.0.1:${cfg.lanPort}`);
		}
		urls.push(...cfg.relays);
		urls.forEach((url, i) => this.#connectRelay(url, `r${i}`));

		this.#tick = setInterval(() => {
			for (const ch of [...this.#channels.values()]) ch.tick();
		}, 5000);
		this.#tick.unref();

		if (cfg.tui.enabled) await this.#startTui(blobs);
		await this.#listenControl();
		this.log(`ompr ready: host ${this.identity.hostId}, room ${this.identity.roomId.slice(0, 4)}…, ${this.devices.list().filter(d => !d.revoked).length} paired device(s)`);
	}

	async #startTui(blobs: CountingBlobStore): Promise<void> {
		try {
			const disc = new TuiDiscovery({ blobs, log: this.log, ompBin: this.config.omp.bin, control: this.config.tui.control });
			this.log(`TUI attach: ${this.config.tui.control ? "CONTROL links (phone can drive TUI sessions)" : "view-only (tui.control is false)"}`);
			disc.start(
				backend => this.registry.add(backend),
				sid => this.registry.remove(sid),
			);
			this.#discovery = disc;
		} catch (e) {
			this.log(`TUI discovery unavailable: ${(e as Error).message}`);
		}
	}

	// ───────────────────────────── relays and channels ─────────────────────────────

	#connectRelay(url: string, label: string): void {
		const conn = new RelayConnection({ url, roomId: this.identity.roomId, label, log: this.log });
		const key = (peer: number): string => `${label}#${peer}`;
		// Failure counters live as long as this relay connection, independent of Channel objects, so a peer that was
		// blocked stays blocked when its channel is dropped and re-created.
		const counters = new Map<number, PeerCounters>();
		const countersFor = (peer: number): PeerCounters => {
			let c = counters.get(peer);
			if (!c) {
				if (counters.size >= 8192) {
					for (const [id, x] of counters) {
						if (!x.blocked) {
							counters.delete(id);
							break;
						}
					}
					if (counters.size >= 8192) counters.delete(counters.keys().next().value!);
				}
				c = newPeerCounters();
				counters.set(peer, c);
			}
			return c;
		};
		const closeAll = (reason: string): void => {
			for (const [k, ch] of this.#channels) if (k.startsWith(`${label}#`)) ch.close(reason);
		};
		const resetPeers = (): void => counters.clear();
		const ensure = (peer: number): Channel => {
			let ch = this.#channels.get(key(peer));
			if (ch) return ch;
			ch = new Channel({
				id: key(peer),
				devices: this.devices,
				hostInfo: () => this.hostInfo(),
				send: payload => {
					conn.send(peer, payload);
				},
				onPair: payload => this.pairing.handle(payload),
				nonces: this.#nonces,
				counters: countersFor(peer),
				onOpen: c => {
					this.log(`device ${c.did} connected (${c.label || "unnamed"}) via ${label}`);
					this.#hostTools.channelsChanged();
				},
				onMessage: (c, msg) => {
					if (msg.t === "req") void this.dispatcher.onRequest(c, msg);
				},
				onClosed: (c, reason) => {
					if (this.#channels.get(key(peer)) === c) this.#channels.delete(key(peer));
					this.dispatcher.onChannelClosed(c);
					this.#hostTools.channelsChanged();
					this.log(`channel ${c.id} closed: ${reason}`);
				},
				log: this.log,
			});
			this.#channels.set(key(peer), ch);
			return ch;
		};
		conn.on("peer-joined", (peer: number) => {
			this.#channels.get(key(peer))?.close("peer id reused");
			if (!countersFor(peer).blocked) ensure(peer);
		});
		conn.on("peer-left", (peer: number) => {
			this.#channels.get(key(peer))?.close("peer left");
			if (counters.get(peer)?.blocked !== true) counters.delete(peer);
		});
		conn.on("frame", (peer: number, payload: Buffer) => {
			if (countersFor(peer).blocked) return; // no work at all for a blocked peer
			ensure(peer).receive(payload);
		});
		conn.on("close", () => {
			closeAll("relay connection lost");
			resetPeers();
		});
		conn.on("room-closed", () => {
			closeAll("room closed");
			resetPeers();
		});
		this.#relays.push(conn);
		conn.start();
	}

	/** Content-free FCM wake, only when nobody is connected. */
	async #maybePush(): Promise<void> {
		if (!this.push.enabled || this.openChannels().length > 0) return;
		const targets = this.devices.list().flatMap(d => (!d.revoked && d.push ? [{ did: d.did, token: d.push.token }] : []));
		if (targets.length === 0) return;
		try {
			const r = await this.push.send(targets);
			for (const did of r.dead) this.devices.clearPush(did);
		} catch (e) {
			this.log(`push failed: ${(e as Error).message}`);
		}
	}

	// ───────────────────────────── control socket ─────────────────────────────

	async #claimControlSocket(): Promise<void> {
		const sock = paths(this.dir).ctl;
		if (!existsSync(sock)) return;
		const alive = await new Promise<boolean>(res => {
			const c = createConnection(sock);
			c.once("connect", () => {
				c.destroy();
				res(true);
			});
			c.once("error", () => res(false));
		});
		if (alive) throw new Error(`another ompr daemon is already running (${sock})`);
		unlinkSync(sock);
	}

	async #listenControl(): Promise<void> {
		const sock = paths(this.dir).ctl;
		const server = createServer(c => this.#onControl(c));
		this.#ctl = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("error", reject);
		// Create the socket file with 0600 from the start (umask), then chmod explicitly and verify.
		const oldMask = process.umask(0o177);
		try {
			server.listen(sock, () => resolve());
			await promise;
		} finally {
			process.umask(oldMask);
		}
		server.off("error", reject);
		chmodSync(sock, 0o600);
	}

	#onControl(c: Socket): void {
		c.setEncoding("utf8");
		let buf = "";
		let pairSession: PairSession | undefined;
		let answer: ((ok: boolean) => void) | undefined;
		const send = (o: unknown): void => {
			if (!c.destroyed) c.write(`${JSON.stringify(o)}\n`);
		};
		c.on("error", () => {});
		c.on("close", () => {
			pairSession?.cancel();
			answer?.(false);
		});
		c.on("data", chunk => {
			buf += chunk;
			if (buf.length > 64 * 1024) {
				c.destroy();
				return;
			}
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				let msg: unknown;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof msg !== "object" || msg === null) continue;
				const m = msg as CtlRequest;
				if (m.t === "answer") {
					answer?.(m.ok === true);
					continue;
				}
				void this.#control(m, send, session => (pairSession = session), fn => (answer = fn));
			}
		});
	}

	async #control(
		m: CtlRequest,
		send: (o: unknown) => void,
		setSession: (s: PairSession) => void,
		setAnswer: (fn: ((ok: boolean) => void) | undefined) => void,
	): Promise<void> {
		try {
			switch (m.cmd) {
				case "status":
					send({ t: "result", d: this.status() });
					return;
				case "devices":
					send({ t: "result", d: this.devices.list().map(d => ({ did: d.did, label: d.label, createdAt: d.createdAt, lastSeen: d.lastSeen, revoked: d.revoked, push: d.push !== undefined, connected: this.openChannels().some(c => c.did === d.did) })) });
					return;
				case "revoke": {
					const dev = typeof m.did === "string" ? this.devices.resolve(m.did) : undefined;
					if (!dev) throw new Error("no such device");
					const ok = this.devices.revoke(dev.did);
					send({ t: "result", d: { did: dev.did, revoked: ok } });
					return;
				}
				case "pair": {
					const relays = this.relayUrlsForPairing;
					if (relays.length === 0) throw new Error("no relay is reachable from a phone: set `relays` (WAN) or `lan: true` in config.json");
					const confirm = m.confirm !== false;
					if (!confirm) this.log("WARNING: pairing started with --no-confirm: whoever has the link can pair a device without any check");
					const session = this.pairing.begin({
						relays,
						confirm: confirm
							? (label, sas) => {
									const { promise, resolve } = Promise.withResolvers<boolean>();
									setAnswer(resolve);
									send({ t: "confirm", label, sas });
									return promise;
								}
							: undefined,
						onPaired: dev => send({ t: "paired", did: dev.did, label: dev.label }),
						onDenied: reason => send({ t: "denied", reason }),
					});
					setSession(session);
					send({ t: "link", link: session.link, expiresAt: session.expiresAt });
					return;
				}
				default:
					throw new Error(`unknown command ${String(m.cmd).slice(0, 32)}`);
			}
		} catch (e) {
			send({ t: "error", message: (e as Error).message });
		}
	}

	status(): Record<string, unknown> {
		return {
			hostId: this.identity.hostId,
			name: this.config.name,
			version: BRIDGE_VERSION,
			ompVersion: this.#ompVersion,
			uptimeSec: Math.round((Date.now() - this.#startedAt) / 1000),
			relays: this.#relays.map(r => ({ url: r.url, connected: r.connected })),
			connected: this.openChannels().map(c => ({ did: c.did, label: c.label, since: c.connectedAt })),
			devices: this.devices.list().filter(d => !d.revoked).length,
			sessions: this.registry.list().map(s => ({ sid: s.sid, kind: s.kind, status: s.status, title: s.title, cwd: s.cwd })),
			push: this.push.enabled,
			lan: this.config.lan,
			tuiControl: this.config.tui.enabled ? (this.config.tui.control ? "control" : "view-only") : "off",
			allowedApprovalModes: this.config.allowedApprovalModes,
			pairingRelays: this.relayUrlsForPairing,
		};
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		clearInterval(this.#tick);
		const sock = paths(this.dir).ctl;
		this.#ctl?.close();
		try {
			unlinkSync(sock);
		} catch {
			// already gone
		}
		await this.#discovery?.stop().catch(() => {});
		await this.registry?.closeAll();
		await this.#uploads?.closeAll();
		for (const ch of this.#channels.values()) ch.close("shutdown");
		for (const r of this.#relays) r.stop();
		await Promise.all(this.#embedded.map(r => r.close().catch(() => {})));
		this.inbox?.flush();
		this.devices?.flush();
	}
}

/** Client side of the control socket. Resolves null when no daemon is listening. */
export function connectControl(dir: string): Promise<Socket | null> {
	const { promise, resolve } = Promise.withResolvers<Socket | null>();
	const c = createConnection(paths(dir).ctl);
	c.once("connect", () => {
		c.off("error", onErr);
		resolve(c);
	});
	const onErr = (): void => resolve(null);
	c.once("error", onErr);
	return promise;
}
