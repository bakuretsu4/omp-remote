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
    private fun hostToolKey(tool: String) = stringPreferencesKey("hosttool_mode_$tool")

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

    private val upEnabledKey = booleanPreferencesKey("unifiedpush_enabled")
    private val upEndpointKey = stringPreferencesKey("unifiedpush_endpoint")
    private val upErrorKey = stringPreferencesKey("unifiedpush_error")

    /** The user chose UnifiedPush for wake pushes (needs a distributor app such as ntfy). */
    val unifiedPushEnabled: Flow<Boolean> = store.data.map { it[upEnabledKey] ?: false }
    /** The URL the distributor gave us; PCs POST content-free wakes to it. Null until the distributor answers. */
    val unifiedPushEndpoint: Flow<String?> = store.data.map { it[upEndpointKey] }
    /** Why the distributor refused the last registration (a FailedReason name), for the settings screen. */
    val unifiedPushError: Flow<String?> = store.data.map { it[upErrorKey] }
    suspend fun setUnifiedPushEnabled(v: Boolean) = store.edit { it[upEnabledKey] = v }.let { }
    suspend fun setUnifiedPushEndpoint(v: String?) = store.edit { if (v == null) it.remove(upEndpointKey) else it[upEndpointKey] = v }.let { }
    suspend fun setUnifiedPushError(v: String?) = store.edit { if (v == null) it.remove(upErrorKey) else it[upErrorKey] = v }.let { }

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

    /** Per-tool mode for phone tools (Off / Ask / Allow). Every tool is Off until the user chooses. */
    fun hostToolMode(tool: String): Flow<ToolMode> = store.data.map { ToolMode.parse(it[hostToolKey(tool)]) }
    val hostToolModes: Flow<Map<String, ToolMode>> =
        store.data.map { p -> PhoneTools.all.associate { it.id to ToolMode.parse(p[hostToolKey(it.id)]) } }
    suspend fun getHostToolMode(tool: String): ToolMode = hostToolMode(tool).first()
    suspend fun setHostToolMode(tool: String, mode: ToolMode) = store.edit { it[hostToolKey(tool)] = mode.id }.let { }

    suspend fun clearHost(hostId: String) = store.edit {
        it.remove(lastSeenKey(hostId))
        it.remove(pushRegKey(hostId))
    }.let { }
}
