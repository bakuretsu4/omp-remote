package app.ompr.net

import app.ompr.crypto.Crypto
import app.ompr.crypto.CryptoException
import app.ompr.crypto.FRAME_PAIR
import app.ompr.data.HostRecord
import app.ompr.data.HostRepository
import app.ompr.data.WireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.net.URLDecoder

/**
 * A parsed `ompr://pair?v=2&name=…&rid=…&bpk=…&pt=…&r=…` link (docs/PROTOCOL.md §4). Carries the one-time pairing token:
 * never log it. v2 carries only the derived room id — the room secret never reaches the phone.
 */
class PairingLink(
    val name: String,
    val roomId: String,
    val bpk: ByteArray,
    val pairingToken: ByteArray,
    val relays: List<String>,
) {
    val hostId: String get() = Crypto.hostIdOf(bpk)
    override fun toString(): String = "PairingLink($name)"

    /** Hosts of the relays, in order, for the confirmation screen. */
    val relayHosts: List<RelayHost>
        get() = relays.map { r ->
            val cleartext = r.trim().startsWith("ws://")
            val http = r.trim().replaceFirst("ws://", "http://").replaceFirst("wss://", "https://")
            RelayHost(http.toHttpUrlOrNull()?.let { u -> if (u.port == HttpUrl.defaultPort(u.scheme)) u.host else "${u.host}:${u.port}" } ?: r, cleartext)
        }

    class RelayHost(val host: String, val cleartext: Boolean)

    companion object {
        class ParseException(message: String) : Exception(message)

        private val ROOM_ID = Regex("[A-Za-z0-9_-]{22}")

        private fun decode(s: String): String = try {
            URLDecoder.decode(s, "UTF-8")
        } catch (e: IllegalArgumentException) {
            throw ParseException("The pairing link is malformed (bad escape sequence)")
        }

        /** @throws ParseException with a user-presentable message. */
        fun parse(text: String): PairingLink {
            val raw = text.trim().lineSequence().map { it.trim() }.firstOrNull { it.startsWith("ompr://") }
                ?: throw ParseException("Not an OMP Remote pairing link (expected ompr://pair?…)")
            val afterScheme = raw.removePrefix("ompr://")
            val host = afterScheme.substringBefore('?').trimEnd('/')
            if (host != "pair") throw ParseException("Not a pairing link")
            val query = afterScheme.substringAfter('?', "")
            val params = LinkedHashMap<String, MutableList<String>>()
            for (part in query.split('&')) {
                if (part.isEmpty()) continue
                val k = decode(part.substringBefore('='))
                val v = decode(part.substringAfter('=', ""))
                params.getOrPut(k) { mutableListOf() }.add(v)
            }
            val version = params["v"]?.firstOrNull()
            if (version == "1") throw ParseException("This pairing link is from an older bridge version and is no longer accepted. Update the bridge on your PC and run `ompr pair` again.")
            if (version != "2") throw ParseException("Unsupported pairing link version ${version ?: "?"}")
            if (params.containsKey("rs")) throw ParseException("The pairing link contains a room secret; refusing it. Update the bridge on your PC.")
            fun bytes(key: String, size: Int): ByteArray {
                val v = params[key]?.firstOrNull() ?: throw ParseException("Pairing link is missing '$key'")
                val b = try {
                    Crypto.unb64u(v)
                } catch (e: CryptoException) {
                    throw ParseException("Pairing link has a malformed '$key'")
                }
                if (b.size != size) throw ParseException("Pairing link has a malformed '$key'")
                return b
            }
            val rid = params["rid"]?.firstOrNull() ?: throw ParseException("Pairing link is missing 'rid'")
            if (!ROOM_ID.matches(rid)) throw ParseException("Pairing link has a malformed 'rid'")
            val bpk = bytes("bpk", 65)
            if (bpk[0].toInt() != 4) throw ParseException("Pairing link has a malformed 'bpk'")
            val pt = bytes("pt", 32)
            val relays = (params["r"] ?: emptyList()).map { it.trim() }.filter { it.isNotEmpty() }
            if (relays.isEmpty()) throw ParseException("Pairing link has no relay")
            val bad = relays.firstNotNullOfOrNull { r -> RelayUrls.validate(r)?.let { r to it } }
            if (bad != null) throw ParseException("Relay ${bad.first}: ${bad.second}")
            return PairingLink(params["name"]?.firstOrNull().orEmpty().trim().ifBlank { "My PC" }.take(64), rid, bpk, pt, relays.distinct())
        }
    }
}

class PairingDeniedException(val reason: String) : Exception(reason)

sealed interface PairPhase {
    data object Connecting : PairPhase

    /** pair-req sent. [sas] ("123 456") must equal the code the PC shows; the user has to compare them. */
    data class WaitingConfirm(val sas: String) : PairPhase
}

/** Outcome of a relay race. */
class Raced<T>(val relay: String, val value: T)

/**
 * Starts attempt 0 immediately; every [staggerMs] without a winner (or as soon as an attempt fails) starts the
 * next one. The first success wins and the others are cancelled. Values that finish late are passed to [dispose].
 * When every attempt fails the most informative error is thrown (fatal > no-answer > bridge-offline > first).
 */
suspend fun <T> raceRelays(
    relays: List<String>,
    staggerMs: Long = 1_500,
    dispose: (T) -> Unit,
    attempt: suspend (String) -> T,
): Raced<T> = coroutineScope {
    require(relays.isNotEmpty()) { "no relays" }
    val n = relays.size
    val results = Channel<Pair<String, Result<T>>>(Channel.UNLIMITED)
    val jobs = ArrayList<Job>()
    var started = 0
    val errors = ArrayList<Throwable>()
    fun startNext() {
        val url = relays[started++]
        jobs += launch {
            val r: Result<T> = try {
                Result.success(attempt(url))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                Result.failure(e)
            }
            results.trySend(url to r)
        }
    }
    var winner: Raced<T>? = null
    var failure: Throwable? = null
    try {
        startNext()
        while (winner == null && failure == null) {
            val r = if (started < n) withTimeoutOrNull(staggerMs) { results.receive() } else results.receive()
            if (r == null) {
                startNext()
                continue
            }
            val res = r.second
            if (res.isSuccess) {
                winner = Raced(r.first, res.getOrThrow())
            } else {
                errors += res.exceptionOrNull()!!
                if (errors.size == n) failure = pickBest(errors) else if (started < n) startNext()
            }
        }
    } finally {
        jobs.forEach { it.cancel() }
        jobs.joinAll()
        results.close()
        for ((_, r) in results) r.getOrNull()?.let { v -> if (v !== winner?.value) dispose(v) }
    }
    failure?.let { throw it }
    winner!!
}

private fun pickBest(errors: List<Throwable>): Throwable =
    errors.firstOrNull { it is FatalHandshakeException }
        ?: errors.firstOrNull { it is HandshakeTimeoutException }
        ?: errors.firstOrNull { it is RelayException && it.bridgeOffline }
        ?: errors.first()

class Pairing(private val client: OkHttpClient, private val repo: HostRepository) {
    /**
     * Runs the §4 pairing handshake and persists the host. The device private key exists only inside this call.
     * @throws PairingDeniedException the bridge refused (expired/used token, user said no)
     */
    suspend fun pair(
        link: PairingLink,
        deviceLabel: String,
        confirmTimeoutMs: Long = 120_000,
        onPhase: (PairPhase) -> Unit = {},
    ): HostRecord {
        val hostId = link.hostId
        val pairKey = Crypto.pairKeyFrom(link.pairingToken)
        val device = Crypto.generateKeypair()
        onPhase(PairPhase.Connecting)

        // Race only the socket (a duplicate pair-req on two relays would show two prompts on the PC).
        val raced = raceRelays(link.relays, dispose = { it.close() }) { url ->
            val l = RelayLink.open(client, url, link.roomId)
            // A relay accepts the upgrade and then closes 4004 if the bridge is not in the room.
            val early = withTimeoutOrNull(400) { l.closed.await() }
            if (early != null) {
                l.cancel()
                throw RelayException("bridge is not reachable via $url", early.code)
            }
            l
        }
        val relay = raced.value
        try {
            val req = buildJsonObject {
                put("t", "pair-req")
                put("dpk", Crypto.b64u(device.pub))
                put("label", deviceLabel)
                put("ts", System.currentTimeMillis())
            }
            val frame = byteArrayOf(FRAME_PAIR.toByte()) + Crypto.seal(pairKey, req.toString().toByteArray(Charsets.UTF_8), Crypto.aad(FRAME_PAIR, 'C'))
            if (!relay.send(frame)) throw RelayException("socket closed")
            onPhase(PairPhase.WaitingConfirm(Crypto.sasOf(link.pairingToken, device.pub, link.bpk)))

            val aadReply = Crypto.aad(FRAME_PAIR, 'B')
            var junk = 0
            val reply: JsonObject = try {
                withTimeout(confirmTimeoutMs) {
                    var found: JsonObject? = null
                    while (found == null) {
                        val p = relay.incoming.receiveCatching().getOrNull()
                            ?: throw RelayException("relay closed during pairing (${relay.closeInfo?.code ?: 0})", relay.closeInfo?.code ?: 0)
                        if (p.isEmpty() || p[0].toInt() != FRAME_PAIR) continue
                        try {
                            found = WireJson.parseToJsonElement(Crypto.open(pairKey, p.copyOfRange(1, p.size), aadReply).decodeToString()).jsonObject
                        } catch (e: Exception) {
                            if (++junk >= 5) throw PairingDeniedException("The reply could not be authenticated")
                        }
                    }
                    found
                }
            } catch (e: TimeoutCancellationException) {
                throw PairingDeniedException("No confirmation on the PC in time")
            }

            when (reply["t"]?.jsonPrimitive?.contentOrNull) {
                "pair-ok" -> Unit
                "pair-no" -> throw PairingDeniedException(reply["reason"]?.jsonPrimitive?.contentOrNull?.take(200) ?: "Pairing was refused")
                else -> throw PairingDeniedException("Unexpected pairing reply")
            }
            val did = Crypto.unb64u(reply["did"]?.jsonPrimitive?.contentOrNull ?: throw PairingDeniedException("Reply without device id"))
            if (did.size != 8) throw PairingDeniedException("Reply with a malformed device id")
            val replyHost = reply["hostId"]?.jsonPrimitive?.contentOrNull
            if (replyHost != null && replyHost != hostId) throw PairingDeniedException("Host identity does not match the pairing link")
            val name = reply["name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: link.name

            val shared = Crypto.ecdh(device.priv, link.bpk)
            val kDev = Crypto.deviceKeyFrom(shared, link.pairingToken)
            shared.fill(0)
            device.priv.fill(0)
            return repo.add(hostId, name, link.roomId, link.bpk, did, kDev, link.relays)
        } finally {
            relay.close()
        }
    }
}
