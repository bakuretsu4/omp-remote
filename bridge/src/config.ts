import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ApprovalMode } from "../../protocol/src/index.ts";
import { ensurePrivateDir, readJsonIfExists, writePrivateFile } from "./safefs.ts";
import { isRecord } from "./guards.ts";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo"];

export interface Config {
	/** Display name shown in the app. */
	name: string;
	/** WAN relay base URLs (`wss://relay.example.com`). The embedded relay is always added. */
	relays: string[];
	/** Also listen on 0.0.0.0:<lanPort> and advertise `ws://<lan ip>:<lanPort>` in pairing links. */
	lan: boolean;
	localPort: number;
	lanPort: number;
	/** Overrides the detected LAN address advertised in pairing links. */
	lanAddress?: string;
	/** Directory trees the phone may browse and start sessions in. Default: `[$HOME]`. */
	roots: string[];
	omp: {
		bin: string;
		/** Where omp stores sessions (listing `recent`). Default `~/.omp/agent/sessions`. */
		sessionsDir?: string;
		/** Passed as `--session-dir` to every managed omp when set. */
		sessionDir?: string;
		/** Extra CLI args for every managed omp. */
		extraArgs: string[];
	};
	defaultApprovalMode: ApprovalMode;
	/** Approval modes the phone may select. `yolo` is OFF by default: add it here to allow it. */
	allowedApprovalModes: ApprovalMode[];
	inhibitSleepWhileWorking: boolean;
	fcm: { serviceAccountPath?: string };
	maxManagedSessions: number;
	/**
	 * Attach to live TUI sessions through the local relay (collab). `control:false` (default) joins with
	 * view-only links: TUI sessions are read-only (no prompting/answering from the phone).
	 */
	tui: { enabled: boolean; control: boolean };
	/** Concurrent guest sockets per client IP on the LAN relay (the loopback relay allows 64). */
	lanMaxGuestsPerIp: number;
}

export function defaultConfig(): Config {
	return {
		name: hostname(),
		relays: [],
		lan: false,
		localPort: 7466,
		lanPort: 7470,
		roots: [homedir()],
		omp: { bin: "omp", extraArgs: [] },
		defaultApprovalMode: "always-ask",
		allowedApprovalModes: ["always-ask", "always-ask-cached", "write"],
		inhibitSleepWhileWorking: true,
		fcm: {},
		maxManagedSessions: 16,
		tui: { enabled: true, control: false },
		lanMaxGuestsPerIp: 8,
	};
}

/** `$OMPR_HOME` or `~/.config/ompr`. */
export function omprHome(): string {
	const e = process.env.OMPR_HOME;
	return e && e.length ? e : join(homedir(), ".config", "ompr");
}

export const paths = (dir: string) => ({
	dir,
	config: join(dir, "config.json"),
	identity: join(dir, "identity.json"),
	devices: join(dir, "devices.json"),
	attention: join(dir, "attention.json"),
	ctl: join(dir, "ctl.sock"),
	uploads: join(dir, "uploads"),
	lock: join(dir, "daemon.pid"),
});

const bool = (v: unknown, d: boolean, key: string): boolean => {
	if (v === undefined) return d;
	if (typeof v !== "boolean") throw new Error(`config: ${key} must be a boolean`);
	return v;
};
const int = (v: unknown, d: number, key: string, min: number, max: number): number => {
	if (v === undefined) return d;
	if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`config: ${key} must be an integer in ${min}..${max}`);
	return v;
};
const strList = (v: unknown, d: string[], key: string): string[] => {
	if (v === undefined) return d;
	if (!Array.isArray(v) || !v.every(x => typeof x === "string" && x.length > 0)) throw new Error(`config: ${key} must be an array of non-empty strings`);
	return v as string[];
};
const optStr = (v: unknown, key: string): string | undefined => {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string" || v.length === 0) throw new Error(`config: ${key} must be a non-empty string`);
	return v;
};

function validateRelayUrl(u: string): string {
	let url: URL;
	try {
		url = new URL(u);
	} catch {
		throw new Error(`config: relay URL is not valid: ${u}`);
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`config: relay URL must be ws:// or wss://: ${u}`);
	if (url.search || url.hash) throw new Error(`config: relay URL must not carry a query or fragment: ${u}`);
	return u.replace(/\/+$/, "");
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
	for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`config: unknown key ${where}${k}`);
}

/** Parses and validates a config object (missing keys take defaults). */
export function parseConfig(raw: unknown): Config {
	const d = defaultConfig();
	if (raw === undefined) return d;
	if (!isRecord(raw)) throw new Error("config: top level must be an object");
	onlyKeys(raw, ["name", "relays", "lan", "localPort", "lanPort", "lanAddress", "roots", "omp", "defaultApprovalMode", "allowedApprovalModes", "inhibitSleepWhileWorking", "fcm", "maxManagedSessions", "tui", "lanMaxGuestsPerIp"], "");
	const omp = raw.omp === undefined ? {} : raw.omp;
	if (!isRecord(omp)) throw new Error("config: omp must be an object");
	const fcm = raw.fcm === undefined ? {} : raw.fcm;
	if (!isRecord(fcm)) throw new Error("config: fcm must be an object");
	const tui = raw.tui === undefined ? {} : raw.tui;
	if (!isRecord(tui)) throw new Error("config: tui must be an object");
	onlyKeys(omp, ["bin", "sessionsDir", "sessionDir", "extraArgs"], "omp.");
	onlyKeys(fcm, ["serviceAccountPath"], "fcm.");
	onlyKeys(tui, ["enabled", "control"], "tui.");
	const mode = raw.defaultApprovalMode ?? d.defaultApprovalMode;
	if (typeof mode !== "string" || !APPROVAL_MODES.includes(mode as ApprovalMode)) throw new Error(`config: defaultApprovalMode must be one of ${APPROVAL_MODES.join(", ")}`);
	const allowedRaw = strList(raw.allowedApprovalModes, d.allowedApprovalModes, "allowedApprovalModes");
	for (const m of allowedRaw) if (!APPROVAL_MODES.includes(m as ApprovalMode)) throw new Error(`config: allowedApprovalModes entry ${JSON.stringify(m)} is not one of ${APPROVAL_MODES.join(", ")}`);
	if (allowedRaw.length === 0) throw new Error("config: allowedApprovalModes must not be empty");
	const allowed = [...new Set(allowedRaw)] as ApprovalMode[];
	if (!allowed.includes(mode as ApprovalMode)) {
		throw new Error(`config: defaultApprovalMode ${JSON.stringify(mode)} is not in allowedApprovalModes (${allowed.join(", ")}); add it there to allow it`);
	}
	const extraArgs = strList(omp.extraArgs, [], "omp.extraArgs");
	for (const a of extraArgs) {
		if (/^--(yolo|auto-approve|approval-mode)(=|$)/.test(a)) throw new Error(`config: omp.extraArgs must not contain ${a}: the approval mode is chosen per session (see allowedApprovalModes)`);
	}
	const cfg: Config = {
		name: optStr(raw.name, "name") ?? d.name,
		relays: strList(raw.relays, d.relays, "relays").map(validateRelayUrl),
		lan: bool(raw.lan, d.lan, "lan"),
		localPort: int(raw.localPort, d.localPort, "localPort", 1, 65535),
		lanPort: int(raw.lanPort, d.lanPort, "lanPort", 1, 65535),
		roots: strList(raw.roots, d.roots, "roots"),
		omp: {
			bin: optStr(omp.bin, "omp.bin") ?? d.omp.bin,
			extraArgs,
		},
		defaultApprovalMode: mode as ApprovalMode,
		allowedApprovalModes: allowed,
		inhibitSleepWhileWorking: bool(raw.inhibitSleepWhileWorking, d.inhibitSleepWhileWorking, "inhibitSleepWhileWorking"),
		fcm: {},
		maxManagedSessions: int(raw.maxManagedSessions, d.maxManagedSessions, "maxManagedSessions", 1, 128),
		tui: { enabled: bool(tui.enabled, d.tui.enabled, "tui.enabled"), control: bool(tui.control, d.tui.control, "tui.control") },
		lanMaxGuestsPerIp: int(raw.lanMaxGuestsPerIp, d.lanMaxGuestsPerIp, "lanMaxGuestsPerIp", 1, 1024),
	};
	const lanAddress = optStr(raw.lanAddress, "lanAddress");
	if (lanAddress) cfg.lanAddress = lanAddress;
	const sessionsDir = optStr(omp.sessionsDir, "omp.sessionsDir");
	if (sessionsDir) cfg.omp.sessionsDir = sessionsDir;
	const sessionDir = optStr(omp.sessionDir, "omp.sessionDir");
	if (sessionDir) cfg.omp.sessionDir = sessionDir;
	const sa = optStr(fcm.serviceAccountPath, "fcm.serviceAccountPath");
	if (sa) cfg.fcm.serviceAccountPath = sa;
	return cfg;
}

export function loadConfig(dir: string = omprHome()): Config {
	return parseConfig(readJsonIfExists(paths(dir).config));
}

export function saveConfig(cfg: Config, dir: string = omprHome()): void {
	ensurePrivateDir(dir);
	writePrivateFile(paths(dir).config, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Where omp keeps sessions for `kind:"recent"` listing. */
export function ompSessionsDir(cfg: Config): string {
	if (cfg.omp.sessionsDir) return cfg.omp.sessionsDir.startsWith("~/") ? join(homedir(), cfg.omp.sessionsDir.slice(2)) : cfg.omp.sessionsDir;
	if (cfg.omp.sessionDir) return cfg.omp.sessionDir.startsWith("~/") ? join(homedir(), cfg.omp.sessionDir.slice(2)) : cfg.omp.sessionDir;
	return join(homedir(), ".omp", "agent", "sessions");
}
