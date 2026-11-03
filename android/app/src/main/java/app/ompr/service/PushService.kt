package app.ompr.service

import app.ompr.OmprApp
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking

/**
 * FCM wake-ups. The bridge sends a content-free data message `{w:"1", h:"<hostId>"}` (docs/PROTOCOL.md §6.4).
 * We connect briefly, call `attention.list {since: lastSeen}` and post local notifications from the decrypted items.
 * Only active when the app was built with `app/google-services.json` (see docs/ANDROID.md).
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val graph = (application as OmprApp).graph
        runBlocking {
            graph.settings.setFcmToken(token)
        }
        graph.connections.onPushTokenChanged()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["w"] != "1") return
        val graph = (application as OmprApp).graph
        // FCM gives high-priority messages ~20 s; stay inside that.
        runBlocking {
            graph.awaitReady()
            val h = message.data["h"]
            val ids = if (h.isNullOrEmpty()) graph.connections.allHostIds() else listOf(h)
            for (id in ids) graph.connections.expeditedSync(id, 12_000)
        }
    }
}
