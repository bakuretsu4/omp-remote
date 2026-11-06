import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createServer } from "node:net";
import { BridgeDaemon } from "../src/daemon.ts";
import { createIdentity } from "../src/identity.ts";
import { Backup, isSnapshotName, previousSnapshot, snapshotName, snapshotsToPrune } from "../src/backup.ts";
import { parseConfig, saveConfig } from "../src/config.ts";

describe("snapshot naming and retention (pure)", () => {
	it("names snapshots by local calendar day, zero padded", () => {
		assert.equal(snapshotName(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
		assert.equal(snapshotName(new Date(2026, 10, 5, 0, 0)), "2026-11-05");
	});

	it("accepts only real YYYY-MM-DD dates", () => {
		for (const ok of ["2026-11-05", "2024-02-29", "1999-12-31"]) assert.equal(isSnapshotName(ok), true, ok);
		for (const bad of ["2026-13-01", "2026-02-30", "2025-02-29", "2026-11-5", "2026-11-05.bak", "x2026-11-05", "2026-11-05 ", "latest", "", "../2026-11-05"]) {
			assert.equal(isSnapshotName(bad), false, JSON.stringify(bad));
		}
	});

	it("link-dest base is the newest snapshot strictly older than today", () => {
		const names = ["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-09", "junk"];
		assert.equal(previousSnapshot(names, "2026-11-05"), "2026-11-03");
		assert.equal(previousSnapshot(names, "2026-11-01"), undefined);
		assert.equal(previousSnapshot([], "2026-11-05"), undefined);
	});

	it("prunes everything beyond the newest `keep`, never non-snapshot names, never the protected one", () => {
		const names = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "notes", "2026-11-03.bak", "2026-99-99"];
		assert.deepEqual(snapshotsToPrune(names, 2), ["2026-11-02", "2026-11-01"]);
		assert.deepEqual(snapshotsToPrune(names, 4), []);
		assert.deepEqual(snapshotsToPrune(names, 1, "2026-11-01"), ["2026-11-03", "2026-11-02"]);
		assert.deepEqual(snapshotsToPrune(["2026-11-01", "2026-11-01"], 1), []);
	});
});

describe("backup config", () => {
	it("defaults to hourly, keep 7", () => {
		assert.deepEqual(parseConfig({ backup: { dir: "/mnt/hdd/ompr" } }).backup, { dir: "/mnt/hdd/ompr", intervalSec: 3600, keep: 7 });
		assert.equal(parseConfig({}).backup, undefined);
	});

	it("rejects unknown keys, a missing dir and out-of-range numbers", () => {
		assert.throws(() => parseConfig({ backup: { dir: "/a", extra: 1 } }), /unknown key backup\.extra/);
		assert.throws(() => parseConfig({ backup: {} }), /backup\.dir is required/);
		assert.throws(() => parseConfig({ backup: { dir: "/a", keep: 0 } }), /backup\.keep/);
		assert.throws(() => parseConfig({ backup: { dir: "/a", keep: 366 } }), /backup\.keep/);
		assert.throws(() => parseConfig({ backup: { dir: "/a", intervalSec: -1 } }), /backup\.intervalSec/);
		assert.throws(() => parseConfig({ backup: { dir: "/a", intervalSec: 1.5 } }), /backup\.intervalSec/);
		assert.throws(() => parseConfig({ backup: "/a" }), /backup must be an object/);
		assert.equal(parseConfig({ backup: { dir: "/a", intervalSec: 0, keep: 365 } }).backup?.intervalSec, 0);
	});
});

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-backup-")));
let n = 0;

interface Fixture { sessions: string; blobs: string; dest: string; make(day: string, o?: { keep?: number }): Backup }

/** Fresh omp data + empty destination per test; `make` builds a Backup whose clock is the given day. */
function fixture(): Fixture {
	const base = join(tmp, `t${n++}`);
	const sessions = join(base, "agent", "sessions");
	const blobs = join(base, "agent", "blobs");
	const dest = join(base, "hdd");
	mkdirSync(join(sessions, "--proj--"), { recursive: true });
	mkdirSync(blobs, { recursive: true });
	mkdirSync(dest);
	writeFileSync(join(sessions, "--proj--", "a.jsonl"), '{"type":"session"}\n{"type":"message"}\n');
	writeFileSync(join(sessions, "--proj--", "b.jsonl"), '{"type":"session"}\n');
	writeFileSync(join(blobs, "img1"), "image-bytes");
	const make = (day: string, o: { keep?: number } = {}): Backup => {
		const [y, m, d] = day.split("-").map(Number) as [number, number, number];
		return new Backup({
			config: { dir: dest, intervalSec: 0, keep: o.keep ?? 7 },
			sessionsDir: sessions,
			blobsDir: blobs,
			log: () => {},
			now: () => new Date(y, m - 1, d, 12),
		});
	};
	return { sessions, blobs, dest, make };
}

const ino = (p: string): number => statSync(p).ino;

function tree(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string, rel: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
			else out.push(`${rel}${e.name}:${readFileSync(p, "utf8")}:${statSync(p).mtimeMs}`);
		}
	};
	walk(dir, "");
	return out.sort();
}

after(() => rmSync(tmp, { recursive: true, force: true }));

describe("Backup with real rsync", () => {
	it("writes <dir>/YYYY-MM-DD/{sessions,blobs} and leaves the source untouched", async () => {
		const f = fixture();
		const before = [tree(f.sessions), tree(f.blobs)];
		const r = await f.make("2026-11-05").runNow();
		assert.equal(r.ok, true, r.error);
		assert.equal(r.snapshot, "2026-11-05");
		assert.equal(readFileSync(join(f.dest, "2026-11-05", "sessions", "--proj--", "a.jsonl"), "utf8"), readFileSync(join(f.sessions, "--proj--", "a.jsonl"), "utf8"));
		assert.equal(readFileSync(join(f.dest, "2026-11-05", "blobs", "img1"), "utf8"), "image-bytes");
		assert.deepEqual([tree(f.sessions), tree(f.blobs)], before);
	});

	it("hard-links unchanged files to the previous snapshot and copies only what changed", async () => {
		const f = fixture();
		assert.equal((await f.make("2026-11-05").runNow()).ok, true);
		writeFileSync(join(f.sessions, "--proj--", "a.jsonl"), '{"type":"session"}\n{"type":"message"}\n{"type":"message2"}\n');
		writeFileSync(join(f.sessions, "--proj--", "c.jsonl"), "new\n");
		const r = await f.make("2026-11-06").runNow();
		assert.equal(r.ok, true, r.error);
		const d1 = join(f.dest, "2026-11-05");
		const d2 = join(f.dest, "2026-11-06");
		for (const rel of [join("sessions", "--proj--", "b.jsonl"), join("blobs", "img1")]) {
			assert.equal(ino(join(d1, rel)), ino(join(d2, rel)), `${rel} must be a hard link`);
			assert.equal(statSync(join(d2, rel)).nlink, 2);
		}
		const a1 = join(d1, "sessions", "--proj--", "a.jsonl");
		const a2 = join(d2, "sessions", "--proj--", "a.jsonl");
		assert.notEqual(ino(a1), ino(a2));
		assert.equal(readFileSync(a1, "utf8"), '{"type":"session"}\n{"type":"message"}\n', "the older snapshot keeps the older transcript");
		assert.match(readFileSync(a2, "utf8"), /message2/);
		assert.equal(readFileSync(join(d2, "sessions", "--proj--", "c.jsonl"), "utf8"), "new\n");
		assert.equal(existsSync(join(d1, "sessions", "--proj--", "c.jsonl")), false);
	});

	it("updates today's snapshot in place without touching yesterday's hard-linked data", async () => {
		const f = fixture();
		assert.equal((await f.make("2026-11-05").runNow()).ok, true);
		assert.equal((await f.make("2026-11-06").runNow()).ok, true);
		const grown = '{"type":"session"}\n{"type":"message"}\nmore\n';
		writeFileSync(join(f.sessions, "--proj--", "a.jsonl"), grown);
		assert.equal((await f.make("2026-11-06").runNow()).ok, true);
		assert.equal(readFileSync(join(f.dest, "2026-11-06", "sessions", "--proj--", "a.jsonl"), "utf8"), grown);
		assert.equal(readFileSync(join(f.dest, "2026-11-05", "sessions", "--proj--", "a.jsonl"), "utf8"), '{"type":"session"}\n{"type":"message"}\n');
		assert.deepEqual(readdirSync(f.dest).sort(), ["2026-11-05", "2026-11-06"]);
	});

	it("keeps files in a snapshot after they disappear from the source, and drops them from the next day's", async () => {
		const f = fixture();
		assert.equal((await f.make("2026-11-05").runNow()).ok, true);
		rmSync(join(f.sessions, "--proj--", "b.jsonl"));
		assert.equal((await f.make("2026-11-05").runNow()).ok, true);
		assert.equal(existsSync(join(f.dest, "2026-11-05", "sessions", "--proj--", "b.jsonl")), true);
		assert.equal((await f.make("2026-11-06").runNow()).ok, true);
		assert.equal(existsSync(join(f.dest, "2026-11-06", "sessions", "--proj--", "b.jsonl")), false);
	});

	it("prunes only YYYY-MM-DD folders beyond `keep` and nothing else in the destination", async () => {
		const f = fixture();
		for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) mkdirSync(join(f.dest, d));
		writeFileSync(join(f.dest, "2026-11-01", "marker"), "old");
		// Things that look similar but are not snapshots, plus a symlinked "snapshot" pointing outside.
		mkdirSync(join(f.dest, "2026-11-01.bak"));
		mkdirSync(join(f.dest, "photos"));
		writeFileSync(join(f.dest, "photos", "keep.jpg"), "x");
		writeFileSync(join(f.dest, "2026-10-01"), "a file named like a date");
		const outside = join(tmp, `outside-${n}`);
		mkdirSync(outside);
		writeFileSync(join(outside, "precious"), "p");
		symlinkSync(outside, join(f.dest, "2026-09-09"));
		const r = await f.make("2026-11-05", { keep: 2 }).runNow();
		assert.equal(r.ok, true, r.error);
		assert.deepEqual(r.pruned.sort(), ["2026-11-01", "2026-11-02"]);
		assert.deepEqual(readdirSync(f.dest).sort(), ["2026-09-09", "2026-10-01", "2026-11-01.bak", "2026-11-03", "2026-11-05", "photos"]);
		assert.equal(readFileSync(join(outside, "precious"), "utf8"), "p");
		assert.equal(lstatSync(join(f.dest, "2026-09-09")).isSymbolicLink(), true);
		assert.equal(readFileSync(join(f.dest, "photos", "keep.jpg"), "utf8"), "x");
	});

	it("pruning an old snapshot leaves the hard-linked files of the newer ones intact", async () => {
		const f = fixture();
		assert.equal((await f.make("2026-11-05", { keep: 1 }).runNow()).ok, true);
		const r = await f.make("2026-11-06", { keep: 1 }).runNow();
		assert.deepEqual(r.pruned, ["2026-11-05"]);
		assert.equal(readFileSync(join(f.dest, "2026-11-06", "sessions", "--proj--", "b.jsonl"), "utf8"), '{"type":"session"}\n');
		assert.equal(statSync(join(f.dest, "2026-11-06", "sessions", "--proj--", "b.jsonl")).nlink, 1);
	});

	it("does not need a blobs folder yet, but needs the sessions folder", async () => {
		const f = fixture();
		rmSync(f.blobs, { recursive: true });
		assert.equal((await f.make("2026-11-05").runNow()).ok, true);
		assert.equal(existsSync(join(f.dest, "2026-11-05", "blobs")), false);
		rmSync(f.sessions, { recursive: true });
		const r = await f.make("2026-11-06").runNow();
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /sessions folder does not exist/);
		assert.equal(existsSync(join(f.dest, "2026-11-06")), false, "no snapshot folder for a failed run");
	});

	it("reports a missing rsync as a one-line error, not a stack", async () => {
		const f = fixture();
		const b = new Backup({ config: { dir: f.dest, intervalSec: 0, keep: 7 }, sessionsDir: f.sessions, blobsDir: f.blobs, log: () => {}, rsyncBin: "/nonexistent/rsync" });
		const r = await b.runNow();
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /is not installed/);
		assert.doesNotMatch(r.error ?? "", /\n|\bat .*\.ts/);
	});

});

describe("Backup refusals", () => {
	const mk = (dir: string, sessions: string, blobs: string, log: (m: string) => void = () => {}): Backup =>
		new Backup({ config: { dir, intervalSec: 0, keep: 7 }, sessionsDir: sessions, blobsDir: blobs, log });

	it("refuses a relative path, logging once and disabling", async () => {
		const f = fixture();
		const logs: string[] = [];
		const b = mk("relative/dir", f.sessions, f.blobs, m => logs.push(m));
		await b.start();
		assert.match(b.disabledReason ?? "", /absolute/);
		assert.equal(logs.length, 1);
		b.notifyActivity(1);
		assert.equal((await b.runNow()).ok, false);
		assert.equal(logs.length, 1, "a disabled backup stays silent");
		assert.equal(existsSync(join(process.cwd(), "relative")), false);
	});

	it("refuses a missing directory and does not create it or its parents", async () => {
		const f = fixture();
		const missing = join(f.dest, "not", "there");
		const b = mk(missing, f.sessions, f.blobs);
		await b.start();
		assert.match(b.disabledReason ?? "", /does not exist/);
		assert.equal(existsSync(join(f.dest, "not")), false);
		assert.deepEqual(readdirSync(f.dest), []);
	});

	it("refuses a regular file", async () => {
		const f = fixture();
		const file = join(f.dest, "afile");
		writeFileSync(file, "x");
		const b = mk(file, f.sessions, f.blobs);
		await b.start();
		assert.match(b.disabledReason ?? "", /not a folder/);
	});

	it("refuses a directory that is not writable", async () => {
		const f = fixture();
		const ro = join(f.dest, "ro");
		mkdirSync(ro);
		chmodSync(ro, 0o500);
		try {
			const b = mk(ro, f.sessions, f.blobs);
			await b.start();
			assert.match(b.disabledReason ?? "", /not writable/);
			assert.deepEqual(readdirSync(ro), []);
		} finally {
			chmodSync(ro, 0o700);
		}
	});

	it("refuses a directory inside the sessions or blobs folder, also through a symlink", async () => {
		const f = fixture();
		const inside = join(f.sessions, "--proj--");
		const viaLink = join(f.dest, "link");
		symlinkSync(f.sessions, viaLink);
		for (const dir of [inside, f.sessions, f.blobs, viaLink]) {
			const b = mk(dir, f.sessions, f.blobs);
			await b.start();
			assert.match(b.disabledReason ?? "", /inside omp's data/, dir);
		}
		assert.deepEqual(readdirSync(inside).sort(), ["a.jsonl", "b.jsonl"], "nothing was written into the sessions folder");
	});

	it("refuses a directory that contains omp's data (a snapshot must not back itself up)", async () => {
		const f = fixture();
		const b = mk(join(f.sessions, ".."), f.sessions, f.blobs);
		await b.start();
		assert.match(b.disabledReason ?? "", /must not be inside backup\.dir/);
	});

	it("a destination that vanishes later (unmounted disk) fails the run without disabling or creating it", async () => {
		const f = fixture();
		const b = f.make("2026-11-05");
		await b.start();
		assert.equal(b.disabledReason, undefined);
		assert.equal((await b.runNow()).ok, true);
		rmSync(f.dest, { recursive: true });
		const r = await b.runNow();
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /does not exist/);
		assert.equal(existsSync(f.dest), false);
		assert.equal(b.disabledReason, undefined);
	});
});

async function freePort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const srv = createServer();
	srv.listen(0, "127.0.0.1", () => {
		const p = (srv.address() as { port: number }).port;
		srv.close(() => resolve(p));
	});
	return promise;
}

describe("Backup inside the daemon", () => {
	async function daemonWith(backupDir: string, f: Fixture): Promise<BridgeDaemon> {
		const home = join(tmp, `daemon-home-${n++}`);
		const cfg = parseConfig({
			name: "bk", localPort: await freePort(), roots: [tmp], tui: { enabled: false }, inhibitSleepWhileWorking: false,
			omp: { bin: process.execPath, sessionsDir: f.sessions },
			backup: { dir: backupDir, intervalSec: 0, keep: 3 },
		});
		createIdentity(home);
		saveConfig(cfg, home);
		const d = new BridgeDaemon({ dir: home, config: cfg, log: () => {} });
		await d.start();
		return d;
	}

	it("backs up at startup and reports the result in status", async () => {
		const f = fixture();
		const d = await daemonWith(f.dest, f);
		try {
			let last: { ok: boolean; snapshot?: string } | null = null;
			while (!last) {
				last = (d.status().backup as { last: { ok: boolean; snapshot?: string } | null }).last;
				await new Promise(r => setImmediate(r));
			}
			assert.equal(last.ok, true);
			assert.equal(last.snapshot, snapshotName(new Date()));
			assert.equal(existsSync(join(f.dest, snapshotName(new Date()), "sessions", "--proj--", "a.jsonl")), true);
		} finally {
			await d.stop();
		}
	});

	it("starts normally with a refused target and says why in status, creating nothing", async () => {
		const f = fixture();
		const missing = join(f.dest, "missing", "dir");
		const d = await daemonWith(missing, f);
		try {
			const st = d.status().backup as { disabled: string | null; last: unknown };
			assert.match(st.disabled ?? "", /does not exist/);
			assert.equal(st.last, null);
			assert.equal(existsSync(join(f.dest, "missing")), false);
		} finally {
			await d.stop();
		}
	});
});
