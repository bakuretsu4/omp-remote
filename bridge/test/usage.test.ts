import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { OpError } from "../src/errors.ts";
import { UsageService, normaliseUsage, probeUsage } from "../src/usage.ts";

const FAKE = fileURLToPath(new URL("../fixtures/fake-omp.mjs", import.meta.url));
const SAMPLE = JSON.parse(readFileSync(new URL("../fixtures/usage.sample.json", import.meta.url), "utf8"));
chmodSync(FAKE, 0o755);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ompr-usage-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A stand-in `omp` that appends one line per `usage --json` run to a counter file, then runs `body`. */
function script(name: string, body: string): { bin: string; runs: () => number } {
	const bin = join(tmp, name);
	const counter = join(tmp, `${name}.count`);
	writeFileSync(counter, "");
	writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(counter)}, "x\\n");\n${body}\n`);
	chmodSync(bin, 0o755);
	return { bin, runs: () => readFileSync(counter, "utf8").split("\n").length - 1 };
}

const rejects = async (p: Promise<unknown>, code: string, msg: RegExp): Promise<OpError> => {
	const e = await p.then(() => assert.fail("expected rejection"), (x: unknown) => x);
	assert.ok(e instanceof OpError, `OpError, got ${String(e)}`);
	assert.equal(e.code, code);
	assert.match(e.message, msg);
	return e;
};

describe("normaliseUsage", () => {
	const res = normaliseUsage(SAMPLE, 5);

	it("maps reports and accounts without usage to accounts", () => {
		assert.equal(res.generatedAt, SAMPLE.generatedAt);
		assert.deepEqual(res.accounts.map(a => [a.provider, a.email, a.org, a.limits.length]), [
			["anthropic", "demo-one@example.invalid", "Demo Org One", 3],
			["openai-codex", "demo-two@example.invalid", undefined, 1],
			["anthropic", "demo-three@example.invalid", "Demo Org Three", 0],
		]);
	});

	it("takes fraction, status and reset from the amount/status/window fields", () => {
		const [five, seven, extra] = res.accounts[0].limits;
		assert.deepEqual(five, { id: "anthropic:5h", label: "Claude 5 Hour", status: "ok", usedFraction: 0, resetsAt: null });
		assert.deepEqual(seven, { id: "anthropic:7d", label: "Claude 7 Day", status: "warning", usedFraction: 0.96, resetsAt: 1790100000000 });
		// no status, no limit to divide by: unknown rather than invented
		assert.deepEqual(extra, { id: "anthropic:extra", label: "Extra usage", status: "unknown", usedFraction: null, resetsAt: null });
	});

	it("derives the fraction from used/limit and clamps out-of-range values", () => {
		const doc = {
			reports: [{ provider: "p", limits: [
				{ id: "a", amount: { used: 30, limit: 40 } },
				{ id: "b", amount: { usedFraction: 1.7 } },
				{ id: "c", amount: { usedFraction: -2 } },
				{ id: "d", amount: { used: 5, limit: 0 } },
				{ id: "e", amount: { usedFraction: "0.5" } },
			] }],
		};
		assert.deepEqual(normaliseUsage(doc, 1).accounts[0].limits.map(l => l.usedFraction), [0.75, 1, 0, null, null]);
	});

	it("skips malformed entries instead of throwing, and rejects a non-object document", () => {
		const doc = { reports: [null, 3, { limits: [] }, { provider: "p", limits: [7, { label: "x" }] }], accountsWithoutUsage: ["s", { type: "oauth" }] };
		const out = normaliseUsage(doc, 9);
		assert.equal(out.generatedAt, 9);
		assert.deepEqual(out.accounts, [{ provider: "p", limits: [{ id: "p:1", label: "x", status: "unknown", usedFraction: null, resetsAt: null }] }]);
		assert.throws(() => normaliseUsage([], 1), OpError);
	});
});

describe("UsageService", () => {
	const doc = JSON.stringify(SAMPLE);

	it("coalesces concurrent calls and caches for the cache window, then refreshes", async () => {
		const s = script("ok", `process.stdout.write(${JSON.stringify(doc)});`);
		let t = 1000;
		const svc = new UsageService({ bin: s.bin, cacheMs: 60_000, now: () => t });
		const [a, b, c] = await Promise.all([svc.get(), svc.get(), svc.get()]);
		assert.equal(s.runs(), 1);
		assert.equal(a, b);
		assert.equal(b, c);
		t += 59_000;
		assert.equal(await svc.get(), a);
		assert.equal(s.runs(), 1);
		t += 2_000;
		await svc.get();
		assert.equal(s.runs(), 2);
	});

	it("does not cache failures: the next call runs omp again", async () => {
		const s = script("flaky", `process.stderr.write("boom\\n"); process.exit(2);`);
		const svc = new UsageService({ bin: s.bin });
		await rejects(svc.get(), "internal", /omp usage failed \(exit 2\): boom/);
		await rejects(svc.get(), "internal", /exit 2/);
		assert.equal(s.runs(), 2);
	});

	it("reports a missing binary, bad JSON and a timeout as readable errors", async () => {
		await rejects(new UsageService({ bin: join(tmp, "nope") }).get(), "unsupported", /omp binary could not be run/);
		const junk = script("junk", `process.stdout.write("this is not json");`);
		await rejects(new UsageService({ bin: junk.bin }).get(), "internal", /not return valid JSON/);
		// A real child that never answers: the timeout path can only be exercised against the real clock.
		const hang = script("hang", `setTimeout(() => {}, 60000);`);
		await rejects(new UsageService({ bin: hang.bin, timeoutMs: 300 }).get(), "timeout", /did not finish/);
	});

	it("works against the fake omp fixture end to end", async () => {
		const out = await new UsageService({ bin: FAKE }).get();
		assert.equal(out.accounts.length, 3);
	});
});

describe("probeUsage", () => {
	it("is true only when `omp usage --help` exits 0", async () => {
		assert.equal(await probeUsage(FAKE), true);
		assert.equal(await probeUsage(join(tmp, "missing")), false);
		const old = script("old", `process.stderr.write("unknown command"); process.exit(1);`);
		assert.equal(await probeUsage(old.bin), false);
	});
});
