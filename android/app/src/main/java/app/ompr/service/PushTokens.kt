package app.ompr.service

import android.content.Context
import app.ompr.BuildConfig
import app.ompr.data.SettingsStore
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** FCM token access. Everything here is a no-op unless the build has `google-services.json` (PUSH_ENABLED). */
object PushTokens {
    /** True when this build can receive FCM pushes at all. */
    fun available(context: Context): Boolean =
        BuildConfig.PUSH_ENABLED && FirebaseApp.getApps(context).isNotEmpty()

    /** The current token (cached copy first, then asks Firebase). Null when push is unavailable. */
    suspend fun current(context: Context, settings: SettingsStore): String? {
        if (!available(context)) return null
        val cached = settings.fcmToken.first()
        return cached ?: fetch(context)?.also { settings.setFcmToken(it) }
    }

    suspend fun fetch(context: Context): String? {
        if (!available(context)) return null
        return suspendCancellableCoroutine { c ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                c.resume(if (t.isSuccessful) t.result else null)
            }
        }
    }
}
