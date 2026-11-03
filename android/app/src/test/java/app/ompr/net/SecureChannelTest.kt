package app.ompr.net

import app.ompr.crypto.Crypto
import app.ompr.crypto.FRAME_DATA
import app.ompr.crypto.FRAME_HELLO
import app.ompr.data.HostRecord
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private class FakeLink(override val url: String = "ws://10.0.2.2:7470") : PeerLink {
    val inbox = Channel<ByteArray>(Channel.UNLIMITED)
    override val incoming: ReceiveChannel<ByteArray> get() = inbox
    override var closeInfo: CloseInfo? = null
    val sent = java.util.concurrent.CopyOnWriteArrayList<ByteArray>()
    override fun send(payload: ByteArray): Boolean = sent.add(payload)
    override fun close(code: Int, reason: String) {
        inbox.close()
    }
}

/** Plays the bridge side of docs/PROTOCOL.md §5 against [SecureChannel.handshake]. */
class SecureChannelTest {
    private val bridge = Crypto.generateKeypair()
    private val did = Crypto.randomBytes(8)
    private val kDev = Crypto.randomBytes(32)
    private val hostId = Crypto.hostIdOf(bridge.pub)
    private val host = HostRecord(hostId, "Test", "dYrTkwxXLhxhf8LvgO5_Qn", bridge.pub, did, kDev, listOf("ws://10.0.2.2:7470"), 0)

    private fun obj(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun start(link: FakeLink, timeoutMs: Long = 5_000): CompletableDeferred<SecureChannel> {
        val d = CompletableDeferred<SecureChannel>()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                d.complete(SecureChannel.handshake(link, host, "Test phone", emptyList(), timeoutMs))
            } catch (e: Throwable) {
                d.completeExceptionally(e)
            }
        }
        return d
    }

    private suspend fun awaitHello(link: FakeLink): Pair<ByteArray, ByteArray> {
        withTimeout(3_000) { while (link.sent.isEmpty()) delay(5) }
        val hello = link.sent[0]
        assertEquals(FRAME_HELLO, hello[0].toInt())
        assertTrue(hello.copyOfRange(1, 9).contentEquals(did))
        val h = obj(Crypto.open(kDev, hello.copyOfRange(9, hello.size), Crypto.aad(FRAME_HELLO, 'C', did)).decodeToString())
        return Crypto.unb64u(h["eph"]!!.jsonPrimitive.content) to Crypto.unb64u(h["n"]!!.jsonPrimitive.content)
    }

    private fun helloOk(ephB: ByteArray, nonceB: ByteArray, hostIdInReply: String, proto: Int = 1): ByteArray {
        val reply = """{"t":"hello-ok","eph":"${Crypto.b64u(ephB)}","n":"${Crypto.b64u(nonceB)}","host":{"proto":$proto,"hostId":"$hostIdInReply","name":"Test"}}"""
        return byteArrayOf(FRAME_HELLO.toByte()) + Crypto.seal(kDev, reply.toByteArray(), Crypto.aad(FRAME_HELLO, 'B'))
    }

    private class Session(val channel: SecureChannel, val link: FakeLink, private val key: ByteArray) {
        private var q = 0L

        /** An authentic bridge→app DATA frame (also returned, so tests can replay it). */
        fun frame(json: String): ByteArray {
            q++
            val body = """{"q":$q,${json.trim().removePrefix("{")}"""
            return byteArrayOf(FRAME_DATA.toByte()) + Crypto.seal(key, body.toByteArray(), Crypto.aad(FRAME_DATA, 'B'))
        }
    }

    private fun connect(): Session = runBlocking {
        val link = FakeLink()
        val d = start(link)
        val (ephA, nonceA) = awaitHello(link)
        val ephB = Crypto.generateKeypair()
        val nonceB = Crypto.randomBytes(16)
        link.inbox.send(helloOk(ephB.pub, nonceB, hostId))
        val ch = withTimeout(5_000) { d.await() }
        val keys = Crypto.sessionKeys(Crypto.ecdh(ephB.priv, ephA), kDev, nonceA, nonceB)
        Session(ch, link, keys.b2c)
    }

    /** Runs a handshake against [feed]-supplied bytes and returns the failure. */
    private fun failure(timeoutMs: Long = 5_000, feed: suspend (FakeLink) -> Unit): Throwable = runBlocking {
        val link = FakeLink()
        val d = start(link, timeoutMs)
        awaitHello(link)
        feed(link)
        try {
            withTimeout(10_000) { d.await() }
            fail("handshake unexpectedly succeeded")
            error("unreachable")
        } catch (e: AssertionError) {
            throw e
        } catch (e: Throwable) {
            e
        }
    }

    @Test
    fun happyPathAndDataFrames() = runBlocking {
        val s = connect()
        s.link.inbox.send(s.frame("""{"t":"ping"}"""))
        assertEquals("ping", s.channel.receive()!!["t"]!!.jsonPrimitive.content)
        s.channel.send(obj("""{"t":"pong"}"""))
        assertEquals(FRAME_DATA, s.link.sent.last()[0].toInt())
    }

    @Test
    fun junkDuringHandshakeIsRecoverableNotFatal() {
        val err = failure { link -> repeat(6) { link.inbox.send(Crypto.randomBytes(80).also { b -> b[0] = FRAME_HELLO.toByte() }) } }
        assertTrue("got $err", err is InvalidFramesException)
        assertTrue(err !is FatalHandshakeException)
    }

    @Test
    fun wrongFrameTypesDuringHandshakeAreRecoverable() {
        val err = failure { link -> repeat(6) { link.inbox.send(byteArrayOf(FRAME_DATA.toByte(), 1, 2, 3)) } }
        assertTrue("got $err", err is InvalidFramesException)
    }

    @Test
    fun silenceIsATimeoutNotFatal() {
        val err = failure(timeoutMs = 300) { }
        assertTrue("got $err", err is HandshakeTimeoutException)
    }

    @Test
    fun authenticatedIdentityMismatchIsFatal() {
        val err = failure { link -> link.inbox.send(helloOk(Crypto.generateKeypair().pub, Crypto.randomBytes(16), "someoneElse1")) }
        assertTrue("got $err", err is FatalHandshakeException)
    }

    @Test
    fun authenticatedProtocolMismatchIsFatal() {
        val err = failure { link -> link.inbox.send(helloOk(Crypto.generateKeypair().pub, Crypto.randomBytes(16), hostId, proto = 2)) }
        assertTrue("got $err", err is FatalHandshakeException)
    }

    @Test
    fun replayedFramesEndTheChannelWithARecoverableError() = runBlocking {
        val s = connect()
        val first = s.frame("""{"t":"ping"}""")
        s.link.inbox.send(first)
        assertEquals("ping", s.channel.receive()!!["t"]!!.jsonPrimitive.content)
        repeat(3) { s.link.inbox.send(first) }
        try {
            s.channel.receive()
            fail("expected ChannelDeadException")
        } catch (e: ChannelDeadException) {
            // recoverable: HostConnection backs off and reconnects
        }
    }

    @Test
    fun garbageFramesEndTheChannelWithARecoverableError() = runBlocking {
        val s = connect()
        repeat(3) { s.link.inbox.send(byteArrayOf(FRAME_DATA.toByte()) + Crypto.randomBytes(60)) }
        try {
            s.channel.receive()
            fail("expected ChannelDeadException")
        } catch (e: ChannelDeadException) {
        }
    }

    @Test
    fun oneBadFrameDoesNotKillAnOtherwiseGoodChannel() = runBlocking {
        val s = connect()
        s.link.inbox.send(byteArrayOf(FRAME_DATA.toByte()) + Crypto.randomBytes(60))
        s.link.inbox.send(s.frame("""{"t":"pong"}"""))
        assertEquals("pong", s.channel.receive()!!["t"]!!.jsonPrimitive.content)
    }

    @Test
    fun closedSocketEndsReceiveWithNull() = runBlocking {
        val s = connect()
        s.link.inbox.close()
        assertNull(s.channel.receive())
    }
}
