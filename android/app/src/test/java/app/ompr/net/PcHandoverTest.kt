package app.ompr.net

import app.ompr.data.SyncSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeHost(
    override val hostId: String,
    override val name: String,
    private val features: Set<String>,
    private val log: MutableList<String>,
) : HandoverHost {
    var featuresError: Throwable? = null
    var stopError: Throwable? = null
    var syncError: Throwable? = null
    var openError: Throwable? = null
    var syncResult = SyncSummary(pushedSessions = 1)
    var openSid = "m_dest"

    override suspend fun features(): Set<String> {
        log += "$hostId.features"
        featuresError?.let { throw it }
        return features
    }

    override suspend fun stopSession(sid: String) {
        log += "$hostId.stop($sid)"
        stopError?.let { throw it }
    }

    override suspend fun peerSync(): SyncSummary {
        log += "$hostId.sync"
        syncError?.let { throw it }
        return syncResult
    }

    override suspend fun openSession(sessionFile: String): String {
        log += "$hostId.open($sessionFile)"
        openError?.let { throw it }
        return openSid
    }
}

class PcHandoverTest {
    private val log = mutableListOf<String>()
    private val sync = setOf(HostFeature.PEER_SYNC)
    private val file = "/home/u/.omp/agent/sessions/--p--/s.jsonl"

    private fun hosts(srcFeatures: Set<String>, dstFeatures: Set<String>) =
        FakeHost("src", "Laptop", srcFeatures, log) to FakeHost("dst", "Server", dstFeatures, log)

    @Test
    fun syncsOnTheDestinationWhenBothCan() = runTest {
        val (src, dst) = hosts(sync, sync)
        val steps = mutableListOf<HandoverStep>()
        val r = PcHandover(src, dst).run("m_1", file) { steps += it }
        assertTrue(r is HandoverResult.Opened)
        r as HandoverResult.Opened
        assertSame(dst, r.host)
        assertEquals("m_dest", r.sid)
        // The destination is asked first and preferred; the source's features are never needed.
        assertEquals(listOf("dst.features", "src.stop(m_1)", "dst.sync", "dst.open($file)"), log)
        assertEquals(listOf(HandoverStep.CHECKING, HandoverStep.STOPPING, HandoverStep.SYNCING, HandoverStep.OPENING), steps)
    }

    @Test
    fun fallsBackToTheSourceWhenOnlyItCanSync() = runTest {
        val (src, dst) = hosts(sync, emptySet())
        val r = PcHandover(src, dst).run("m_1", file)
        assertTrue(r is HandoverResult.Opened)
        assertEquals(listOf("dst.features", "src.features", "src.stop(m_1)", "src.sync", "dst.open($file)"), log)
    }

    @Test
    fun neverStopsTheSessionWhenNeitherPcCanSync() = runTest {
        val (src, dst) = hosts(emptySet(), setOf("usage"))
        val r = PcHandover(src, dst).run("m_1", file)
        assertTrue(r is HandoverResult.NoPeerSync)
        assertEquals(listOf("dst.features", "src.features"), log)
    }

    @Test
    fun anUnreachableDestinationFailsBeforeAnythingIsStopped() = runTest {
        val (src, dst) = hosts(sync, sync)
        val boom = WireException("disconnected", "Could not reach Server")
        dst.featuresError = boom
        val r = PcHandover(src, dst).run("m_1", file)
        assertEquals(HandoverResult.Failed(HandoverStep.CHECKING, boom), r)
        assertTrue(log.none { it.contains("stop") })
    }

    @Test
    fun aFailedStopSkipsSyncAndOpen() = runTest {
        val (src, dst) = hosts(sync, sync)
        val boom = WireException("readonly", "only sessions started from the phone can be stopped here")
        src.stopError = boom
        val r = PcHandover(src, dst).run("m_1", file)
        assertEquals(HandoverResult.Failed(HandoverStep.STOPPING, boom), r)
        assertEquals(listOf("dst.features", "src.stop(m_1)"), log)
    }

    @Test
    fun aFailedSyncNeverOpensTheDestinationCopy() = runTest {
        val (src, dst) = hosts(sync, sync)
        val boom = WireException("internal", "sync with the peer failed: connection refused")
        dst.syncError = boom
        val r = PcHandover(src, dst).run("m_1", file)
        assertEquals(HandoverResult.Failed(HandoverStep.SYNCING, boom), r)
        assertTrue(log.none { it.contains("open") })
    }

    @Test
    fun retryResumesAtTheFailedStepWithoutStoppingOrSyncingAgain() = runTest {
        val (src, dst) = hosts(sync, sync)
        dst.openError = WireException("not_found", "session file not found")
        val first = PcHandover(src, dst).run("m_1", file)
        assertTrue(first is HandoverResult.Failed && first.step == HandoverStep.OPENING)
        log.clear()
        dst.openError = null
        val second = PcHandover(src, dst).run("m_1", file, from = HandoverStep.OPENING)
        assertTrue(second is HandoverResult.Opened)
        assertEquals(null, (second as HandoverResult.Opened).sync)
        assertEquals(listOf("dst.open($file)"), log)
    }

    @Test
    fun retryOfASyncFailureChecksAgainThenSyncsWithoutStoppingTwice() = runTest {
        val (src, dst) = hosts(sync, sync)
        dst.syncError = WireException("timeout", "The PC took too long to answer")
        PcHandover(src, dst).run("m_1", file)
        log.clear()
        dst.syncError = null
        val r = PcHandover(src, dst).run("m_1", file, from = HandoverStep.SYNCING)
        assertTrue(r is HandoverResult.Opened)
        assertEquals(listOf("dst.features", "dst.sync", "dst.open($file)"), log)
    }

    @Test
    fun cancellationPropagatesInsteadOfBecomingAFailure() = runTest {
        val (src, dst) = hosts(sync, sync)
        dst.syncError = CancellationException("screen left")
        var thrown: Throwable? = null
        try {
            PcHandover(src, dst).run("m_1", file)
        } catch (e: CancellationException) {
            thrown = e
        }
        assertTrue(thrown != null)
    }

    @Test
    fun reportsTheSyncSummaryOnSuccess() = runTest {
        val (src, dst) = hosts(sync, sync)
        dst.syncResult = SyncSummary(pulledSessions = 2, pulledProjects = 1)
        val r = PcHandover(src, dst).run("m_1", file) as HandoverResult.Opened
        assertEquals(2, r.sync?.sessionsMoved)
    }
}
