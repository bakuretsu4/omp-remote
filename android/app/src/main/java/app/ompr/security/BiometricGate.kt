package app.ompr.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.ompr.R
import app.ompr.data.SettingsStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Optional biometric / device-credential lock (Settings → Biometric lock). It gates (1) opening the app after it
 * was in the background for [RELOCK_MS], and (2) every approval that lets the agent run something
 * ([guard]). Deny/cancel never needs it. This is an app-level gate; the paired key material itself is wrapped by a
 * hardware-backed Keystore key (see KeystoreSecretBox).
 */
class BiometricGate(private val settings: SettingsStore) {
    private val _unlocked = MutableStateFlow(false)

    /** True once the user authenticated since the app (re)started or last re-locked. */
    val unlocked: StateFlow<Boolean> = _unlocked.asStateFlow()

    @Volatile
    private var lastAuthAt = 0L

    @Volatile
    private var backgroundedAt = 0L

    /** Strong biometrics or the screen lock; API 28/29 cannot combine STRONG with DEVICE_CREDENTIAL. */
    private val authenticators = Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL

    fun isAvailable(context: Context): Boolean =
        BiometricManager.from(context).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS

    fun onAppStopped() {
        backgroundedAt = System.currentTimeMillis()
    }

    /** Called from the process lifecycle ON_START. Re-locks when the app was away long enough. */
    suspend fun onAppStarted() {
        if (!settings.isBiometricLock()) {
            _unlocked.value = true
            return
        }
        if (backgroundedAt != 0L && System.currentTimeMillis() - backgroundedAt > RELOCK_MS) _unlocked.value = false
    }

    /** Applies the setting at process start: locked when enabled. */
    suspend fun initialise() {
        _unlocked.value = !settings.isBiometricLock()
    }

    /** Shows the system prompt. Returns true on success. */
    suspend fun authenticate(activity: FragmentActivity, title: String, subtitle: String? = null): Boolean {
        if (!isAvailable(activity)) return false
        return suspendCancellableCoroutine { c ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    lastAuthAt = System.currentTimeMillis()
                    if (c.isActive) c.resume(true)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (c.isActive) c.resume(false)
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .apply { if (subtitle != null) setSubtitle(subtitle) }
                .setAllowedAuthenticators(authenticators)
                .build()
            prompt.authenticate(info)
            c.invokeOnCancellation { runCatching { prompt.cancelAuthentication() } }
        }
    }

    /** Unlock screen: authenticates and flips [unlocked]. */
    suspend fun unlock(activity: FragmentActivity): Boolean {
        val ok = authenticate(activity, activity.getString(R.string.unlock_title))
        if (ok) _unlocked.value = true
        return ok
    }

    /**
     * Call before sending anything that authorises the agent to act (approve / approve-for-session). Returns true
     * when allowed: lock disabled, authenticated within the last [GRACE_MS], or the prompt succeeded.
     */
    suspend fun guard(activity: FragmentActivity, reason: String): Boolean {
        if (!settings.isBiometricLock()) return true
        if (System.currentTimeMillis() - lastAuthAt < GRACE_MS) return true
        // A lock is configured but the device has no enrolled credential any more: fail closed.
        return authenticate(activity, activity.getString(R.string.approve_auth_title), reason)
    }

    companion object {
        const val RELOCK_MS = 30_000L
        const val GRACE_MS = 20_000L
    }
}
