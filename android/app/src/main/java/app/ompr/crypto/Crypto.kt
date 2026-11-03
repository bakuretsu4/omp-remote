package app.ompr.crypto

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Frame types (docs/PROTOCOL.md §3). */
const val FRAME_PAIR = 0x00
const val FRAME_HELLO = 0x01
const val FRAME_DATA = 0x02

/** Max plaintext bytes per sealed frame. */
const val MAX_PLAINTEXT = 512 * 1024

/** Raw P-256 keypair: 32-byte private scalar, 65-byte uncompressed public point. */
class RawKeypair(val priv: ByteArray, val pub: ByteArray)

class CryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * L1 primitives: P-256 ECDH, HKDF-SHA256, AES-256-GCM. Byte-exact with protocol/src/crypto.ts.
 * Uses only javax.crypto / java.security so the same code runs on the JVM unit-test host and on Android.
 */
object Crypto {
    private val random = SecureRandom()

    private val ecParams: ECParameterSpec by lazy {
        val ap = AlgorithmParameters.getInstance("EC")
        ap.init(ECGenParameterSpec("secp256r1"))
        ap.getParameterSpec(ECParameterSpec::class.java)
    }

    // ───────────── base64url (no padding) ─────────────

    private val b64uEnc = java.util.Base64.getUrlEncoder().withoutPadding()
    private val b64uDec = java.util.Base64.getUrlDecoder()

    fun b64u(b: ByteArray): String = b64uEnc.encodeToString(b)

    fun unb64u(s: String): ByteArray = try {
        b64uDec.decode(s)
    } catch (e: IllegalArgumentException) {
        throw CryptoException("bad base64url", e)
    }

    fun hex(b: ByteArray): String = buildString(b.size * 2) { for (x in b) append("%02x".format(x.toInt() and 0xff)) }

    fun unhex(s: String): ByteArray {
        require(s.length % 2 == 0) { "odd hex length" }
        return ByteArray(s.length / 2) { i -> s.substring(2 * i, 2 * i + 2).toInt(16).toByte() }
    }

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    // ───────────── hashing / KDF ─────────────

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // An empty key is legal in HMAC but SecretKeySpec rejects it; RFC 2104 pads with zeros, same as a 32-zero-byte key.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /** RFC 5869 HKDF-SHA256. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32)
        val prk = hmacSha256(salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            t = hmacSha256(prk, t + info + byteArrayOf(counter.toByte()))
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        return out
    }

    fun hkdf(ikm: ByteArray, salt: String, info: String, length: Int): ByteArray =
        hkdf(ikm, salt.toByteArray(Charsets.UTF_8), info.toByteArray(Charsets.UTF_8), length)

    // ───────────── P-256 ECDH ─────────────

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size) // leading sign zero
            else -> ByteArray(32 - raw.size) + raw
        }
    }

    fun generateKeypair(): RawKeypair {
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"), random)
        val kp = gen.generateKeyPair()
        val priv = kp.private as ECPrivateKey
        val pub = kp.public as ECPublicKey
        return RawKeypair(fixed32(priv.s), encodePoint(pub.w))
    }

    fun encodePoint(w: ECPoint): ByteArray = byteArrayOf(0x04) + fixed32(w.affineX) + fixed32(w.affineY)

    fun decodePoint(pub: ByteArray): ECPoint {
        if (pub.size != 65 || pub[0] != 0x04.toByte()) throw CryptoException("public key must be a 65-byte uncompressed P-256 point")
        return ECPoint(BigInteger(1, pub.copyOfRange(1, 33)), BigInteger(1, pub.copyOfRange(33, 65)))
    }

    /** 32-byte X coordinate of the shared point. Throws if the peer point is not on the curve. */
    fun ecdh(priv: ByteArray, peerPub: ByteArray): ByteArray {
        try {
            val kf = KeyFactory.getInstance("EC")
            val sk = kf.generatePrivate(ECPrivateKeySpec(BigInteger(1, priv), ecParams))
            val pk = kf.generatePublic(ECPublicKeySpec(decodePoint(peerPub), ecParams))
            val ka = KeyAgreement.getInstance("ECDH")
            ka.init(sk)
            ka.doPhase(pk, true)
            val secret = ka.generateSecret()
            return fixed32(BigInteger(1, secret))
        } catch (e: CryptoException) {
            throw e
        } catch (e: Exception) {
            throw CryptoException("ECDH failed", e)
        }
    }

    // ───────────── AAD + AEAD ─────────────

    /** `"ompr1" ‖ type ‖ dir ‖ (type==HELLO && dir=='C' ? did : empty)` */
    fun aad(type: Int, dir: Char, did: ByteArray? = null): ByteArray {
        val head = "ompr1".toByteArray(Charsets.US_ASCII) + byteArrayOf(type.toByte(), dir.code.toByte())
        return if (type == FRAME_HELLO && dir == 'C' && did != null) head + did else head
    }

    /** `IV ‖ ciphertext ‖ tag`. The IV argument exists only for test vectors. */
    fun seal(key: ByteArray, plaintext: ByteArray, aad: ByteArray, iv: ByteArray = randomBytes(12)): ByteArray {
        require(iv.size == 12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return iv + c.doFinal(plaintext)
    }

    fun open(key: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray {
        if (sealed.size < 12 + 16) throw CryptoException("sealed frame too short")
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed, 0, 12))
            c.updateAAD(aad)
            return c.doFinal(sealed, 12, sealed.size - 12)
        } catch (e: Exception) {
            throw CryptoException("frame authentication failed", e)
        }
    }

    // ───────────── protocol derivations ─────────────

    fun pairKeyFrom(pt: ByteArray): ByteArray = hkdf(pt, "ompr/v1/pair", "pair", 32)

    fun deviceKeyFrom(shared: ByteArray, pt: ByteArray): ByteArray =
        hkdf(shared, pt, "ompr/v1/device".toByteArray(Charsets.UTF_8), 32)

    class SessionKeys(val c2b: ByteArray, val b2c: ByteArray)

    fun sessionKeys(sharedEph: ByteArray, kDev: ByteArray, nonceA: ByteArray, nonceB: ByteArray): SessionKeys {
        val okm = hkdf(sharedEph, kDev + nonceA + nonceB, "ompr/v1/session".toByteArray(Charsets.UTF_8), 64)
        return SessionKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
    }

    fun hostIdOf(bpk: ByteArray): String = b64u(sha256(bpk)).substring(0, 11)

    fun roomIdOf(roomSecret: ByteArray): String =
        b64u(hmacSha256(roomSecret, "ompr/v1/room".toByteArray(Charsets.UTF_8))).substring(0, 22)

    /**
     * Short authentication string for pairing (docs/PROTOCOL.md §4), shown on this phone and on the PC prompt.
     * `HKDF(ikm=pt, salt=SHA-256(dpk) ‖ bpk, info="ompr/v1/sas", L=4)` as a big-endian uint32 mod 10^6, `"123 456"`.
     * [dpk] and [bpk] are the 65-byte uncompressed points.
     */
    fun sasOf(pt: ByteArray, dpk: ByteArray, bpk: ByteArray): String {
        val okm = hkdf(pt, sha256(dpk) + bpk, "ompr/v1/sas".toByteArray(Charsets.UTF_8), 4)
        val n = ((okm[0].toLong() and 0xff) shl 24 or ((okm[1].toLong() and 0xff) shl 16) or
            ((okm[2].toLong() and 0xff) shl 8) or (okm[3].toLong() and 0xff)) % 1_000_000L
        val s = n.toString().padStart(6, '0')
        return s.substring(0, 3) + " " + s.substring(3)
    }

    /** Constant-time equality. */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    // ───────────── relay envelope ─────────────

    fun packEnvelope(peerId: Int, payload: ByteArray): ByteArray {
        val out = ByteArray(4 + payload.size)
        out[0] = (peerId ushr 24).toByte()
        out[1] = (peerId ushr 16).toByte()
        out[2] = (peerId ushr 8).toByte()
        out[3] = peerId.toByte()
        System.arraycopy(payload, 0, out, 4, payload.size)
        return out
    }

    class Envelope(val peerId: Long, val payload: ByteArray)

    fun unpackEnvelope(data: ByteArray): Envelope? {
        if (data.size < 4) return null
        val id = ((data[0].toLong() and 0xff) shl 24) or ((data[1].toLong() and 0xff) shl 16) or
            ((data[2].toLong() and 0xff) shl 8) or (data[3].toLong() and 0xff)
        return Envelope(id, data.copyOfRange(4, data.size))
    }
}
