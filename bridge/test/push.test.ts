import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildFcmMessage,
	buildServiceAccountJwt,
	loadServiceAccount,
	PushSender,
} from "../src/push.ts";
import type { ServiceAccount } from "../src/push.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const sa: ServiceAccount = {
	client_email: "svc@proj.iam.gserviceaccount.com",
	private_key: privateKey,
	project_id: "proj-1",
};

const dir = mkdtempSync(join(tmpdir(), "push-test-"));
function saFile(obj: unknown, name = "sa.json"): string {
	const p = join(dir, name);
	writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
	return p;
}

interface Call {
	url: string;
	init: RequestInit;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(handler: (call: Call, n: number) => Response | Promise<Response>, startMs = 1_000_000_000_000) {
	const calls: Call[] = [];
	const clock = { ms: startMs };
	const fetchFn = (async (url: unknown, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return handler(call, calls.length);
	}) as typeof fetch;
	const logs: string[] = [];
	const sender = new PushSender({
		serviceAccountPath: saFile(sa),
		hostId: "host-1",
		fetch: fetchFn,
		now: () => clock.ms,
		log: (m) => logs.push(m),
	});
	return { sender, calls, clock, logs };
}

const isToken = (c: Call) => c.url === "https://oauth2.googleapis.com/token";
const tokenOk = (tok = "at-1", expires = 3600) => json(200, { access_token: tok, expires_in: expires });

describe("service account JWT", () => {
	it("has exact structure, claims and a valid RS256 signature", () => {
		const jwt = buildServiceAccountJwt(sa, 1700000000);
		const parts = jwt.split(".");
		assert.equal(parts.length, 3);
		assert.ok(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
		assert.deepEqual(JSON.parse(Buffer.from(parts[0]!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
		assert.deepEqual(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()), {
			iss: sa.client_email,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: "https://oauth2.googleapis.com/token",
			iat: 1700000000,
			exp: 1700003600,
		});
		const v = createVerify("RSA-SHA256");
		v.update(`${parts[0]}.${parts[1]}`);
		assert.equal(v.verify(createPublicKey(publicKey), Buffer.from(parts[2]!, "base64url")), true);
	});

	it("uses custom token_uri as aud", () => {
		const jwt = buildServiceAccountJwt({ ...sa, token_uri: "https://example.test/tok" }, 5);
		const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
		assert.equal(claims.aud, "https://example.test/tok");
	});
});

describe("buildFcmMessage", () => {
	it("is content-free", () => {
		assert.deepEqual(buildFcmMessage("tok", "h"), {
			message: { token: "tok", data: { w: "1", h: "h" }, android: { priority: "HIGH", ttl: "60s" } },
		});
	});
});

describe("loadServiceAccount", () => {
	it("loads a valid file", () => {
		assert.deepEqual(loadServiceAccount(saFile(sa)), sa);
	});

	it("rejects missing project_id without echoing the key", () => {
		const { project_id: _p, ...rest } = sa;
		const p = saFile(rest, "noproj.json");
		assert.throws(
			() => loadServiceAccount(p),
			(e: Error) => /project_id/.test(e.message) && !e.message.includes("PRIVATE KEY"),
		);
	});

	it("rejects invalid JSON and missing file", () => {
		assert.throws(() => loadServiceAccount(saFile("{nope", "bad.json")), /not valid JSON/);
		assert.throws(() => loadServiceAccount(join(dir, "absent.json")), /cannot read/);
	});
});

describe("PushSender", () => {
	it("is disabled with no path or a bad file, never throwing", () => {
		const logs: string[] = [];
		const a = new PushSender({ hostId: "h", log: (m) => logs.push(m) });
		assert.equal(a.enabled, false);
		const b = new PushSender({ serviceAccountPath: saFile("garbage", "g.json"), hostId: "h", log: (m) => logs.push(m) });
		assert.equal(b.enabled, false);
		const c = new PushSender({ serviceAccountPath: join(dir, "nope.json"), hostId: "h" });
		assert.equal(c.enabled, false);
		assert.equal(logs.length, 1);
		assert.ok(!logs[0]!.includes("PRIVATE KEY"));
	});

	it("sends a content-free request with exchanged token and exact form body", async () => {
		const { sender, calls, logs } = setup((c) => (isToken(c) ? tokenOk() : json(200, { name: "x" })));
		assert.equal(sender.enabled, true);
		const r = await sender.send([{ did: "d1", token: "devtok" }]);
		assert.deepEqual(r, { sent: 1, failed: 0, dead: [] });
		assert.equal(calls.length, 2);

		const ex = calls[0]!;
		assert.equal(ex.init.method, "POST");
		assert.deepEqual(ex.init.headers, { "content-type": "application/x-www-form-urlencoded" });
		const body = ex.init.body as string;
		const params = new URLSearchParams(body);
		assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
		assert.ok(body.startsWith("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="));
		const jwt = params.get("assertion")!;
		const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
		assert.equal(claims.iat, 1_000_000_000);

		const f = calls[1]!;
		assert.equal(f.url, "https://fcm.googleapis.com/v1/projects/proj-1/messages:send");
		assert.equal(f.init.method, "POST");
		const headers = f.init.headers as Record<string, string>;
		assert.equal(headers.authorization, "Bearer at-1");
		assert.equal(headers["content-type"], "application/json");
		assert.deepEqual(JSON.parse(f.init.body as string), buildFcmMessage("devtok", "host-1"));
		for (const l of logs) {
			assert.ok(!l.includes("devtok") && !l.includes("at-1"));
		}
	});

	it("caches the access token until expires_in - 60s", async () => {
		const { sender, calls, clock } = setup((c) => (isToken(c) ? tokenOk("at", 3600) : json(200, {})));
		const t = [{ did: "d", token: "t" }];
		await sender.send(t);
		await sender.send(t);
		assert.equal(calls.filter(isToken).length, 1);
		clock.ms += 3539_000;
		await sender.send(t);
		assert.equal(calls.filter(isToken).length, 1);
		clock.ms += 1_000;
		await sender.send(t);
		assert.equal(calls.filter(isToken).length, 2);
	});

	it("shares one in-flight exchange across concurrent sends", async () => {
		const gate = Promise.withResolvers<void>();
		const { sender, calls } = setup(async (c) => {
			if (!isToken(c)) return json(200, {});
			await gate.promise;
			return tokenOk();
		});
		const pa = sender.send([{ did: "a", token: "ta" }]);
		const pb = sender.send([{ did: "b", token: "tb" }]);
		gate.resolve();
		const [a, b] = await Promise.all([pa, pb]);
		assert.equal(a.sent + b.sent, 2);
		assert.equal(calls.filter(isToken).length, 1);
	});

	it("maps UNREGISTERED and 404 to dead", async () => {
		const { sender } = setup((c) => {
			if (isToken(c)) return tokenOk();
			const tok = JSON.parse(c.init.body as string).message.token;
			if (tok === "gone") {
				return json(404, {
					error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
				});
			}
			if (tok === "gone2") return json(404, {});
			if (tok === "bad") {
				return json(400, {
					error: {
						status: "INVALID_ARGUMENT",
						message: "The registration token is not a valid FCM registration token",
						details: [{ errorCode: "INVALID_ARGUMENT" }],
					},
				});
			}
			if (tok === "badother") {
				return json(400, { error: { message: "Invalid payload", details: [{ errorCode: "INVALID_ARGUMENT" }] } });
			}
			return json(200, {});
		});
		const r = await sender.send([
			{ did: "d1", token: "gone" },
			{ did: "d2", token: "gone2" },
			{ did: "d3", token: "bad" },
			{ did: "d4", token: "badother" },
			{ did: "d5", token: "ok" },
		]);
		assert.equal(r.sent, 1);
		assert.equal(r.failed, 1);
		assert.deepEqual([...r.dead].sort(), ["d1", "d2", "d3"]);
	});

	it("on 401 invalidates the token and retries once", async () => {
		let fcm = 0;
		const { sender, calls } = setup((c) => {
			if (isToken(c)) return tokenOk(`at-${calls.filter(isToken).length}`);
			fcm++;
			return fcm === 1 ? json(401, { error: {} }) : json(200, {});
		});
		const r = await sender.send([{ did: "d", token: "t" }]);
		assert.deepEqual(r, { sent: 1, failed: 0, dead: [] });
		assert.equal(calls.filter(isToken).length, 2);
		const fcmCalls = calls.filter((c) => !isToken(c));
		assert.equal(fcmCalls.length, 2);
		assert.equal((fcmCalls[1]!.init.headers as Record<string, string>).authorization, "Bearer at-2");
	});

	it("does not retry a second 401", async () => {
		const { sender, calls } = setup((c) => (isToken(c) ? tokenOk() : json(401, {})));
		const r = await sender.send([{ did: "d", token: "t" }]);
		assert.equal(r.failed, 1);
		assert.equal(calls.filter((c) => !isToken(c)).length, 2);
	});

	it("counts 500, 429 and network errors as failed without retry", async () => {
		const { sender, calls } = setup((c) => {
			if (isToken(c)) return tokenOk();
			const tok = JSON.parse(c.init.body as string).message.token;
			if (tok === "net") throw new Error("boom");
			return tok === "five" ? json(500, {}) : json(429, {});
		});
		const r = await sender.send([
			{ did: "a", token: "five" },
			{ did: "b", token: "many" },
			{ did: "c", token: "net" },
		]);
		assert.deepEqual(r, { sent: 0, failed: 3, dead: [] });
		assert.equal(calls.filter((c) => !isToken(c)).length, 3);
	});

	it("marks all targets failed when the token exchange fails", async () => {
		const { sender, calls } = setup(() => json(400, { error: "invalid_grant" }));
		const r = await sender.send([
			{ did: "a", token: "ta" },
			{ did: "b", token: "tb" },
		]);
		assert.equal(r.failed, 2);
		assert.ok(calls.every(isToken));
	});

	it("disabled sender reports failures and never fetches", async () => {
		let n = 0;
		const s = new PushSender({
			hostId: "h",
			fetch: (async () => {
				n++;
				return json(200, {});
			}) as typeof fetch,
		});
		assert.deepEqual(await s.send([{ did: "a", token: "t" }]), { sent: 0, failed: 1, dead: [] });
		assert.equal(n, 0);
	});
});
