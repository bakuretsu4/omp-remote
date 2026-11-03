import { parseArgs } from "node:util";
import { startRelay } from "./node.ts";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "7466" },
		host: { type: "string", default: "127.0.0.1" },
		"trust-proxy": { type: "boolean", default: false },
		"rate-limit": { type: "string", default: "120" },
		"max-guests-per-ip": { type: "string", default: "8" },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log(
		"usage: node relay/src/cli.ts [--port 7466] [--host 127.0.0.1] [--trust-proxy] [--rate-limit <conns/min/IP>] [--max-guests-per-ip 8]",
	);
	process.exit(0);
}

const port = Number(values.port);
const max = Number(values["rate-limit"]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(`relay: invalid --port ${values.port}`);
	process.exit(1);
}
const perIp = Number(values["max-guests-per-ip"]);
if (!Number.isInteger(perIp) || perIp < 1) {
	console.error(`relay: invalid --max-guests-per-ip ${values["max-guests-per-ip"]}`);
	process.exit(1);
}
if (!Number.isInteger(max) || max < 1) {
	console.error(`relay: invalid --rate-limit ${values["rate-limit"]}`);
	process.exit(1);
}

const relay = await startRelay({
	port,
	host: values.host!,
	trustProxy: values["trust-proxy"],
	rateLimit: { max, windowMs: 60_000 },
	maxGuestsPerIp: perIp,
});
console.log(`omp-remote relay listening on ${values.host}:${relay.port}`);

let stopping = false;
const shutdown = async (): Promise<void> => {
	if (stopping) return;
	stopping = true;
	await relay.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
