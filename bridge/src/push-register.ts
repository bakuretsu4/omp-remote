import type { DeviceStore } from "./devices.ts";
import { invalid } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { endpointProblem } from "./unifiedpush.ts";

const MAX_FCM_TOKEN = 4096;

/**
 * Stores a phone's push registration (`push.register`). One registration per device; the same token or endpoint is
 * removed from every other device so a reinstalled app does not leave a stale duplicate behind.
 */
export function registerPush(devices: DeviceStore, did: string, args: unknown): void {
	if (!isRecord(args)) throw invalid("push.register needs an object");
	if (args.provider === "fcm") {
		const token = args.token;
		if (typeof token !== "string" || token.length === 0 || token.length > MAX_FCM_TOKEN) throw invalid("token must be a non-empty string");
		for (const dev of devices.list()) if (dev.did !== did) devices.clearPush(dev.did, token);
		devices.setPush(did, { provider: "fcm", token });
		return;
	}
	if (args.provider === "unifiedpush") {
		const endpoint = args.endpoint;
		const problem = endpointProblem(endpoint);
		if (problem !== null) throw invalid(problem);
		for (const dev of devices.list()) if (dev.did !== did) devices.clearPush(dev.did, endpoint as string);
		devices.setPush(did, { provider: "unifiedpush", endpoint: endpoint as string });
		return;
	}
	throw invalid("provider must be fcm or unifiedpush");
}
