package app.ompr.net

import android.util.Log
import app.ompr.data.ErrorCodes
import app.ompr.data.HostEvent
import app.ompr.data.HostInfo
import app.ompr.data.HostRepository
import app.ompr.data.SessionEvent
import app.ompr.data.SessionSummary
import app.ompr.data.SessionsListResult
import app.ompr.data.WireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transformLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.OkHttpClient
import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/** An error response from the bridge, or a local failure (`code == "disconnected"` / `"timeout"`). */
class WireException(val code: String, override val message: String) : Exception(message)

sealed interface ConnState {
    /** Nobody wants this connection right now. */
    data object Idle : ConnState

    data class Connecting(val attempt: Int, val relay: String? = null) : ConnState

    data class Connected(val relay: String, val lan: Boolean, val info: HostInfo) : ConnState

    /** Waiting to retry. [reason] is user-presentable. */
    data class Offline(val reason: String, val retryAtMs: Long, val attempt: Int, val hint: OfflineHint) : ConnState

    /** Cannot recover without user action (host removed, identity changed, protocol mismatch). */
    data class Fatal(val reason: String) : ConnState
}

enum class OfflineHint { NETWORK, BRIDGE_OFFLINE, NO_ANSWER, INVALID_PEER, OTHER }

/** What the dashboard renders. */
data class SessionList(
    val items: List<SessionSummary> = emptyList(),
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
)

/** A claim on the connection; the socket stays up while at least one hold exists. */
class Hold internal constructor(private val onRelease: () -> Unit) : Closeable {
    private val released = java.util.concurrent.atomic.AtomicBoolean(false)
    override fun close() {
        if (released.compareAndSet(false, true)) onRelease()
    }
}

/**
 * Whether the socket should be open: true while any holder exists. Releasing the last holder only emits `false` after
 * [graceMs], so a navigation flap (one screen releases, the next acquires) never reaches the collector. The second
 * `distinctUntilChanged` matters: `transformLatest` swallows the cancelled `false` but still emits the following
 * `true`, and `collectLatest` would otherwise treat that duplicate as a new value and tear the live socket down.
 */
internal fun Flow<Int>.wantConnected(graceMs: Long): Flow<Boolean> =
    map { it > 0 }.distinctUntilChanged()
        .transformLatest { want ->
            if (!want) delay(graceMs)
            emit(want)
        }
        .distinctUntilChanged()

/**
 * Long-lived, self-healing encrypted connection to one host. Connect/reconnect policy (§5):
 * relays raced in order (1.5 s stagger), exponential backoff capped at 30 s, ping after 25 s of send-silence,
 * dead after 70 s of receive-silence. Requests are correlated by id; events are routed by `sid`.
 */
class HostConnection(
    val hostId: String,
    private val repo: HostRepository,
    private val scope: CoroutineScope,
    private val client: OkHttpClient,
    private val deviceLabel: String,
    private val hostTools: HostToolHandler,
) {
    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()

    private val _info = MutableStateFlow<HostInfo?>(null)

    /** Last HostInfo seen (kept across disconnects). */
    val info: StateFlow<HostInfo?> = _info.asStateFlow()

    private val _sessions = MutableStateFlow(SessionList())
    val sessions: StateFlow<SessionList> = _sessions.asStateFlow()

    private val _hostEvents = MutableSharedFlow<HostEvent>(extraBufferCapacity = 128)
    val hostEvents: SharedFlow<HostEvent> = _hostEvents.asSharedFlow()

    /** Bumped on every completed handshake; lets observers notice reconnects. */
    private val _connectCount = MutableStateFlow(0)
    val connectCount: StateFlow<Int> = _connectCount.asStateFlow()

    @Volatile
    private var channel: SecureChannel? = null
    private val nextId = AtomicInteger(0)
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<JsonObject>>()
    private val holders = MutableStateFlow(0)
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private val refreshTrigger = Channel<Unit>(Channel.CONFLATED)
    private val stores = ConcurrentHashMap<String, SessionStore>()
    private val toolJobs = ConcurrentHashMap<String, Job>()

    /** Run after each successful handshake, on their own coroutine (so they may issue requests). */
    @Volatile
    var onConnectedHooks: List<suspend (HostConnection) -> Unit> = emptyList()

    val isConnected: Boolean get() = _state.value is ConnState.Connected
    val blobs = BlobCache(this)

    init {
        scope.launch {
            holders.wantConnected(graceMs = 4_000)
                .collectLatest { want ->
                    if (want) runLoop() else {
                        _state.value = ConnState.Idle
                    }
                }
        }
        scope.launch {
            for (u in refreshTrigger) {
                delay(250)
                runCatching { refreshSessions() }
            }
        }
    }

    /** Keep the connection alive until the returned [Hold] is closed. */
    fun acquire(): Hold {
        holders.value += 1
        return Hold { holders.value -= 1 }
    }

    /** Skip the backoff wait and try now (network came back, user tapped retry). */
    fun reconnectNow() {
        kick.trySend(Unit)
    }

    // ───────────────────────── connection loop ─────────────────────────

    private suspend fun runLoop() {
        var attempt = 0
        var noAnswerStreak = 0
        while (true) {
            val rec = repo.get(hostId)
            if (rec == null) {
                _state.value = ConnState.Fatal("This host was removed")
                return
            }
            _state.value = ConnState.Connecting(attempt)
            var failure: Throwable? = null
            try {
                val raced = raceRelays(rec.relays, dispose = { it.close() }) { url ->
                    _state.value = ConnState.Connecting(attempt, url)
                    val link = RelayLink.open(client, url, rec.roomId)
                    try {
                        SecureChannel.handshake(link, rec, deviceLabel, hostTools.supportedCaps)
                    } catch (e: Throwable) {
                        link.cancel()
                        throw e
                    }
                }
                attempt = 0
                noAnswerStreak = 0
                serve(raced.value)
                Log.i(TAG, "channel closed by peer/relay (receive returned null)")
                failure = ChannelDeadException("connection closed")
            } catch (e: CancellationException) {
                throw e
            } catch (e: FatalHandshakeException) {
                _state.value = ConnState.Fatal(e.message ?: "Handshake failed")
                return
            } catch (e: Throwable) {
                Log.w(TAG, "connection ended: ${e.javaClass.simpleName}: ${e.message}", e)
                failure = e
            } finally {
                channel = null
                failPending()
            }

            val hint = when {
                failure is HandshakeTimeoutException -> OfflineHint.NO_ANSWER
                failure is InvalidFramesException -> OfflineHint.INVALID_PEER
                failure is RelayException && failure.bridgeOffline -> OfflineHint.BRIDGE_OFFLINE
                failure is RelayException -> OfflineHint.NETWORK
                else -> OfflineHint.OTHER
            }
            if (failure is HandshakeTimeoutException) noAnswerStreak++ else noAnswerStreak = 0
            val reason = when (hint) {
                OfflineHint.BRIDGE_OFFLINE -> "The PC is not connected to the relay (is `ompr run` running?)"
                OfflineHint.NO_ANSWER ->
                    if (noAnswerStreak >= 3) "The bridge does not answer — this device may have been revoked, or the PC is asleep"
                    else "The bridge did not answer"
                OfflineHint.INVALID_PEER -> "Received data that could not be authenticated; retrying"
                OfflineHint.NETWORK -> "Cannot reach the relay: ${failure.message ?: "network error"}"
                OfflineHint.OTHER -> failure.message ?: "Connection lost"
            }
            attempt++
            val waitMs = backoffMs(attempt)
            _state.value = ConnState.Offline(reason, System.currentTimeMillis() + waitMs, attempt, hint)
            withTimeoutOrNull(waitMs) { kick.receive() }
        }
    }

    private fun backoffMs(attempt: Int): Long {
        val base = min(30_000L, 1_000L shl min(attempt - 1, 5))
        return base - (0..base / 5).random()
    }

    /** Runs one established channel until it dies. Throws on failure; returns on clean close. */
    private suspend fun serve(ch: SecureChannel) = coroutineScope {
        channel = ch
        _info.value = ch.hostInfo
        _state.value = ConnState.Connected(ch.relayUrl, RelayUrls.isLan(ch.relayUrl), ch.hostInfo)
        _connectCount.value += 1
        Log.i(TAG, "connected via ${ch.relayUrl}")

        val watchdog = launch {
            while (true) {
                delay(5_000)
                val now = System.currentTimeMillis()
                if (now - ch.lastValidAt > 70_000) throw ChannelDeadException("no data from the bridge for 70 s")
                if (now - ch.lastSentAt >= 25_000) runCatching { ch.send(buildJsonObject { put("t", "ping") }) }
            }
        }
        val hooks = launch {
            runCatching { resyncSessions() }
            runCatching { refreshSessions() }
            for (h in onConnectedHooks) launch { runCatching { h(this@HostConnection) } }
        }
        try {
            while (true) {
                val msg = ch.receive() ?: break
                dispatch(ch, msg)
            }
        } finally {
            watchdog.cancel()
            hooks.cancel()
            ch.close()
        }
    }

    private fun failPending() {
        val err = WireException(ErrorCodes.DISCONNECTED, "Connection lost")
        val snapshot = pending.entries.toList()
        pending.clear()
        for ((_, d) in snapshot) d.completeExceptionally(err)
    }

    // ───────────────────────── inbound dispatch ─────────────────────────

    private fun dispatch(ch: SecureChannel, msg: JsonObject) {
        when (msg["t"]?.jsonPrimitive?.contentOrNull) {
            "res" -> {
                val id = msg["id"]?.jsonPrimitive?.longOrNull?.toInt() ?: return
                pending.remove(id)?.complete(msg)
            }
            "ev" -> {
                val sid = msg["sid"]?.jsonPrimitive?.contentOrNull ?: return
                val n = msg["n"]?.jsonPrimitive?.longOrNull ?: return
                val store = stores[sid] ?: return
                val ev = decode<SessionEvent>(msg["e"]) ?: return
                store.onEvent(n, ev)
            }
            "hev" -> {
                val ev = decode<HostEvent>(msg["e"]) ?: return
                onHostEvent(ev)
            }
            "ping" -> runCatching { ch.send(buildJsonObject { put("t", "pong") }) }
            "pong" -> Unit
            else -> Unit
        }
    }

    private inline fun <reified T> decode(e: JsonElement?): T? {
        if (e == null) return null
        return try {
            WireJson.decodeFromJsonElement(serializer<T>(), e)
        } catch (ex: Exception) {
            Log.w(TAG, "undecodable ${T::class.java.simpleName}: ${ex.javaClass.simpleName}")
            null
        }
    }

    private fun onHostEvent(ev: HostEvent) {
        when (ev) {
            is HostEvent.SessionsChanged -> refreshTrigger.trySend(Unit)
            is HostEvent.HostToolCall -> {
                toolJobs[ev.callId] = scope.launch {
                    val result = try {
                        hostTools.call(this@HostConnection, ev)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        HostToolResult.failure("Tool failed: ${e.message ?: e.javaClass.simpleName}")
                    } finally {
                        toolJobs.remove(ev.callId)
                    }
                    runCatching { request("hosttool.result", result.toArgs(ev.callId)) }
                }
            }
            is HostEvent.HostToolCancel -> {
                toolJobs.remove(ev.callId)?.cancel()
                hostTools.cancel(ev.callId)
            }
            else -> Unit
        }
        _hostEvents.tryEmit(ev)
    }

    // ───────────────────────── requests ─────────────────────────

    /** Suspends until connected (up to [waitMs]); throws `WireException("disconnected")` otherwise. */
    suspend fun awaitConnected(waitMs: Long): SecureChannel {
        channel?.let { return it }
        withTimeoutOrNull(waitMs) { _state.first { it is ConnState.Connected } }
        return channel ?: throw WireException(ErrorCodes.DISCONNECTED, "Not connected to the PC")
    }

    /** Sends a request and returns the `d` payload. Throws [WireException] on any failure. */
    suspend fun request(op: String, args: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 20_000): JsonElement {
        val ch = awaitConnected(min(timeoutMs, 8_000))
        val id = nextId.incrementAndGet()
        val d = CompletableDeferred<JsonObject>()
        pending[id] = d
        try {
            try {
                ch.send(buildJsonObject {
                    put("t", "req")
                    put("id", id)
                    put("op", op)
                    put("a", args)
                })
            } catch (e: IllegalArgumentException) {
                throw WireException(ErrorCodes.INVALID, e.message ?: "request too large")
            } catch (e: ChannelDeadException) {
                throw WireException(ErrorCodes.DISCONNECTED, "Connection lost")
            }
            val res = withTimeoutOrNull(timeoutMs) { d.await() }
                ?: throw WireException(ErrorCodes.TIMEOUT, "The PC did not answer ($op)")
            if (res["ok"]?.jsonPrimitive?.contentOrNull == "true") return res["d"] ?: JsonObject(emptyMap())
            val err = res["e"]?.jsonObject
            throw WireException(
                err?.get("code")?.jsonPrimitive?.contentOrNull ?: ErrorCodes.INTERNAL,
                err?.get("message")?.jsonPrimitive?.contentOrNull ?: "Request failed",
            )
        } finally {
            pending.remove(id)
        }
    }

    /** Typed request. [args] may be any @Serializable value that encodes to a JSON object. */
    suspend fun <A, R> call(op: String, argSer: KSerializer<A>, args: A, resSer: KSerializer<R>, timeoutMs: Long = 20_000): R {
        val a = WireJson.encodeToJsonElement(argSer, args).jsonObject
        val d = request(op, a, timeoutMs)
        return try {
            WireJson.decodeFromJsonElement(resSer, d)
        } catch (e: Exception) {
            Log.w(TAG, "decode $op: ${e.message?.take(300)}")
            throw WireException(ErrorCodes.INTERNAL, "Unexpected reply to $op")
        }
    }

    suspend fun <R> call(op: String, args: JsonObject, resSer: KSerializer<R>, timeoutMs: Long = 20_000): R {
        val d = request(op, args, timeoutMs)
        return try {
            WireJson.decodeFromJsonElement(resSer, d)
        } catch (e: Exception) {
            Log.w(TAG, "decode $op: ${e.message?.take(300)}")
            throw WireException(ErrorCodes.INTERNAL, "Unexpected reply to $op")
        }
    }

    // ───────────────────────── sessions list ─────────────────────────

    suspend fun refreshSessions() {
        _sessions.value = _sessions.value.copy(refreshing = true)
        try {
            val r = call("sessions.list", buildJsonObject { put("recent", 30) }, SessionsListResult.serializer())
            _sessions.value = SessionList(r.sessions, loaded = true, refreshing = false, error = null)
            // Keep open stores' summary (caps, status) fresh.
            for (s in r.sessions) stores[s.sid]?.updateSummary(s)
        } catch (e: WireException) {
            Log.w(TAG, "sessions.list failed: ${e.code} ${e.message}")
            _sessions.value = _sessions.value.copy(refreshing = false, error = e.message)
            throw e
        }
    }

    // ───────────────────────── session handles ─────────────────────────

    /**
     * Subscribes to a session (`session.open`) and exposes its live [SessionView]. Close the handle when the
     * screen leaves; the subscription is shared and re-established after reconnects.
     */
    fun session(sid: String): SessionHandle {
        val store = stores.computeIfAbsent(sid) { SessionStore(sid, this) }
        val first = store.retain()
        if (first) store.start(scope)
        return SessionHandle(this, store)
    }

    internal fun releaseStore(store: SessionStore) {
        if (store.release()) {
            stores.remove(store.sid, store)
            scope.launch { runCatching { request("session.close", buildJsonObject { put("sid", store.sid) }, 5_000) } }
        }
    }

    private suspend fun resyncSessions() {
        for (s in stores.values.toList()) s.reopenAsync(scope)
    }

    internal fun resync(store: SessionStore) = store.reopenAsync(scope)

    companion object {
        private const val TAG = "OmprConn"
    }
}
