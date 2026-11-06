package app.ompr.net

import app.ompr.data.ErrorCodes
import app.ompr.data.SyncSummary
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable

/**
 * [HandoverHost] over a live [HostConnection]. Holds the connection for as long as it exists, which is also what makes
 * the connection manager dial a PC the user has not opened yet. Close it when the hand-over is over.
 */
class ConnectedHandoverHost(private val conn: HostConnection, override val name: String) : HandoverHost, Closeable {
    private val hold = conn.acquire()
    override val hostId: String get() = conn.hostId

    override suspend fun features(): Set<String> {
        awaitConnected()
        return conn.hostInfo().features.orEmpty().toSet()
    }

    override suspend fun stopSession(sid: String) {
        awaitConnected()
        try {
            conn.stopSession(sid, STOP_TIMEOUT_MS)
        } catch (e: WireException) {
            if (e.code != ErrorCodes.NOT_FOUND) throw e
        }
    }

    override suspend fun peerSync(): SyncSummary {
        awaitConnected()
        return conn.peerSync()
    }

    override suspend fun openSession(sessionFile: String): String {
        awaitConnected()
        return conn.openRecent(sessionFile)
    }

    /** A PC the phone was not talking to yet needs a moment (relay race, handshake): wait for it instead of failing on the first 8 s. */
    private suspend fun awaitConnected() {
        if (conn.isConnected) return
        val s = withTimeoutOrNull(CONNECT_WAIT_MS) { conn.state.first { it is ConnState.Connected || it is ConnState.Fatal } }
        if (s is ConnState.Fatal) throw WireException(ErrorCodes.DISCONNECTED, s.reason)
        if (s == null) throw WireException(ErrorCodes.DISCONNECTED, "Could not reach $name")
    }

    override fun close() = hold.close()

    private companion object {
        const val CONNECT_WAIT_MS = 30_000L
        const val STOP_TIMEOUT_MS = 60_000L
    }
}
