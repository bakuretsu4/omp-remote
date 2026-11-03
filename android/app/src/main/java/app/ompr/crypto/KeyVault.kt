package app.ompr.crypto

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals small secrets (K_dev, room secret) for storage at rest. */
interface SecretBox {
    fun wrap(plain: ByteArray, context: String): ByteArray
    fun unwrap(wrapped: ByteArray, context: String): ByteArray
}

/**
 * Wraps secrets with a non-exportable AES-256-GCM key held in the Android Keystore (StrongBox when the
 * device has it, otherwise TEE). The wrap key never leaves the secure hardware; only `IV ‖ ct ‖ tag`
 * blobs are stored. `context` is bound as AAD so a blob cannot be moved between fields or hosts.
 *
 * Authentication is not tied to the Keystore key: the optional biometric lock is an app-level gate
 * (see BiometricGate) so a fingerprint enrolment change never destroys the pairing.
 */
class KeystoreSecretBox(private val alias: String = "ompr.wrap.v1") : SecretBox {
    private val ks: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    private fun key(): SecretKey {
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        return try {
            generate(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        } catch (e: StrongBoxUnavailableException) {
            generate(strongBox = false)
        } catch (e: Exception) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) generate(strongBox = false) else throw e
        }
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
        gen.init(b.build())
        return gen.generateKey()
    }

    override fun wrap(plain: ByteArray, context: String): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(context.toByteArray(Charsets.UTF_8))
        return c.iv + c.doFinal(plain)
    }

    override fun unwrap(wrapped: ByteArray, context: String): ByteArray {
        if (wrapped.size < 12 + 16) throw CryptoException("wrapped secret too short")
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, wrapped, 0, 12))
        c.updateAAD(context.toByteArray(Charsets.UTF_8))
        return c.doFinal(wrapped, 12, wrapped.size - 12)
    }
}
