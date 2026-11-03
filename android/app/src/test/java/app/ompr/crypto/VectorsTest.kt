package app.ompr.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Reproduces every vector in protocol/test-vectors.json byte for byte. */
class VectorsTest {
    private val root: JsonObject = Json.parseToJsonElement(
        javaClass.getResourceAsStream("/test-vectors.json")!!.readBytes().decodeToString(),
    ).jsonObject

    private fun s(vararg path: String): String {
        var o: JsonObject = root
        for (p in path.dropLast(1)) o = o[p]!!.jsonObject
        return o[path.last()]!!.jsonPrimitive.content
    }

    private fun h(vararg path: String): ByteArray = Crypto.unhex(s(*path))

    @Test
    fun publicKeysEncodeAsBase64Url() {
        assertEquals(s("derived", "bridgePub_b64u"), Crypto.b64u(h("keys", "bridgePub")))
        assertEquals(s("derived", "devicePub_b64u"), Crypto.b64u(h("keys", "devicePub")))
        assertArrayEquals(h("keys", "bridgePub"), Crypto.unb64u(s("derived", "bridgePub_b64u")))
    }

    @Test
    fun hostIdAndRoomId() {
        assertEquals(s("derived", "hostId"), Crypto.hostIdOf(h("keys", "bridgePub")))
        assertEquals(s("derived", "roomId"), Crypto.roomIdOf(h("inputs", "roomSecret")))
    }

    @Test
    fun pairKey() {
        assertArrayEquals(h("derived", "pairKey"), Crypto.pairKeyFrom(h("inputs", "pairingToken")))
    }

    @Test
    fun sas() {
        val sas = Crypto.sasOf(h("inputs", "pairingToken"), h("keys", "devicePub"), h("keys", "bridgePub"))
        assertEquals(s("derived", "sas"), sas)
        // binds the device key: a different requester key yields a different code
        val other = Crypto.generateKeypair().pub
        assertTrue(Crypto.sasOf(h("inputs", "pairingToken"), other, h("keys", "bridgePub")) != sas)
        assertTrue(Regex("\\d{3} \\d{3}").matches(sas))
    }

    @Test
    fun deviceKeyAgreement() {
        // Both sides reach the same X coordinate (private scalar of the bridge starts with a zero byte).
        val a = Crypto.ecdh(h("keys", "devicePriv"), h("keys", "bridgePub"))
        val b = Crypto.ecdh(h("keys", "bridgePriv"), h("keys", "devicePub"))
        assertArrayEquals(h("derived", "sharedDevice"), a)
        assertArrayEquals(h("derived", "sharedDevice"), b)
        assertArrayEquals(h("derived", "kDev"), Crypto.deviceKeyFrom(a, h("inputs", "pairingToken")))
    }

    @Test
    fun sessionKeys() {
        val a = Crypto.ecdh(h("keys", "ephAPriv"), h("keys", "ephBPub"))
        val b = Crypto.ecdh(h("keys", "ephBPriv"), h("keys", "ephAPub"))
        assertArrayEquals(h("derived", "sharedEph"), a)
        assertArrayEquals(h("derived", "sharedEph"), b)
        val k = Crypto.sessionKeys(a, h("derived", "kDev"), h("inputs", "nonceA"), h("inputs", "nonceB"))
        assertArrayEquals(h("derived", "kC2B"), k.c2b)
        assertArrayEquals(h("derived", "kB2C"), k.b2c)
    }

    private fun checkFrame(name: String, key: ByteArray, type: Int, dir: Char, did: ByteArray?) {
        val aad = Crypto.aad(type, dir, did)
        assertArrayEquals("$name aad", h("frames", name, "aad"), aad)
        val plaintext = s("frames", name, "plaintext").toByteArray(Charsets.UTF_8)
        val sealed = Crypto.seal(key, plaintext, aad, h("frames", name, "iv"))
        val payload = byteArrayOf(type.toByte()) + (if (type == FRAME_HELLO && dir == 'C') did!! else ByteArray(0)) + sealed
        assertArrayEquals("$name payload", h("frames", name, "payload"), payload)
        // and decrypt the vector payload
        val off = 1 + (if (type == FRAME_HELLO && dir == 'C') 8 else 0)
        val opened = Crypto.open(key, h("frames", name, "payload").copyOfRange(off, payload.size), aad)
        assertArrayEquals("$name open", plaintext, opened)
    }

    @Test
    fun frames() {
        val did = h("inputs", "did")
        checkFrame("pair", h("derived", "pairKey"), FRAME_PAIR, 'C', null)
        checkFrame("hello", h("derived", "kDev"), FRAME_HELLO, 'C', did)
        checkFrame("helloOk", h("derived", "kDev"), FRAME_HELLO, 'B', null)
        checkFrame("dataC2B", h("derived", "kC2B"), FRAME_DATA, 'C', null)
        checkFrame("dataB2C", h("derived", "kB2C"), FRAME_DATA, 'B', null)
    }

    @Test
    fun tamperedFrameIsRejected() {
        val key = h("derived", "kC2B")
        val payload = h("frames", "dataC2B", "payload")
        val sealed = payload.copyOfRange(1, payload.size)
        sealed[sealed.size - 1] = (sealed[sealed.size - 1].toInt() xor 1).toByte()
        try {
            Crypto.open(key, sealed, Crypto.aad(FRAME_DATA, 'C'))
            fail("tampered frame accepted")
        } catch (_: CryptoException) {
        }
        // wrong direction in AAD must fail too
        try {
            Crypto.open(key, payload.copyOfRange(1, payload.size), Crypto.aad(FRAME_DATA, 'B'))
            fail("wrong-direction AAD accepted")
        } catch (_: CryptoException) {
        }
    }

    @Test
    fun envelope() {
        val packed = Crypto.packEnvelope(7, h("envelope", "payloadHex").let { Crypto.unhex(s("envelope", "payloadHex")) })
        assertEquals(s("envelope", "packedHex"), Crypto.hex(packed))
        val u = Crypto.unpackEnvelope(packed)!!
        assertEquals(7L, u.peerId)
        assertEquals(s("envelope", "payloadHex"), Crypto.hex(u.payload))
        assertTrue(Crypto.unpackEnvelope(ByteArray(3)) == null)
        assertEquals(0xffffffffL, Crypto.unpackEnvelope(byteArrayOf(-1, -1, -1, -1))!!.peerId)
    }

    @Test
    fun generatedKeypairsAgree() {
        val a = Crypto.generateKeypair()
        val b = Crypto.generateKeypair()
        assertEquals(32, a.priv.size)
        assertEquals(65, a.pub.size)
        assertEquals(0x04.toByte(), a.pub[0])
        assertArrayEquals(Crypto.ecdh(a.priv, b.pub), Crypto.ecdh(b.priv, a.pub))
    }

    @Test
    fun invalidPeerPointRejected() {
        val bad = ByteArray(65).also { it[0] = 4; it[1] = 1; it[33] = 2 }
        try {
            Crypto.ecdh(h("keys", "devicePriv"), bad)
            fail("off-curve point accepted")
        } catch (_: CryptoException) {
        }
    }

    @Test
    fun hkdfRfc5869Case1() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = Crypto.unhex("000102030405060708090a0b0c")
        val info = Crypto.unhex("f0f1f2f3f4f5f6f7f8f9")
        val okm = Crypto.hkdf(ikm, salt, info, 42)
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            Crypto.hex(okm),
        )
        assertFalse(okm.all { it == 0.toByte() })
    }
}
