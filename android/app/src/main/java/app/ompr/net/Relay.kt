package app.ompr.net

import app.ompr.crypto.Crypto
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit

class RelayException(
    message: String,
    /** WebSocket close code when the relay (or the OS) closed us, else 0. */
    val closeCode: Int = 0,
    cause: Throwable? = null,
) : Exception(message, cause) {
    /** The relay is fine but the bridge is not in this room (L0: guest to a missing room → 4004). */
    val bridgeOffline: Boolean get() = closeCode == 4004
}

class CloseInfo(val code: Int, val reason: String, val error: Throwable?)

/** One guest connection to a relay room: payload frames in/out (the 4-byte peer id is handled below this). */
interface PeerLink {
    val url: String
    val incoming: ReceiveChannel<ByteArray>
    val closeInfo: CloseInfo?
    fun send(payload: ByteArray): Boolean
    fun close(code: Int = 1000, reason: String = "")
}

object RelayUrls {
    /**
     * `ws://` is accepted only when the host is an IP literal in a private range (loopback, RFC1918, link-local,
     * CGNAT/Tailscale, IPv6 ULA / link-local) or the emulator alias 10.0.2.2. Host names never qualify — not even
     * `.local` / `.lan` / `.ts.net`, which anyone on a network can claim — so those need `wss://`. Android's network
     * security config cannot express CIDR ranges, so this check is the cleartext policy.
     */
    fun validate(url: String): String? {
        val trimmed = url.trim()
        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) return "Relay URL must start with ws:// or wss://"
        val http = trimmed.replaceFirst("ws://", "http://").replaceFirst("wss://", "https://")
        val parsed: HttpUrl = http.toHttpUrlOrNull() ?: return "Not a valid URL"
        if (trimmed.startsWith("ws://") && !isPrivateHost(parsed.host)) {
            return "Plain ws:// is only allowed for private IP addresses (e.g. 192.168.x.x); use wss:// for everything else"
        }
        return null
    }

    private val IPV4 = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""")
    private val IPV6_CHARS = Regex("""[0-9a-f:.]+""")

    /** Strict IPv4 dotted quad: four decimal octets 0..255, no leading zeros (octal ambiguity). */
    private fun parseV4(h: String): IntArray? {
        val m = IPV4.matchEntire(h) ?: return null
        val o = IntArray(4)
        for (i in 0..3) {
            val part = m.groupValues[i + 1]
            if (part.length > 1 && part[0] == '0') return null
            o[i] = part.toInt()
            if (o[i] > 255) return null
        }
        return o
    }

    fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h == "10.0.2.2") return true
        parseV4(h)?.let { o ->
            return when {
                o[0] == 127 -> true
                o[0] == 10 -> true
                o[0] == 172 && o[1] in 16..31 -> true
                o[0] == 192 && o[1] == 168 -> true
                o[0] == 169 && o[1] == 254 -> true
                o[0] == 100 && o[1] in 64..127 -> true
                else -> false
            }
        }
        // IPv6 literals only (never resolves names).
        if (!h.contains(':') || !IPV6_CHARS.matches(h)) return false
        val addr = runCatching { InetAddress.getByName(h) }.getOrNull() ?: return false
        val b = addr.address
        if (addr is Inet4Address) return isPrivateHost(addr.hostAddress.orEmpty())
        return addr.isLoopbackAddress || addr.isLinkLocalAddress || (b[0].toInt() and 0xfe) == 0xfc
    }

    /** `<base>/r/<roomId>?role=guest`, keeping any path prefix of the base URL. */
    fun roomUrl(base: String, roomId: String): String {
        val b = base.trim().trimEnd('/')
        return "$b/r/$roomId?role=guest"
    }

    /** True when the relay is on a private/LAN address (used to label the link as "LAN"). */
    fun isLan(base: String): Boolean {
        val http = base.replaceFirst("ws://", "http://").replaceFirst("wss://", "https://")
        val host = http.toHttpUrlOrNull()?.host ?: return false
        return isPrivateHost(host)
    }
}

/**
 * One guest WebSocket to a relay room. Frames are `[4B peerId][payload]` (docs/PROTOCOL.md §2); `incoming`
 * yields payloads only. The relay overwrites the peer id for guest→host frames, so we always send 0.
 */
class RelayLink private constructor(override val url: String) : WebSocketListener(), PeerLink {
    private val inbox = Channel<ByteArray>(Channel.UNLIMITED)
    override val incoming: ReceiveChannel<ByteArray> get() = inbox
    val closed = CompletableDeferred<CloseInfo>()
    private val opened = CompletableDeferred<Unit>()
    private lateinit var ws: WebSocket

    @Volatile
    var lastReceiveAt: Long = System.currentTimeMillis()
        private set

    override fun send(payload: ByteArray): Boolean = ws.send(Crypto.packEnvelope(0, payload).toByteString())

    override fun close(code: Int, reason: String) {
        runCatching { ws.close(code, reason) }
        finish(CloseInfo(code, reason, null))
    }

    fun cancel() {
        runCatching { ws.cancel() }
        finish(CloseInfo(1006, "cancelled", null))
    }

    @Volatile
    override var closeInfo: CloseInfo? = null
        private set

    private fun finish(info: CloseInfo) {
        if (closeInfo == null) closeInfo = info
        closed.complete(info)
        inbox.close()
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        opened.complete(Unit)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        lastReceiveAt = System.currentTimeMillis()
        val env = Crypto.unpackEnvelope(bytes.toByteArray()) ?: return
        inbox.trySend(env.payload)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        lastReceiveAt = System.currentTimeMillis()
        // Relay control frames. Only `room-closed` matters to a guest: the bridge left.
        if (text.contains("room-closed")) finish(CloseInfo(4001, "room-closed", null))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        runCatching { webSocket.close(code, reason) }
        if (!opened.isCompleted) {
            opened.completeExceptionally(RelayException("closed ($code) ${reason}".trim(), code))
        }
        finish(CloseInfo(code, reason, null))
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (!opened.isCompleted) opened.completeExceptionally(RelayException("closed ($code)", code))
        finish(CloseInfo(code, reason, null))
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        val code = response?.code ?: 0
        val msg = when {
            response != null -> "relay answered HTTP ${response.code}"
            else -> t.message ?: t.javaClass.simpleName
        }
        if (!opened.isCompleted) opened.completeExceptionally(RelayException(msg, 0, t))
        finish(CloseInfo(1006, msg, t))
    }

    companion object {
        /**
         * Opens `<base>/r/<roomId>?role=guest`. Throws [RelayException] on failure. The returned link is already
         * open; if the relay closes it immediately (e.g. 4004, bridge offline) `closed` completes right after.
         */
        suspend fun open(client: OkHttpClient, base: String, roomId: String, openTimeoutMs: Long = 8_000): RelayLink {
            RelayUrls.validate(base)?.let { throw RelayException("$base: $it") }
            val link = RelayLink(base)
            val req = Request.Builder().url(RelayUrls.roomUrl(base, roomId)).build()
            val socket = client.newWebSocket(req, link)
            link.ws = socket
            try {
                withTimeout(openTimeoutMs) { link.opened.await() }
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                link.cancel()
                throw RelayException("timed out connecting to $base")
            } catch (e: Throwable) {
                link.cancel()
                throw e
            }
            return link
        }
    }
}

object Http {
    /** Shared client: no read timeout (long-lived sockets), transport pings keep NAT mappings alive. */
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
