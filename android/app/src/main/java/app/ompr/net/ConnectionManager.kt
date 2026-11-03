package app.ompr.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import app.ompr.BuildConfig
import app.ompr.data.AttentionItem
import app.ompr.data.HostEvent
import app.ompr.data.HostRepository
import app.ompr.data.SettingsStore
import app.ompr.service.Notifier
import app.ompr.service.PushTokens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap

/**
 * Owns one [HostConnection] per paired host (created lazily) and wires the cross-cutting behaviour:
 * attention → notifications, push-token registration, network-change reconnects.
 * A connection only opens the socket while someone holds it ([HostConnection.acquire]): visible screens
 * and the "keep connected" foreground service.
 */
class ConnectionManager(
    private val context: Context,
    private val repo: HostRepository,
    private val settings: SettingsStore,
    private val notifier: Notifier,
    private val scope: CoroutineScope,
    private val client: OkHttpClient,
    private val hostTools: HostToolHandler,
) {
    private val conns = ConcurrentHashMap<String, HostConnection>()
    private val deviceLabel: String = run {
        val m = Build.MODEL.orEmpty().trim()
        val mf = Build.MANUFACTURER.orEmpty().trim()
        if (m.startsWith(mf, ignoreCase = true) || mf.isEmpty()) m.ifEmpty { "Android" } else "$mf $m"
    }

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    // New/changed network: don't sit out a 30 s backoff.
                    for (c in conns.values) c.reconnectNow()
                }
            })
        }
    }

    fun deviceLabel(): String = deviceLabel

    /** The (possibly idle) connection object for a paired host. Never null for a paired host id. */
    fun get(hostId: String): HostConnection = conns.computeIfAbsent(hostId) { id ->
        HostConnection(id, repo, scope, client, deviceLabel, hostTools).also { attach(it) }
    }

    /** Drops state for an unpaired host. */
    fun forget(hostId: String) {
        conns.remove(hostId)
        scope.launch { settings.clearHost(hostId) }
    }

    /** Re-handshake every live connection (the advertised phone capabilities changed). */
    fun reconnectAll() {
        for (c in conns.values) c.forceReconnect()
    }

    private fun hostName(hostId: String): String = repo.get(hostId)?.name ?: "PC"

    private fun attach(conn: HostConnection) {
        conn.onConnectedHooks = listOf(
            { c -> syncAttention(c) },
            { c -> registerPush(c) },
        )
        scope.launch {
            conn.hostEvents.collect { ev ->
                when (ev) {
                    is HostEvent.Attention -> handleAttention(conn.hostId, ev.item, live = true)
                    is HostEvent.AttentionResolved -> notifier.cancelAttention(conn.hostId, ev.id)
                    else -> Unit
                }
            }
        }
    }

    private suspend fun handleAttention(hostId: String, item: AttentionItem, live: Boolean) {
        android.util.Log.i("OmprAttn", "attention kind=${item.kind} resolved=${item.resolved} live=$live")
        settings.setLastSeenAttention(hostId, item.ts)
        if (item.resolved) {
            notifier.cancelAttention(hostId, item.id)
            return
        }
        notifier.showAttention(hostId, hostName(hostId), item)
    }

    /** `attention.list {since: lastSeen}` → notifications for anything the phone has not shown yet. */
    suspend fun syncAttention(conn: HostConnection) {
        val since = settings.lastSeenAttention(conn.hostId)
        val items = conn.attentionList(if (since > 0) since else null)
        if (since == 0L) {
            // First ever sync for this pairing: don't flood with history, just remember the high-water mark.
            settings.setLastSeenAttention(conn.hostId, items.maxOfOrNull { it.ts } ?: conn.info.value?.now ?: System.currentTimeMillis())
            for (it in items) if (it.resolved) notifier.cancelAttention(conn.hostId, it.id)
            return
        }
        for (item in items.sortedBy { it.ts }) {
            if (item.ts <= since && !item.resolved) continue
            handleAttention(conn.hostId, item, live = false)
        }
    }

    private suspend fun registerPush(conn: HostConnection) {
        if (!BuildConfig.PUSH_ENABLED) return
        if (conn.info.value?.push != true) return
        val token = PushTokens.current(context, settings) ?: return
        if (settings.pushRegisteredToken(conn.hostId) == token) return
        conn.pushRegister(token)
        settings.setPushRegisteredToken(conn.hostId, token)
    }

    /** Called when a new FCM token is issued: re-register with every host that is (or becomes) connected. */
    fun onPushTokenChanged() {
        scope.launch {
            for (c in conns.values) {
                if (c.isConnected) runCatching { registerPush(c) }
            }
        }
    }

    /**
     * FCM wake path: connect briefly, sync attention, notify, disconnect again (unless something else holds
     * the connection). Returns true when the sync completed.
     */
    suspend fun expeditedSync(hostId: String, timeoutMs: Long = 15_000): Boolean {
        if (repo.get(hostId) == null) return false
        val conn = get(hostId)
        val hold = conn.acquire()
        try {
            val ok = withTimeoutOrNull(timeoutMs) {
                conn.awaitConnected(timeoutMs)
                runCatching { syncAttention(conn) }.isSuccess
            }
            delay(300) // let the notification manager settle before the process may be frozen
            return ok == true
        } finally {
            hold.close()
        }
    }

    suspend fun allHostIds(): List<String> = repo.hosts.first().map { it.hostId }
}
