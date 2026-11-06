/** The `peer.sync` op: run one sync with the configured companion PC now and report what moved. */
import type { SyncSummary } from "../../protocol/src/index.ts";
import { OpError, unsupported } from "./errors.ts";
import type { SyncReport } from "./sync.ts";

/** What the op needs from `PeerSync` (and what tests fake). */
export interface PeerSyncRunner {
	syncFresh(): Promise<SyncReport>;
}

/** The app waits at most 300 s for `res`; the bridge gives a sync longer, and a sync past the cap keeps running. */
export const PEER_SYNC_OP_TIMEOUT_MS = 15 * 60_000;

const MAX_MESSAGE = 300;

function readable(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_MESSAGE) || "unknown error";
}

export async function runPeerSyncOp(
	sync: PeerSyncRunner | undefined,
	log: (m: string) => void,
	timeoutMs: number = PEER_SYNC_OP_TIMEOUT_MS,
): Promise<SyncSummary> {
	if (!sync) throw unsupported("this bridge has no peer configured");
	const { promise: timedOut, reject: onTimeout } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		onTimeout(new OpError("timeout", `the sync with the peer is still running after ${Math.round(timeoutMs / 60_000)} min; it continues in the background (see \`ompr status\`)`));
	}, timeoutMs);
	try {
		const r = await Promise.race([sync.syncFresh(), timedOut]);
		return {
			pushedSessions: r.pushedSessions.length,
			pulledSessions: r.pulledSessions.length,
			pushedProjects: r.pushedProjects.length,
			pulledProjects: r.pulledProjects.length,
			durationMs: r.durationMs,
		};
	} catch (e) {
		if (e instanceof OpError) throw e;
		const message = readable(e);
		log(`peer.sync failed: ${message}`);
		throw new OpError("internal", `sync with the peer failed: ${message}`);
	} finally {
		clearTimeout(timer);
	}
}
