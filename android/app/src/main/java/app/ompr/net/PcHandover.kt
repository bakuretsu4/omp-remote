package app.ompr.net

import app.ompr.data.SyncSummary
import kotlinx.coroutines.CancellationException

/** Features a bridge lists in `HostInfo.features` (docs/PROTOCOL.md). */
object HostFeature {
    const val PEER_SYNC = "peer-sync"
}

/** Phases of "continue this session on another PC", in the order they run. */
enum class HandoverStep { CHECKING, STOPPING, SYNCING, OPENING }

/** The few calls the hand-over needs from one PC. The app implements it over [HostConnection]; tests use fakes. */
interface HandoverHost {
    val hostId: String
    val name: String

    /** What this PC's bridge offers (`host.info`). Connects on demand; throws when the PC cannot be reached. */
    suspend fun features(): Set<String>

    /** Stops the managed session. Returns normally when it no longer exists, so a retry after a half-finished run works. */
    suspend fun stopSession(sid: String)

    /** `peer.sync`: mirrors with this PC's configured peer and reports what moved. */
    suspend fun peerSync(): SyncSummary

    /** `sessions.open`: opens [sessionFile] as a managed session on this PC and returns its sid here. */
    suspend fun openSession(sessionFile: String): String
}

sealed interface HandoverResult {
    /** The session is open on [host] as [sid]. [sync] is null when this run resumed after the sync had already happened. */
    data class Opened(val host: HandoverHost, val sid: String, val sync: SyncSummary?) : HandoverResult

    /** Neither PC can sync. Nothing was stopped. */
    data class NoPeerSync(val source: HandoverHost, val destination: HandoverHost) : HandoverResult

    /** [step] is where it failed; call [PcHandover.run] with `from = step` to retry. */
    data class Failed(val step: HandoverStep, val cause: Throwable) : HandoverResult
}

/**
 * Moves one managed session from [source] to [destination]: stop it where it runs (a running session holds a lease and
 * the bridges' sync skips held sessions), run `peer.sync` on a PC that has it, then open the session file on the destination.
 *
 * Fail-closed ordering: whether a sync is possible at all is decided before anything is stopped, so a missing
 * `peer-sync` never costs the user a running session.
 */
class PcHandover(private val source: HandoverHost, private val destination: HandoverHost) {

    /** [from] resumes at the step that failed; every step is safe to repeat (stop of a gone session succeeds, sync is incremental, open returns the live session). */
    suspend fun run(
        sid: String,
        sessionFile: String,
        from: HandoverStep = HandoverStep.CHECKING,
        onStep: (HandoverStep) -> Unit = {},
    ): HandoverResult {
        var step = from
        try {
            var syncHost: HandoverHost? = null
            if (from <= HandoverStep.SYNCING) {
                step = HandoverStep.CHECKING
                onStep(step)
                syncHost = pickSyncHost(source, destination)
                    ?: return HandoverResult.NoPeerSync(source, destination)
            }
            if (from <= HandoverStep.STOPPING) {
                step = HandoverStep.STOPPING
                onStep(step)
                source.stopSession(sid)
            }
            var summary: SyncSummary? = null
            if (from <= HandoverStep.SYNCING) {
                step = HandoverStep.SYNCING
                onStep(step)
                summary = syncHost!!.peerSync()
            }
            step = HandoverStep.OPENING
            onStep(step)
            return HandoverResult.Opened(destination, destination.openSession(sessionFile), summary)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return HandoverResult.Failed(step, e)
        }
    }

    /** The PC that runs `peer.sync`: the destination when it can (it pulls what it lacks), otherwise the source. Null when neither can. */
    private suspend fun pickSyncHost(source: HandoverHost, destination: HandoverHost): HandoverHost? {
        val dest = destination.features()
        if (HostFeature.PEER_SYNC in dest) return destination
        val src = source.features()
        return if (HostFeature.PEER_SYNC in src) source else null
    }
}
