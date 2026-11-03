package app.ompr.net

import app.ompr.data.ErrorCodes
import app.ompr.data.OpenResult
import app.ompr.data.SessionEvent
import app.ompr.data.SessionPhase
import app.ompr.data.SessionReducer
import app.ompr.data.SessionSummary
import app.ompr.data.SessionView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Shared, ref-counted subscription to one session. `session.open` provides the snapshot and the index `n` after
 * which `ev` frames follow; events that race ahead of the snapshot are buffered and replayed. After a reconnect
 * [reopenAsync] re-snapshots (there is no replay buffer on the bridge, §6.2).
 */
class SessionStore internal constructor(val sid: String, private val conn: HostConnection) {
    val view = MutableStateFlow(SessionView(sid))

    private var refs = 0
    private var lastN = -1L
    private var ready = false
    private val buffer = ArrayList<Pair<Long, SessionEvent>>()
    private val openLock = Mutex()
    private var lastGapResync = 0L

    @Synchronized
    fun retain(): Boolean {
        refs++
        return refs == 1
    }

    @Synchronized
    fun release(): Boolean {
        refs--
        return refs <= 0
    }

    fun start(scope: CoroutineScope) = reopenAsync(scope)

    fun reopenAsync(scope: CoroutineScope) {
        scope.launch { runCatching { open() } }
    }

    suspend fun open() {
        openLock.withLock {
            synchronized(this) { ready = false }
            try {
                val r = conn.call(
                    "session.open",
                    buildJsonObject {
                        put("sid", sid)
                        put("limit", 200)
                    },
                    OpenResult.serializer(),
                    30_000,
                )
                synchronized(this) {
                    view.update { SessionReducer.fromSnapshot(it, r.snapshot) }
                    lastN = r.n
                    val replay = buffer.filter { it.first > r.n }.sortedBy { it.first }
                    buffer.clear()
                    for ((n, e) in replay) {
                        view.update { SessionReducer.apply(it, e) }
                        lastN = n
                    }
                    ready = true
                }
            } catch (e: WireException) {
                if (e.code == ErrorCodes.DISCONNECTED || e.code == ErrorCodes.TIMEOUT) {
                    // The next successful connect re-opens us; keep what we have.
                    return
                }
                view.update {
                    val closed = it.phase is SessionPhase.Ready
                    it.copy(phase = if (closed) SessionPhase.Closed(e.message) else SessionPhase.Failed(e.code, e.message))
                }
            }
        }
    }

    fun onEvent(n: Long, e: SessionEvent) {
        var resync = false
        synchronized(this) {
            if (!ready) {
                buffer.add(n to e)
                if (buffer.size > 2_000) buffer.removeAt(0)
                return
            }
            if (n <= lastN) return
            if (lastN >= 0 && n > lastN + 1) {
                val now = System.currentTimeMillis()
                if (now - lastGapResync > 10_000) {
                    lastGapResync = now
                    resync = true
                }
            }
            lastN = n
            view.update { SessionReducer.apply(it, e) }
        }
        if (resync) conn.resync(this)
    }

    fun updateSummary(s: SessionSummary) {
        view.update { cur ->
            if (cur.summary == s) cur else cur.copy(summary = s, rev = cur.rev + 1)
        }
    }

    fun updateView(f: (SessionView) -> SessionView) {
        view.update(f)
    }
}
