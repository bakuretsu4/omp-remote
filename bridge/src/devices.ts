/** Paired-device store (devices.json, 0600). `K_dev` is the root of trust: revoking wipes it. */
import { EventEmitter } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { isRecord } from "./guards.ts";
import { paths } from "./config.ts";
import { readJsonIfExists, writePrivateFile } from "./safefs.ts";

/** How to wake a phone: an FCM token, or a UnifiedPush endpoint URL (see unifiedpush.ts). */
export type PushRegistration = { provider: "fcm"; token: string } | { provider: "unifiedpush"; endpoint: string };

/** The secret part of a registration: what the phone registered and what other devices must not share. */
export const pushKey = (p: PushRegistration): string => (p.provider === "fcm" ? p.token : p.endpoint);

export interface Device {
	did: string;
	label: string;
	dpk: string;
	/** base64url K_dev; empty string once revoked. */
	kDev: string;
	createdAt: number;
	lastSeen: number;
	revoked: boolean;
	revokedAt?: number;
	push?: PushRegistration;
}

const SAVE_DEBOUNCE_MS = 2000;

function parseDevice(raw: unknown): Device | null {
	if (!isRecord(raw)) return null;
	const { did, label, dpk, kDev, createdAt, lastSeen, revoked } = raw;
	if (typeof did !== "string" || typeof label !== "string" || typeof dpk !== "string" || typeof kDev !== "string") return null;
	if (typeof revoked !== "boolean" || typeof createdAt !== "number" || typeof lastSeen !== "number") return null;
	const d: Device = { did, label, dpk, kDev, createdAt, lastSeen, revoked };
	if (typeof raw.revokedAt === "number") d.revokedAt = raw.revokedAt;
	const p = raw.push;
	if (isRecord(p) && p.provider === "fcm" && typeof p.token === "string") d.push = { provider: "fcm", token: p.token };
	else if (isRecord(p) && p.provider === "unifiedpush" && typeof p.endpoint === "string") d.push = { provider: "unifiedpush", endpoint: p.endpoint };
	return d;
}

/** Emits `revoked(did)` synchronously when a device is revoked. */
export class DeviceStore extends EventEmitter {
	readonly #file: string;
	readonly #devices = new Map<string, Device>();
	#timer: NodeJS.Timeout | undefined;

	constructor(dir: string) {
		super();
		this.#file = paths(dir).devices;
		const raw = readJsonIfExists(this.#file);
		if (raw === undefined) return;
		if (!isRecord(raw) || !Array.isArray(raw.devices)) throw new Error("devices.json is malformed");
		for (const r of raw.devices) {
			const d = parseDevice(r);
			if (d) this.#devices.set(d.did, d);
		}
	}

	list(): Device[] {
		return [...this.#devices.values()];
	}

	/** Active (non-revoked) device by id. */
	get(did: string): Device | undefined {
		const d = this.#devices.get(did);
		return d && !d.revoked ? d : undefined;
	}

	add(d: Omit<Device, "lastSeen" | "revoked" | "createdAt"> & { createdAt?: number }): Device {
		const now = Date.now();
		const dev: Device = { ...d, createdAt: d.createdAt ?? now, lastSeen: now, revoked: false };
		this.#devices.set(dev.did, dev);
		this.#saveNow();
		return dev;
	}

	/**
	 * Revokes immediately in memory (fail closed), then persists. Returns false when unknown or already revoked.
	 * If the write fails the device STAYS revoked in memory, `revoked` is still emitted, and the error is thrown
	 * so the caller can tell the user the revocation will not survive a restart.
	 */
	revoke(did: string): boolean {
		const d = this.#devices.get(did);
		if (!d || d.revoked) return false;
		d.revoked = true;
		d.revokedAt = Date.now();
		d.kDev = "";
		delete d.push;
		let failure: unknown;
		try {
			this.#saveNow();
		} catch (e) {
			failure = e;
		}
		this.emit("revoked", did);
		if (failure) throw new Error(`device ${did} is revoked in memory but the change could not be saved (${(failure as Error).message}); it will be accepted again after a restart until the write succeeds`);
		return true;
	}

	touch(did: string): void {
		const d = this.#devices.get(did);
		if (!d || d.revoked) return;
		d.lastSeen = Date.now();
		this.#saveSoon();
	}

	setPush(did: string, push: PushRegistration): boolean {
		const d = this.get(did);
		if (!d) return false;
		d.push = push;
		this.#saveNow();
		return true;
	}

	/** Removes a device's registration; with `key` only when it is exactly that token or endpoint. */
	clearPush(did: string, key?: string): void {
		const d = this.#devices.get(did);
		if (!d?.push) return;
		if (key !== undefined && !constantTimeEqual(pushKey(d.push), key)) return;
		delete d.push;
		this.#saveNow();
	}

	/** Matches by exact id or unique prefix (CLI convenience). */
	resolve(idOrPrefix: string): Device | undefined {
		const exact = this.#devices.get(idOrPrefix);
		if (exact) return exact;
		const matches = this.list().filter(d => d.did.startsWith(idOrPrefix));
		return matches.length === 1 ? matches[0] : undefined;
	}

	flush(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#saveNow();
		}
	}

	#saveSoon(): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#saveNow();
		}, SAVE_DEBOUNCE_MS);
		this.#timer.unref();
	}

	#saveNow(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		writePrivateFile(this.#file, `${JSON.stringify({ v: 1, devices: this.list() }, null, 2)}\n`);
	}
}

export function constantTimeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
