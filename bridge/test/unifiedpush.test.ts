import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DeviceStore } from "../src/devices.ts";
import { OpError } from "../src/errors.ts";
import { registerPush } from "../src/push-register.ts";
import { MAX_ENDPOINT_LENGTH, UnifiedPushSender, endpointProblem, isNonPublicAddress } from "../src/unifiedpush.ts";

const tmp = mkdtempSync(join(tmpdir(), "ompr-up-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
describe("endpointProblem", () => {
	it("accepts a public https endpoint", () => {
		assert.equal(endpointProblem("https://ntfy.sh/upAbCdEf123"), null);
		assert.equal(endpointProblem("https://push.example.org:8443/topic?x=1"), null);
		assert.equal(endpointProblem("https://8.8.8.8/x"), null);
	});

	it("rejects anything but https, credentials, fragments, and junk", () => {
		for (const bad of ["http://ntfy.sh/x", "ftp://ntfy.sh/x", "https://user:pw@ntfy.sh/x", "https://ntfy.sh/x#frag", "ntfy.sh/x", "", "https://", "not a url"]) {
			assert.notEqual(endpointProblem(bad), null, bad);
		}
		for (const bad of [undefined, null, 5, {}, ["https://ntfy.sh/x"]]) assert.notEqual(endpointProblem(bad), null);
		assert.notEqual(endpointProblem(`https://ntfy.sh/${"a".repeat(MAX_ENDPOINT_LENGTH)}`), null);
	});

	it("rejects loopback, private, link-local and internal hosts so the bridge cannot be aimed at the LAN", () => {
		for (const host of [
			"localhost", "foo.localhost", "printer.local", "nas.internal", "box.lan",
			"127.0.0.1", "127.1.2.3", "10.0.0.5", "192.168.86.32", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0",
			"[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[::ffff:10.0.0.1]", "[::ffff:127.0.0.1]",
		]) {
			assert.notEqual(endpointProblem(`https://${host}/x`), null, host);
		}
	});

	it("does not mistake a public address that merely resembles a private range", () => {
		for (const ip of ["172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "192.169.0.1", "11.0.0.1", "2606:4700:4700::1111"]) {
			assert.equal(isNonPublicAddress(ip), false, ip);
		}
	});
});

function sender(over: { status?: number; throws?: boolean; resolves?: string[] } = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (over.throws) throw new Error("network down");
		return new Response(null, { status: over.status ?? 200 });
	}) as unknown as typeof fetch;
	const s = new UnifiedPushSender({ hostId: "HOST1", fetch: fetchFn, resolve: async () => over.resolves ?? ["93.184.216.34"] });
	return { s, calls };
}

describe("UnifiedPushSender", () => {
	it("POSTs a content-free wake and refuses redirects", async () => {
		const { s, calls } = sender();
		const r = await s.send([{ did: "d1", endpoint: "https://ntfy.sh/up1" }]);
		assert.deepEqual(r, { sent: 1, failed: 0, dead: [] });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://ntfy.sh/up1");
		assert.equal(calls[0]!.init.method, "POST");
		assert.equal(calls[0]!.init.redirect, "manual");
		assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { w: "1", h: "HOST1" });
	});

	it("maps responses: 404/410 mean the registration is gone, other failures are transient", async () => {
		for (const [status, want] of [[200, "sent"], [201, "sent"], [404, "dead"], [410, "dead"], [500, "failed"], [429, "failed"], [302, "failed"], [403, "failed"]] as const) {
			const { s } = sender({ status });
			const r = await s.send([{ did: "d", endpoint: "https://ntfy.sh/up" }]);
			const got = r.sent ? "sent" : r.dead.length ? "dead" : "failed";
			assert.equal(got, want, String(status));
		}
		const { s } = sender({ throws: true });
		assert.deepEqual(await s.send([{ did: "d", endpoint: "https://ntfy.sh/up" }]), { sent: 0, failed: 1, dead: [] });
	});

	it("does not call a host name that resolves to a private address (DNS pointing inward)", async () => {
		for (const bad of [["10.0.0.7"], ["93.184.216.34", "192.168.1.1"], ["::1"], []]) {
			const { s, calls } = sender({ resolves: bad });
			const r = await s.send([{ did: "d", endpoint: "https://evil.example.org/x" }]);
			assert.equal(calls.length, 0);
			assert.deepEqual(r, { sent: 0, failed: 1, dead: [] });
		}
	});

	it("drops a stored endpoint that would not be accepted today, without calling it", async () => {
		const { s, calls } = sender();
		const r = await s.send([{ did: "old", endpoint: "http://192.168.1.10/hook" }, { did: "ok", endpoint: "https://ntfy.sh/up" }]);
		assert.deepEqual(r.dead, ["old"]);
		assert.equal(r.sent, 1);
		assert.deepEqual(calls.map(c => c.url), ["https://ntfy.sh/up"]);
	});
});

function twoDevices() {
	const dir = mkdtempSync(join(tmp, "dev-"));
	const devices = new DeviceStore(dir);
	for (const did of ["A", "B"]) devices.add({ did, label: did, dpk: "x", kDev: "k" });
	return { dir, devices };
}

describe("registerPush", () => {
	it("stores a UnifiedPush endpoint and persists it", () => {
		const { dir, devices } = twoDevices();
		registerPush(devices, "A", { provider: "unifiedpush", endpoint: "https://ntfy.sh/upA" });
		assert.deepEqual(devices.get("A")!.push, { provider: "unifiedpush", endpoint: "https://ntfy.sh/upA" });
		assert.deepEqual(new DeviceStore(dir).get("A")!.push, { provider: "unifiedpush", endpoint: "https://ntfy.sh/upA" });
	});

	it("moves an endpoint or token to the newest device instead of waking two phones", () => {
		const { devices } = twoDevices();
		registerPush(devices, "A", { provider: "unifiedpush", endpoint: "https://ntfy.sh/same" });
		registerPush(devices, "B", { provider: "unifiedpush", endpoint: "https://ntfy.sh/same" });
		assert.equal(devices.get("A")!.push, undefined);
		assert.equal(devices.get("B")!.push?.provider, "unifiedpush");
		registerPush(devices, "A", { provider: "fcm", token: "tok" });
		registerPush(devices, "B", { provider: "fcm", token: "tok" });
		assert.equal(devices.get("A")!.push, undefined);
		assert.deepEqual(devices.get("B")!.push, { provider: "fcm", token: "tok" });
	});

	it("replaces a device's old registration and can clear it", () => {
		const { devices } = twoDevices();
		registerPush(devices, "A", { provider: "fcm", token: "t1" });
		registerPush(devices, "A", { provider: "unifiedpush", endpoint: "https://ntfy.sh/up" });
		assert.equal(devices.get("A")!.push?.provider, "unifiedpush");
		devices.clearPush("A");
		assert.equal(devices.get("A")!.push, undefined);
	});

	it("rejects bad input with an `invalid` error and stores nothing", () => {
		const { devices } = twoDevices();
		for (const bad of [
			{ provider: "unifiedpush", endpoint: "http://ntfy.sh/x" },
			{ provider: "unifiedpush", endpoint: "https://127.0.0.1/x" },
			{ provider: "unifiedpush" },
			{ provider: "fcm", token: "" },
			{ provider: "fcm", token: "x".repeat(4097) },
			{ provider: "apns", token: "x" },
			"nope",
			null,
		]) {
			assert.throws(() => registerPush(devices, "A", bad), (e: unknown) => e instanceof OpError && e.code === "invalid", JSON.stringify(bad));
		}
		assert.equal(devices.get("A")!.push, undefined);
	});

	it("still reads a devices.json written before UnifiedPush existed", () => {
		const dir = mkdtempSync(join(tmp, "legacy-"));
		const first = new DeviceStore(dir);
		first.add({ did: "L", label: "old phone", dpk: "x", kDev: "k" });
		first.setPush("L", { provider: "fcm", token: "legacy-token" });
		const file = join(dir, "devices.json");
		const raw = JSON.parse(readFileSync(file, "utf8")) as { devices: { push?: unknown }[] };
		assert.deepEqual(raw.devices[0]!.push, { provider: "fcm", token: "legacy-token" });
		writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
		assert.deepEqual(new DeviceStore(dir).get("L")!.push, { provider: "fcm", token: "legacy-token" });
	});
});
