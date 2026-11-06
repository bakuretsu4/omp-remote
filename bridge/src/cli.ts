#!/usr/bin/env node
/** `ompr` — OMP Remote bridge CLI (PROTOCOL.md §7). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { RelayConnection } from "./relay-client.ts";
import { connectControl, BridgeDaemon, BRIDGE_VERSION } from "./daemon.ts";
import { defaultConfig, loadConfig, omprHome, ompSessionsDir, parseConfig, paths, saveConfig, type Config } from "./config.ts";
import { DeviceStore } from "./devices.ts";
import { createIdentity, loadIdentity } from "./identity.ts";
import { loadServiceAccount } from "./push.ts";
import { auditStateModes, resolveRoots } from "./safefs.ts";
import { PeerSync } from "./sync.ts";

const USAGE = `ompr ${BRIDGE_VERSION} — control omp sessions from your phone

usage: ompr <command>
  init [--force] [--name <host name>] [--lan] [--relay <ws(s)://url>]...   create identity + config
  pair [--no-confirm]            print a pairing link + QR (valid 10 min, single use); needs \`ompr run\`
  devices                        list paired devices
  revoke <did>                   revoke a device immediately
  status                         daemon state
  run                            run the bridge daemon (embedded relay, sessions, TUI attach)
  install-service                write ~/.config/systemd/user/ompr.service
  sync                           mirror sessions + project folders with the configured \`peer\` now, then exit
  doctor                         check omp, relays, FCM, paths

State lives in $OMPR_HOME or ~/.config/ompr.`;

function refuseRoot(): void {
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		console.error("ompr refuses to run as root.");
		process.exit(1);
	}
}

function parseArgs(argv: string[]): { flags: Map<string, string[]>; rest: string[] } {
	const flags = new Map<string, string[]>();
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!a.startsWith("--")) {
			rest.push(a);
			continue;
		}
		const key = a.slice(2);
		const takesValue = key === "name" || key === "relay";
		const list = flags.get(key) ?? [];
		if (takesValue) {
			const v = argv[++i];
			if (v === undefined) fail(`--${key} needs a value`);
			list.push(v!);
		}
		flags.set(key, list);
	}
	return { flags, rest };
}

function fail(msg: string): never {
	console.error(`ompr: ${msg}`);
	process.exit(1);
}

function readConfig(dir: string): Config {
	try {
		return loadConfig(dir);
	} catch (e) {
		return fail((e as Error).message);
	}
}

async function cmdInit(dir: string, args: ReturnType<typeof parseArgs>): Promise<void> {
	const force = args.flags.has("force");
	if (loadIdentity(dir) && !force) {
		const id = loadIdentity(dir)!;
		console.log(`Already initialised: host ${id.hostId} (${dir}). Use --force to replace the identity (un-pairs every device).`);
	} else {
		const id = createIdentity(dir, force);
		console.log(`Created identity: host ${id.hostId}`);
	}
	const cfgPath = paths(dir).config;
	if (!existsSync(cfgPath) || force) {
		const cfg = defaultConfig();
		const name = args.flags.get("name")?.[0];
		if (name) cfg.name = name;
		if (args.flags.has("lan")) cfg.lan = true;
		cfg.relays = args.flags.get("relay") ?? [];
		try {
			saveConfig(parseConfig(cfg), dir);
		} catch (e) {
			fail((e as Error).message);
		}
		console.log(`Wrote ${cfgPath}`);
	}
	console.log("Next: edit config.json if needed (relays / lan), then `ompr run`, then `ompr pair`.");
}

async function cmdPair(dir: string, args: ReturnType<typeof parseArgs>): Promise<void> {
	const sock = await connectControl(dir);
	if (!sock) fail("the daemon is not running. Start it with `ompr run` (or the systemd service), then pair.");
	sock!.setEncoding("utf8");
	const noConfirm = args.flags.has("no-confirm");
	if (noConfirm) {
		console.error("\n!! WARNING: --no-confirm. ANYONE WHO SEES THE LINK/QR BELOW CAN PAIR A DEVICE and then run commands on this PC.");
		console.error("!! There is no code check. Use it only for tests; otherwise omit --no-confirm so you can compare the code on the phone.\n");
	}
	sock!.write(`${JSON.stringify({ cmd: "pair", confirm: !noConfirm })}\n`);
	const rl = createInterface({ input: sock! });
	let expires = 0;
	let exitCode = 1;
	const done = new Promise<void>(res => rl.once("close", res));
	rl.on("line", line => {
		let m: { t?: string; [k: string]: unknown };
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		switch (m.t) {
			case "link": {
				expires = Number(m.expiresAt);
				console.log("\nScan this with the OMP Remote app (or open the link on the phone):\n");
				qrcode.generate(String(m.link), { small: true });
				console.log(`\n${String(m.link)}\n`);
				console.log(`Valid until ${new Date(expires).toLocaleTimeString()}; single use. Waiting for the phone…`);
				break;
			}
			case "confirm": {
				const q = createInterface({ input: process.stdin, output: process.stdout });
				q.question(`Pair "${String(m.label)}" — code ${String(m.sas)} — it must match the code shown on the phone. [y/N] `, ans => {
					q.close();
					sock!.write(`${JSON.stringify({ t: "answer", ok: /^y(es)?$/i.test(ans.trim()) })}\n`);
				});
				break;
			}
			case "paired":
				console.log(`Paired "${String(m.label)}" (device ${String(m.did)}).`);
				exitCode = 0;
				sock!.end();
				break;
			case "denied":
				console.error(`Pairing ended: ${String(m.reason)}`);
				sock!.end();
				break;
			case "error":
				console.error(`ompr: ${String(m.message)}`);
				sock!.end();
				break;
			default:
				break;
		}
	});
	await done;
	process.exit(exitCode);
}

/** One request/response exchange with the daemon; null when it is not running. */
async function ctl(dir: string, req: Record<string, unknown>): Promise<unknown | null> {
	const sock = await connectControl(dir);
	if (!sock) return null;
	sock.setEncoding("utf8");
	sock.write(`${JSON.stringify(req)}\n`);
	const rl = createInterface({ input: sock });
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	rl.once("line", line => {
		try {
			const m = JSON.parse(line) as { t: string; d?: unknown; message?: string };
			if (m.t === "result") resolve(m.d);
			else reject(new Error(m.message ?? "daemon error"));
		} catch (e) {
			reject(e as Error);
		}
		sock.end();
	});
	rl.once("close", () => reject(new Error("daemon closed the connection")));
	return promise;
}

interface DeviceRow { did: string; label: string; createdAt: number; lastSeen: number; revoked: boolean; push: boolean; connected?: boolean }

async function cmdDevices(dir: string): Promise<void> {
	let rows = (await ctl(dir, { cmd: "devices" })) as DeviceRow[] | null;
	if (!rows) {
		rows = new DeviceStore(dir).list().map(d => ({ did: d.did, label: d.label, createdAt: d.createdAt, lastSeen: d.lastSeen, revoked: d.revoked, push: d.push !== undefined }));
	}
	if (rows.length === 0) {
		console.log("No paired devices. Run `ompr pair`.");
		return;
	}
	for (const d of rows) {
		const last = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never";
		// `add()` sets lastSeen = createdAt; the first authenticated connect moves it, so equality means the phone never connected.
		const unseen = !d.revoked && d.lastSeen <= d.createdAt;
		console.log(`${d.did}  ${d.label.padEnd(20)}  last seen ${last}${d.connected ? "  [connected]" : ""}${unseen ? "  [never connected: revoke it if the app does not list this PC]" : ""}${d.push ? "  [push]" : ""}${d.revoked ? "  [REVOKED]" : ""}`);
	}
}

async function cmdRevoke(dir: string, did: string | undefined): Promise<void> {
	if (!did) fail("usage: ompr revoke <did>");
	const live = (await ctl(dir, { cmd: "revoke", did })) as { did: string; revoked: boolean } | null;
	if (live) {
		console.log(live.revoked ? `Revoked ${live.did}.` : `${live.did} was already revoked.`);
		return;
	}
	const store = new DeviceStore(dir);
	const dev = store.resolve(did!);
	if (!dev) fail("no such device");
	console.log(store.revoke(dev!.did) ? `Revoked ${dev!.did} (the daemon is not running; it will refuse this device on start).` : `${dev!.did} was already revoked.`);
}

async function cmdStatus(dir: string): Promise<void> {
	const st = (await ctl(dir, { cmd: "status" })) as Record<string, unknown> | null;
	const id = loadIdentity(dir);
	if (!st) {
		console.log(`daemon: not running\nhost:   ${id ? id.hostId : "(not initialised; run `ompr init`)"}\ndevices: ${id ? new DeviceStore(dir).list().filter(d => !d.revoked).length : 0}`);
		return;
	}
	console.log(`daemon:  running (up ${st.uptimeSec}s, bridge ${st.version}, omp ${st.ompVersion ?? "unknown"})`);
	console.log(`host:    ${st.hostId} "${st.name}"`);
	for (const r of st.relays as { url: string; connected: boolean }[]) console.log(`relay:   ${r.connected ? "up  " : "DOWN"} ${r.url}`);
	console.log(`phones:  ${(st.connected as unknown[]).length} connected / ${st.devices} paired`);
	console.log(`push:    ${st.push ? "FCM configured" : "off"}`);
	console.log(`tui:     ${st.tuiControl === "control" ? "CONTROL (phone can drive live TUI sessions)" : st.tuiControl === "view-only" ? "view-only (tui.control=false)" : "off"}`);
	console.log(`approval modes the phone may use: ${(st.allowedApprovalModes as string[]).join(", ")}`);
	const sessions = st.sessions as { sid: string; kind: string; status: string; title: string }[];
	console.log(`sessions: ${sessions.length}`);
	for (const s of sessions) console.log(`  ${s.sid}  ${s.kind.padEnd(7)} ${s.status.padEnd(8)} ${s.title}`);
}

async function cmdRun(dir: string): Promise<void> {
	const config = readConfig(dir);
	const daemon = new BridgeDaemon({ dir, config });
	try {
		await daemon.start();
	} catch (e) {
		await daemon.stop().catch(() => {});
		fail((e as Error).message);
	}
	const shutdown = (sig: string): void => {
		daemon.log(`${sig}: shutting down`);
		const force = setTimeout(() => process.exit(1), 15_000);
		force.unref();
		void daemon.stop().then(() => process.exit(0));
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function cmdInstallService(): void {
	const cli = fileURLToPath(import.meta.url);
	const unitDir = join(homedir(), ".config", "systemd", "user");
	const unit = join(unitDir, "ompr.service");
	mkdirSync(unitDir, { recursive: true });
	const env = [`Environment=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`];
	if (process.env.OMPR_HOME) env.push(`Environment=OMPR_HOME=${process.env.OMPR_HOME}`);
	const q = (s: string): string => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
	writeFileSync(
		unit,
		`[Unit]
Description=OMP Remote bridge (ompr)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${q(process.execPath)} ${q(cli)} run
Restart=on-failure
RestartSec=3
${env.join("\n")}

[Install]
WantedBy=default.target
`,
		{ mode: 0o644 },
	);
	console.log(`Wrote ${unit}\n\nEnable and start it with:\n  systemctl --user daemon-reload && systemctl --user enable --now ompr.service\n\nTo keep it running without an open login session:\n  loginctl enable-linger $USER\n\nLogs: journalctl --user -u ompr.service -f`);
}

function run(bin: string, args: string[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(bin, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
	return promise;
}

async function checkRelay(url: string, roomId: string): Promise<string> {
	const http = url.replace(/^ws/, "http").replace(/\/+$/, "");
	try {
		const r = await fetch(`${http}/healthz`, { signal: AbortSignal.timeout(6000) });
		if (!r.ok) return `HTTP ${r.status} from /healthz`;
	} catch (e) {
		return `unreachable (${(e as Error).message})`;
	}
	// Host-side probe: can we take the room as host? (A running daemon already holds it → 4009 is fine.)
	const { promise, resolve } = Promise.withResolvers<string>();
	const c = new RelayConnection({ url, roomId, label: "doctor", log: () => {}, minDelayMs: 60_000, maxDelayMs: 60_000 });
	const t = setTimeout(() => resolve("healthz ok; host connect timed out"), 6000);
	c.once("open", () => {
		clearTimeout(t);
		resolve("ok");
	});
	c.start();
	const out = await promise;
	c.stop();
	return out;
}

async function cmdDoctor(dir: string): Promise<void> {
	let bad = 0;
	const line = (ok: boolean | "warn", what: string, detail: string): void => {
		if (ok === false) bad++;
		console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${what}: ${detail}`);
	};
	const cfg = readConfig(dir);
	const id = loadIdentity(dir);
	line(id !== null, "identity", id ? `host ${id.hostId}` : "missing; run `ompr init`");
	const ver = await run(cfg.omp.bin, ["--version"]);
	line(ver !== null, "omp", ver ?? `\`${cfg.omp.bin} --version\` failed (set omp.bin in config.json)`);
	for (const r of cfg.roots) line(existsSync(r.startsWith("~/") ? join(homedir(), r.slice(2)) : resolve(r)), "root", r);
	const running = (await ctl(dir, { cmd: "status" })) !== null;
	line(running ? true : "warn", "daemon", running ? "running" : "not running (`ompr run`)");
	if (id) {
		const urls = [...cfg.relays];
		if (urls.length === 0 && !cfg.lan) line("warn", "relays", "none configured and lan is off: a phone cannot reach this PC");
		for (const u of urls) {
			const r = await checkRelay(u, id.roomId);
			line(r === "ok", `relay ${u}`, r);
		}
	}
	if (cfg.fcm.serviceAccountPath) {
		try {
			const sa = loadServiceAccount(cfg.fcm.serviceAccountPath);
			line(true, "fcm", `service account for project ${sa.project_id}`);
		} catch (e) {
			line(false, "fcm", (e as Error).message);
		}
	} else {
		line("warn", "fcm", "not configured: no push wake-ups (set fcm.serviceAccountPath)");
	}
	line(cfg.allowedApprovalModes.includes("yolo") ? "warn" : true, "approval modes", `phone may use: ${cfg.allowedApprovalModes.join(", ")}${cfg.allowedApprovalModes.includes("yolo") ? " (yolo = no prompts at all!)" : ""}`);
	line(cfg.tui.enabled ? (cfg.tui.control ? "warn" : true) : true, "tui", !cfg.tui.enabled ? "disabled" : cfg.tui.control ? "CONTROL links: the phone can prompt/answer inside live TUI sessions" : "view-only (set tui.control=true to let the phone drive TUI sessions)");
	const p = paths(dir);
	for (const m of auditStateModes(dir, [
		{ path: p.identity, want: 0o600 }, { path: p.devices, want: 0o600 }, { path: p.config, want: 0o600 },
		{ path: p.attention, want: 0o600 }, { path: p.ctl, want: 0o600 },
	])) line(m.ok, "permissions", `${m.path}: ${m.detail}`);
	const inhibit = await run("systemd-inhibit", ["--version"]);
	line(inhibit !== null ? true : "warn", "systemd-inhibit", inhibit ? "available" : "missing: the PC may sleep mid-turn");
	if (bad > 0) process.exit(1);
}

async function cmdSync(dir: string): Promise<void> {
	const cfg = loadConfig(dir);
	if (!cfg.peer) {
		console.error('ompr: no peer configured; add {"peer": {"ssh": "<host>"}} to config.json');
		process.exit(1);
	}
	const roots = await resolveRoots(cfg.roots);
	const sessionsDir = ompSessionsDir(cfg);
	const sync = new PeerSync({
		peer: cfg.peer,
		localOmpBin: cfg.omp.bin,
		localSessionsDir: sessionsDir,
		localBlobsDir: join(dirname(sessionsDir), "blobs"),
		roots: () => roots,
		// No daemon registry in a one-shot run: `omp session lease` is what detects open terminals and managed sessions.
		liveSessionFiles: () => new Set(),
		log: m => console.log(m),
	});
	const r = await sync.syncNow();
	console.log(`sessions: pushed ${r.pushedSessions.length}, pulled ${r.pulledSessions.length}; projects: pushed ${r.pushedProjects.length}, pulled ${r.pulledProjects.length}; ${(r.durationMs / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
		console.log(USAGE);
		return;
	}
	if (cmd === "--version") {
		console.log(BRIDGE_VERSION);
		return;
	}
	refuseRoot();
	const dir = omprHome();
	const args = parseArgs(rest);
	switch (cmd) {
		case "init":
			return cmdInit(dir, args);
		case "pair":
			return cmdPair(dir, args);
		case "devices":
			return cmdDevices(dir);
		case "revoke":
			return cmdRevoke(dir, args.rest[0]);
		case "status":
			return cmdStatus(dir);
		case "run":
			return cmdRun(dir);
		case "install-service":
			return cmdInstallService();
		case "sync":
			return cmdSync(dir);
		case "doctor":
			return cmdDoctor(dir);
		default:
			console.error(`ompr: unknown command ${cmd}\n\n${USAGE}`);
			process.exit(2);
	}
}

main().catch(e => {
	console.error(`ompr: ${(e as Error).message}`);
	process.exit(1);
});
