package app.ompr.service

import app.ompr.data.HostInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** How a PC should wake this phone (docs/PROTOCOL.md section 6.4). */
sealed interface PushChoice {
    /** Stored per host so the app does not re-register on every connect; changes when the token or endpoint does. */
    val key: String

    data class Fcm(val token: String) : PushChoice {
        override val key get() = "fcm:$token"
    }

    data class UnifiedPush(val endpoint: String) : PushChoice {
        override val key get() = "up:$endpoint"
    }
}

/** A parsed wake. `hostId` is null when the payload names no PC: sync with all of them. */
data class Wake(val hostId: String?)

object PushRouting {
    const val FEATURE_UNIFIEDPUSH = "unifiedpush"

    /**
     * What to register with [host]: UnifiedPush when the user turned it on, the distributor gave us an endpoint and the PC
     * supports it; otherwise FCM when this build has a token and the PC can send FCM; otherwise nothing.
     */
    fun choose(host: HostInfo?, unifiedPushOn: Boolean, endpoint: String?, fcmToken: String?): PushChoice? {
        if (host == null) return null
        if (unifiedPushOn && !endpoint.isNullOrEmpty() && host.features?.contains(FEATURE_UNIFIEDPUSH) == true) {
            return PushChoice.UnifiedPush(endpoint)
        }
        if (host.push && !fcmToken.isNullOrEmpty()) return PushChoice.Fcm(fcmToken)
        return null
    }

    /**
     * Reads a wake payload `{"w":"1","h":"<hostId>"}`. Anything else (a distributor's test message, junk from someone who
     * learned the endpoint) is not a wake and returns null, so it never costs a sync.
     */
    fun parseWake(payload: ByteArray): Wake? {
        if (payload.isEmpty() || payload.size > 1024) return null
        val obj = runCatching { Json.parseToJsonElement(payload.decodeToString()).jsonObject }.getOrNull() ?: return null
        if (obj["w"]?.jsonPrimitive?.contentOrNull != "1") return null
        return Wake(obj["h"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 64 })
    }
}
