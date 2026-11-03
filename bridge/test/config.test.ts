import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { b64u } from "../../protocol/src/crypto.ts";
import { defaultConfig, parseConfig } from "../src/config.ts";
import { DeviceStore } from "../src/devices.ts";
import { assertPrivateDir, auditStateModes, ensurePrivateDir } from "../src/safefs.ts";
import { cleanLabel } from "../src/sanitize.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-cfg-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("finding 2: allowedApprovalModes (yolo off by default)", () => {
	it("defaults exclude yolo", () => {
		assert.deepEqual(defaultConfig().allowedApprovalModes, ["always-ask", "always-ask-cached", "write"]);
		assert.deepEqual(parseConfig({}).allowedApprovalModes, ["always-ask", "always-ask-cached", "write"]);
	});
	it("rejects a defaultApprovalMode that is not allowed", () => {
		assert.throws(() => parseConfig({ defaultApprovalMode: "yolo" }), /not in allowedApprovalModes/);
		assert.throws(() => parseConfig({ allowedApprovalModes: ["write"], defaultApprovalMode: "always-ask" }), /not in allowedApprovalModes/);
	});
	it("yolo can be enabled explicitly", () => {
		const c = parseConfig({ allowedApprovalModes: ["always-ask", "yolo"], defaultApprovalMode: "yolo" });
		assert.ok(c.allowedApprovalModes.includes("yolo"));
	});
	it("rejects unknown/empty lists and approval flags smuggled through omp.extraArgs", () => {
		assert.throws(() => parseConfig({ allowedApprovalModes: ["nope"] }), /not one of/);
		assert.throws(() => parseConfig({ allowedApprovalModes: [] }), /must not be empty/);
		for (const a of ["--yolo", "--auto-approve", "--approval-mode", "--approval-mode=yolo"]) {
			assert.throws(() => parseConfig({ omp: { extraArgs: [a] } }), /must not contain/, a);
		}
	});
});

describe("finding 5: tui.control", () => {
	it("defaults to false", () => {
		assert.equal(defaultConfig().tui.control, false);
		assert.equal(parseConfig({ tui: { enabled: true } }).tui.control, false);
		assert.equal(parseConfig({ tui: { control: true } }).tui.control, true);
		assert.throws(() => parseConfig({ tui: { control: "yes" } }), /boolean/);
	});
});

describe("finding 6: lanMaxGuestsPerIp", () => {
	it("defaults to 8 and validates", () => {
		assert.equal(parseConfig({}).lanMaxGuestsPerIp, 8);
		assert.equal(parseConfig({ lanMaxGuestsPerIp: 3 }).lanMaxGuestsPerIp, 3);
		assert.throws(() => parseConfig({ lanMaxGuestsPerIp: 0 }), /integer/);
	});
});

describe("finding 14: cleanLabel", () => {
	it("strips controls, bidi and format characters, collapses whitespace, caps length", () => {
		assert.equal(cleanLabel("  a\u202Eb\u0000c\n\td\u200Be  "), "a b c d e");
		assert.equal(cleanLabel("\u202E\u2066"), "Phone");
		assert.equal(cleanLabel(42 as unknown), "Phone");
		assert.equal(cleanLabel("é".repeat(100)).length, 64);
		assert.equal(Array.from(cleanLabel("😀".repeat(100))).length, 64);
	});
});

describe("finding 11: private state directory", () => {
	it("ensurePrivateDir creates 0700 and tightens a loose directory", () => {
		const d = join(tmp, "loose");
		mkdirSync(d, { mode: 0o755 });
		chmodSync(d, 0o755);
		ensurePrivateDir(d);
		assertPrivateDir(d);
	});
	it("assertPrivateDir refuses loose modes and symlinks", () => {
		const d = join(tmp, "loose2");
		mkdirSync(d, { mode: 0o755 });
		chmodSync(d, 0o755);
		assert.throws(() => assertPrivateDir(d), /chmod 700/);
		const link = join(tmp, "link");
		symlinkSync(d, link);
		assert.throws(() => assertPrivateDir(link), /not a real directory/);
		assert.throws(() => ensurePrivateDir(link), /not a directory/);
	});
	it("auditStateModes reports wrong modes and ignores missing files", () => {
		const d = join(tmp, "audit");
		ensurePrivateDir(d);
		const f = join(d, "identity.json");
		writeFileSync(f, "{}", { mode: 0o644 });
		chmodSync(f, 0o644);
		const res = auditStateModes(d, [{ path: f, want: 0o600 }, { path: join(d, "nope"), want: 0o600 }]);
		assert.equal(res.length, 2);
		assert.equal(res[0]!.ok, true);
		assert.equal(res[1]!.ok, false);
		assert.match(res[1]!.detail, /mode 644/);
	});
});

describe("finding 15: DeviceStore.revoke persists before success, fails closed", () => {
	it("keeps the device revoked in memory and reports the error when the write fails", () => {
		const dir = join(tmp, "ro");
		const store = new DeviceStore(dir);
		store.add({ did: "d1", label: "x", dpk: "x", kDev: b64u(Buffer.alloc(32, 1)) });
		const events: string[] = [];
		store.on("revoked", (d: string) => events.push(d));
		const file = join(dir, "devices.json");
		const saved = readFileSync(file, "utf8");
		rmSync(file);
		mkdirSync(join(file, "blocker"), { recursive: true }); // the final rename onto devices.json now fails
		try {
			assert.throws(() => store.revoke("d1"), /revoked in memory but the change could not be saved/);
		} finally {
			rmSync(file, { recursive: true });
			writeFileSync(file, saved, { mode: 0o600 });
		}
		assert.equal(store.get("d1"), undefined, "fail closed: no longer accepted");
		assert.deepEqual(events, ["d1"], "live channels are still dropped");
		assert.equal(new DeviceStore(dir).get("d1")?.kDev.length, 43, "the on-disk state still has the key (the error told the user)");
	});
	it("a successful revoke is on disk before it returns", () => {
		const dir = join(tmp, "ok");
		const store = new DeviceStore(dir);
		store.add({ did: "d2", label: "x", dpk: "x", kDev: b64u(Buffer.alloc(32, 2)) });
		assert.equal(store.revoke("d2"), true);
		assert.equal(new DeviceStore(dir).get("d2"), undefined);
	});
});
