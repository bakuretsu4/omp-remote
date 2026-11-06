package app.ompr.service

import android.os.PowerManager
import android.util.Log
import app.ompr.OmprApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.util.concurrent.atomic.AtomicLong

/**
 * UnifiedPush wakes. The bridge posts a content-free `{w:"1", h:"<hostId>"}` to the endpoint the distributor (ntfy, ...)
 * gave us; like the FCM path we then connect briefly, read `attention.list` and post local notifications from the
 * decrypted items. Nothing about a session ever travels through the push server.
 */
class UnifiedPushService : PushService() {
    private val graph get() = (application as OmprApp).graph

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        graph.scope.launch {
            graph.settings.setUnifiedPushEndpoint(endpoint.url)
            graph.settings.setUnifiedPushError(null)
            // Register the new endpoint with every PC that is connected; the others pick it up when they connect.
            graph.connections.onPushTokenChanged()
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val wake = PushRouting.parseWake(message.content) ?: return
        val now = System.currentTimeMillis()
        val last = lastWakeAt.get()
        if (now - last < MIN_WAKE_GAP_MS || !lastWakeAt.compareAndSet(last, now)) return

        // The distributor only holds a wake lock while this callback runs, and the sync below takes seconds.
        val lock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ompr:push-wake").apply {
            setReferenceCounted(false)
            acquire(WAKE_LOCK_MS)
        }
        graph.scope.launch(Dispatchers.IO) {
            try {
                graph.awaitReady()
                val ids = wake.hostId?.let { listOf(it) } ?: graph.connections.allHostIds()
                for (id in ids) graph.connections.expeditedSync(id, SYNC_TIMEOUT_MS)
            } finally {
                if (lock.isHeld) lock.release()
            }
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "registration failed: $reason")
        graph.scope.launch { graph.settings.setUnifiedPushError(reason.name) }
    }

    override fun onUnregistered(instance: String) {
        graph.scope.launch {
            graph.settings.setUnifiedPushEndpoint(null)
            graph.settings.setUnifiedPushEnabled(false)
            graph.connections.onPushTokenChanged() // tells the connected PCs to forget this phone's endpoint
        }
    }

    private companion object {
        const val TAG = "OmprPush"
        const val MIN_WAKE_GAP_MS = 3_000L
        const val SYNC_TIMEOUT_MS = 12_000L
        const val WAKE_LOCK_MS = 20_000L
        val lastWakeAt = AtomicLong(0)
    }
}
