package app.ompr.net

import app.ompr.crypto.Crypto
import app.ompr.crypto.CryptoException
import app.ompr.crypto.FRAME_DATA
import app.ompr.crypto.FRAME_HELLO
import app.ompr.crypto.MAX_PLAINTEXT
import app.ompr.data.HostInfo
import app.ompr.data.HostRecord
import app.ompr.data.PROTO
import app.ompr.data.WireJson
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The handshake cannot succeed against this host: an AUTHENTICATED reply (sealed with `K_dev`) proved an identity or
 * protocol mismatch. Never thrown for unauthenticated bytes — anyone who can reach the room can send those.
 */
class FatalHandshakeException(message: String) : Exception(message)

/** Junk, unauthenticated or replayed frames from whoever holds the host seat. Recoverable: drop, back off, retry. */
class InvalidFramesException(message: String) : Exception(message)

/** The relay link is up but the bridge did not answer HELLO (offline, revoked device, or wrong relay). */
class HandshakeTimeoutException(message: String) : Exception(message)

class ChannelDeadException(message: String) : Exception(message)

const val APP_VERSION = "0.1.0"

/**
 * An authenticated, encrypted app↔bridge channel on top of a [RelayLink] (docs/PROTOCOL.md §5).
 * Owns the per-direction counters. Not thread-safe for [receive] (single reader); [send] is thread-safe.
 */
class SecureChannel private constructor(
    val link: PeerLink,
    private val kC2B: ByteArray,
    private val kB2C: ByteArray,
    val hostInfo: HostInfo,
    val relayUrl: String,
) {
    private var sendQ = 0L
    private var recvQ = 0L
    private var authFailures = 0
    private val aadC2B = Crypto.aad(FRAME_DATA, 'C')
    private val aadB2C = Crypto.aad(FRAME_DATA, 'B')
    private val sendLock = Any()

    @Volatile
    var lastSentAt: Long = System.currentTimeMillis()
        private set

    /** Time of the last valid frame from the bridge. */
    @Volatile
    var lastValidAt: Long = System.currentTimeMillis()
        private set

    /** Serialises `obj` with the next `q` as its first member, seals, sends. Throws if the frame would exceed 512 KiB. */
    fun send(obj: JsonObject) {
        synchronized(sendLock) {
            val q = ++sendQ
            val withQ = buildJsonObject {
                put("q", q)
                for ((k, v) in obj) put(k, v)
            }
            val plain = withQ.toString().toByteArray(Charsets.UTF_8)
            if (plain.size > MAX_PLAINTEXT) {
                sendQ-- // nothing was sent; keep the counter dense
                throw IllegalArgumentException("frame of ${plain.size} bytes exceeds the 512 KiB protocol limit")
            }
            val frame = byteArrayOf(FRAME_DATA.toByte()) + Crypto.seal(kC2B, plain, aadC2B)
            if (!link.send(frame)) throw ChannelDeadException("socket is closed")
            lastSentAt = System.currentTimeMillis()
        }
    }

    /**
     * Next valid message from the bridge, or null when the socket closed. Frames that fail authentication,
     * are not DATA, or replay/reorder `q` are dropped; the third failure kills the channel (§5.4).
     */
    suspend fun receive(): JsonObject? {
        while (true) {
            val payload = link.incoming.receiveCatching().getOrNull() ?: return null
            if (payload.isEmpty() || payload[0].toInt() != FRAME_DATA) {
                if (++authFailures >= 3) throw ChannelDeadException("too many invalid frames")
                continue
            }
            val obj = try {
                val plain = Crypto.open(kB2C, payload.copyOfRange(1, payload.size), aadB2C)
                WireJson.parseToJsonElement(plain.decodeToString()).jsonObject
            } catch (e: Exception) {
                if (++authFailures >= 3) throw ChannelDeadException("too many invalid frames")
                continue
            }
            val q = obj["q"]?.jsonPrimitive?.longOrNull
            if (q == null || q <= recvQ) {
                if (++authFailures >= 3) throw ChannelDeadException("replayed or out-of-order frames")
                continue
            }
            recvQ = q
            lastValidAt = System.currentTimeMillis()
            return obj
        }
    }

    fun close() = link.close()

    companion object {
        /**
         * Runs the HELLO exchange on an open link (§5.1–5.3). The caller owns `link` and closes it on failure.
         * @throws FatalHandshakeException identity/protocol mismatch
         * @throws HandshakeTimeoutException the bridge never answered
         */
        suspend fun handshake(
            link: PeerLink,
            host: HostRecord,
            deviceLabel: String,
            deviceCaps: List<String>,
            timeoutMs: Long = 10_000,
        ): SecureChannel {
            val eph = Crypto.generateKeypair()
            val nonceA = Crypto.randomBytes(16)
            val hello = buildJsonObject {
                put("t", "hello")
                put("eph", Crypto.b64u(eph.pub))
                put("n", Crypto.b64u(nonceA))
                put("ts", System.currentTimeMillis())
                put("caps", JsonArray(deviceCaps.map { JsonPrimitive(it) }))
                put("app", APP_VERSION)
                put("label", deviceLabel)
            }
            val sealed = Crypto.seal(host.kDev, hello.toString().toByteArray(Charsets.UTF_8), Crypto.aad(FRAME_HELLO, 'C', host.did))
            val frame = byteArrayOf(FRAME_HELLO.toByte()) + host.did + sealed
            if (!link.send(frame)) throw RelayException("socket closed before HELLO")

            val aadReply = Crypto.aad(FRAME_HELLO, 'B')
            var junk = 0
            val reply: JsonObject = try {
                withTimeout(timeoutMs) {
                    var found: JsonObject? = null
                    while (found == null) {
                        val payload = link.incoming.receiveCatching().getOrNull()
                            ?: throw RelayException(
                                "relay closed (${link.closeInfo?.code ?: 0})",
                                link.closeInfo?.code ?: 0,
                            )
                        if (payload.isEmpty() || payload[0].toInt() != FRAME_HELLO) {
                            if (++junk >= 5) throw InvalidFramesException("unexpected frames during handshake")
                            continue
                        }
                        try {
                            val plain = Crypto.open(host.kDev, payload.copyOfRange(1, payload.size), aadReply)
                            found = WireJson.parseToJsonElement(plain.decodeToString()).jsonObject
                        } catch (e: CryptoException) {
                            if (++junk >= 5) throw InvalidFramesException("bridge failed to authenticate")
                        }
                    }
                    found
                }
            } catch (e: TimeoutCancellationException) {
                throw HandshakeTimeoutException("no answer from the bridge")
            }

            if (reply["t"]?.jsonPrimitive?.contentOrNull != "hello-ok") throw FatalHandshakeException("unexpected handshake reply")
            val info = WireJson.decodeFromJsonElement(HostInfo.serializer(), reply["host"] ?: throw FatalHandshakeException("hello-ok without host info"))
            if (info.proto != PROTO) throw FatalHandshakeException("Bridge speaks protocol ${info.proto}; this app needs $PROTO. Update the app or the bridge.")
            if (info.hostId != host.hostId) throw FatalHandshakeException("Host identity changed (${info.hostId}); pair again.")

            val ephB = Crypto.unb64u(reply["eph"]?.jsonPrimitive?.contentOrNull ?: throw FatalHandshakeException("hello-ok without eph"))
            val nonceB = Crypto.unb64u(reply["n"]?.jsonPrimitive?.contentOrNull ?: throw FatalHandshakeException("hello-ok without nonce"))
            val shared = try {
                Crypto.ecdh(eph.priv, ephB)
            } catch (e: CryptoException) {
                throw FatalHandshakeException("bridge sent an invalid ephemeral key")
            }
            val keys = Crypto.sessionKeys(shared, host.kDev, nonceA, nonceB)
            return SecureChannel(link, keys.c2b, keys.b2c, info, link.url)
        }
    }
}
