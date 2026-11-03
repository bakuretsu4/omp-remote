package app.ompr.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** App-wide settings (DataStore). Every setter is a suspend fn; every value has a Flow. */
class SettingsStore(context: Context) {
    private val store = context.applicationContext.ompDataStore

    private val keepConnectedKey = booleanPreferencesKey("keep_connected")
    private val biometricKey = booleanPreferencesKey("biometric_lock")
    private val fcmTokenKey = stringPreferencesKey("fcm_token")
    private val hideInRecentsKey = booleanPreferencesKey("hide_in_recents")
    private val defaultApprovalKey = stringPreferencesKey("default_approval_mode")

    private fun notifyKey(kind: String) = booleanPreferencesKey("notify_$kind")
    private fun lastSeenKey(hostId: String) = longPreferencesKey("attn_last_seen_$hostId")
    private fun pushRegKey(hostId: String) = stringPreferencesKey("push_reg_$hostId")
    private fun hostToolKey(tool: String) = booleanPreferencesKey("hosttool_$tool")

    val keepConnected: Flow<Boolean> = store.data.map { it[keepConnectedKey] ?: false }
    val biometricLock: Flow<Boolean> = store.data.map { it[biometricKey] ?: false }
    val fcmToken: Flow<String?> = store.data.map { it[fcmTokenKey] }
    val defaultApprovalMode: Flow<String> = store.data.map { it[defaultApprovalKey] ?: ApprovalModes.ALWAYS_ASK }

    /** Sets FLAG_SECURE: blank recents thumbnail, no screenshots / screen sharing of the app. Default ON. */
    val hideInRecents: Flow<Boolean> = store.data.map { it[hideInRecentsKey] ?: true }
    suspend fun setHideInRecents(v: Boolean) = store.edit { it[hideInRecentsKey] = v }.let { }

    fun notifyEnabled(kind: String): Flow<Boolean> = store.data.map { it[notifyKey(kind)] ?: true }

    suspend fun isNotifyEnabled(kind: String): Boolean = notifyEnabled(kind).first()
    suspend fun isKeepConnected(): Boolean = keepConnected.first()
    suspend fun isBiometricLock(): Boolean = biometricLock.first()

    suspend fun setKeepConnected(v: Boolean) = store.edit { it[keepConnectedKey] = v }.let { }
    suspend fun setBiometricLock(v: Boolean) = store.edit { it[biometricKey] = v }.let { }
    suspend fun setNotifyEnabled(kind: String, v: Boolean) = store.edit { it[notifyKey(kind)] = v }.let { }
    suspend fun setFcmToken(t: String?) = store.edit { if (t == null) it.remove(fcmTokenKey) else it[fcmTokenKey] = t }.let { }
    suspend fun setDefaultApprovalMode(m: String) = store.edit { it[defaultApprovalKey] = m }.let { }

    /** Timestamp (host clock, ms) of the newest attention item already turned into a notification. */
    suspend fun lastSeenAttention(hostId: String): Long = store.data.first()[lastSeenKey(hostId)] ?: 0L
    suspend fun setLastSeenAttention(hostId: String, ts: Long) = store.edit {
        val cur = it[lastSeenKey(hostId)] ?: 0L
        if (ts > cur) it[lastSeenKey(hostId)] = ts
    }.let { }

    /** FCM token last registered with this host (to avoid re-registering on every connect). */
    suspend fun pushRegisteredToken(hostId: String): String? = store.data.first()[pushRegKey(hostId)]
    suspend fun setPushRegisteredToken(hostId: String, token: String?) = store.edit {
        if (token == null) it.remove(pushRegKey(hostId)) else it[pushRegKey(hostId)] = token
    }.let { }

    /** Per-tool on-device toggle for phone tools (wave 2; default off). */
    fun hostToolEnabled(tool: String): Flow<Boolean> = store.data.map { it[hostToolKey(tool)] ?: false }
    suspend fun setHostToolEnabled(tool: String, v: Boolean) = store.edit { it[hostToolKey(tool)] = v }.let { }

    suspend fun clearHost(hostId: String) = store.edit {
        it.remove(lastSeenKey(hostId))
        it.remove(pushRegKey(hostId))
    }.let { }
}
