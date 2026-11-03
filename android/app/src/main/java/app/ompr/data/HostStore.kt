package app.ompr.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.ompr.crypto.Crypto
import app.ompr.crypto.SecretBox
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * A paired host. `K_dev` is plaintext only in memory; at rest it is wrapped by the Android Keystore. The phone never
 * holds the relay room secret (pairing link v2 carries only the derived room id), so a stolen phone image cannot
 * be used to impersonate the bridge's room.
 */
class HostRecord(
    val hostId: String,
    val name: String,
    /** 22-char relay room id (from the pairing link). */
    val roomId: String,
    /** Bridge public key, 65 bytes. */
    val bpk: ByteArray,
    /** Device id, 8 bytes. */
    val did: ByteArray,
    /** Root device key K_dev (32 bytes). */
    val kDev: ByteArray,
    /** Relay base URLs in order of preference (`ws://…` / `wss://…`). */
    val relays: List<String>,
    val pairedAt: Long,
) {
    fun copy(name: String = this.name, relays: List<String> = this.relays) =
        HostRecord(hostId, name, roomId, bpk, did, kDev, relays, pairedAt)

    override fun toString(): String = "HostRecord($hostId, $name)"
}

@Serializable
private data class StoredHost(
    val hostId: String,
    val name: String,
    val roomId: String,
    val bpk: String,
    val did: String,
    val kDevW: String,
    val relays: List<String>,
    val pairedAt: Long,
)

@Serializable
private data class StoredHosts(val hosts: List<StoredHost> = emptyList())

internal val Context.ompDataStore: DataStore<Preferences> by preferencesDataStore(name = "ompr")

/**
 * Paired hosts. Persisted as a JSON blob in DataStore; `K_dev` is wrapped
 * (AES-256-GCM, Android Keystore key) with the host id bound as AAD.
 *
 * The per-host device private key is deliberately NOT stored: it is used once to derive `K_dev`
 * during pairing and discarded, so a stolen device image never contains it.
 */
class HostRepository(context: Context, private val box: SecretBox) {
    private val store = context.applicationContext.ompDataStore
    private val key = stringPreferencesKey("hosts")
    private val _hosts = MutableStateFlow<List<HostRecord>>(emptyList())
    val hosts: StateFlow<List<HostRecord>> = _hosts
    private val lock = Any()

    @Volatile
    var loaded = false
        private set

    suspend fun load() {
        val raw = store.data.first()[key]
        // A store written by an older build (room secret instead of room id) fails to decode: pairings are dropped.
        val list = if (raw.isNullOrEmpty()) emptyList() else runCatching {
            WireJson.decodeFromString<StoredHosts>(raw).hosts.mapNotNull { runCatching { decode(it) }.getOrNull() }
        }.getOrDefault(emptyList())
        synchronized(lock) { _hosts.value = list }
        loaded = true
    }

    fun get(hostId: String): HostRecord? = _hosts.value.firstOrNull { it.hostId == hostId }

    suspend fun add(
        hostId: String, name: String, roomId: String, bpk: ByteArray, did: ByteArray,
        kDev: ByteArray, relays: List<String>,
    ): HostRecord {
        val rec = HostRecord(hostId, name, roomId, bpk, did, kDev, relays, System.currentTimeMillis())
        val stored = StoredHost(
            hostId, name,
            roomId,
            Crypto.b64u(bpk), Crypto.b64u(did),
            Crypto.b64u(box.wrap(kDev, "kdev:$hostId")),
            relays, rec.pairedAt,
        )
        persist { stored.hostId to stored }
        synchronized(lock) { _hosts.value = _hosts.value.filter { it.hostId != hostId } + rec }
        return rec
    }

    suspend fun update(hostId: String, name: String? = null, relays: List<String>? = null) {
        val cur = get(hostId) ?: return
        val next = cur.copy(name = name ?: cur.name, relays = relays ?: cur.relays)
        store.edit { p ->
            val stored = decodeAll(p[key]).map {
                if (it.hostId == hostId) it.copy(name = next.name, relays = next.relays) else it
            }
            p[key] = WireJson.encodeToString(StoredHosts(stored))
        }
        synchronized(lock) { _hosts.value = _hosts.value.map { if (it.hostId == hostId) next else it } }
    }

    suspend fun remove(hostId: String) {
        store.edit { p ->
            p[key] = WireJson.encodeToString(StoredHosts(decodeAll(p[key]).filter { it.hostId != hostId }))
        }
        synchronized(lock) { _hosts.value = _hosts.value.filter { it.hostId != hostId } }
    }

    private suspend fun persist(entry: () -> Pair<String, StoredHost>) {
        val (id, stored) = entry()
        store.edit { p ->
            val all = decodeAll(p[key]).filter { it.hostId != id } + stored
            p[key] = WireJson.encodeToString(StoredHosts(all))
        }
    }

    private fun decodeAll(raw: String?): List<StoredHost> =
        if (raw.isNullOrEmpty()) emptyList() else runCatching { WireJson.decodeFromString<StoredHosts>(raw).hosts }.getOrDefault(emptyList())

    private fun decode(s: StoredHost): HostRecord {
        return HostRecord(
            s.hostId, s.name, s.roomId, Crypto.unb64u(s.bpk), Crypto.unb64u(s.did),
            box.unwrap(Crypto.unb64u(s.kDevW), "kdev:${s.hostId}"), s.relays, s.pairedAt,
        )
    }
}
