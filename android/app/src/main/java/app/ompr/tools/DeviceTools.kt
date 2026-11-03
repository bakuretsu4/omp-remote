package app.ompr.tools

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.util.Base64
import androidx.core.content.ContextCompat
import app.ompr.data.PhotoFit
import app.ompr.net.HostToolResult
import app.ompr.service.Notifier
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The actual phone actions behind the `phone_*` tools. Policy (is this allowed right now?) lives in [PhoneToolHandler];
 * everything here assumes the user already said yes.
 */
class DeviceTools(private val context: Context, private val notifier: Notifier) {
    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    // ───────────────────────────── location ─────────────────────────────

    /** [host] is only invoked when a runtime permission has to be requested. Uses the platform LocationManager (no Play Services). */
    suspend fun location(host: suspend () -> ToolUiHost): HostToolResult {
        val perms = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (perms.none(::granted)) {
            val result = host().ensurePermissions(*perms)
            if (result.values.none { it }) return HostToolResult.failure("The user did not grant location permission")
        }
        val lm = context.getSystemService(LocationManager::class.java)
        val providers = buildList {
            if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) add(LocationManager.GPS_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
        }.filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) return HostToolResult.failure("Location is switched off on the phone")

        var fix: Location? = null
        for (p in providers) {
            fix = withTimeoutOrNull(if (p == LocationManager.GPS_PROVIDER) GPS_WAIT_MS else NETWORK_WAIT_MS) { currentFix(lm, p) }
            if (fix != null) break
        }
        var stale = false
        if (fix == null) {
            fix = providers.firstNotNullOfOrNull { runCatching { lastKnown(lm, it) }.getOrNull() }
            stale = fix != null
        }
        val f = fix ?: return HostToolResult.failure("No location fix. The phone may be indoors or location services are limited.")
        return HostToolResult.text(describeFix(f, stale, System.currentTimeMillis()).toString())
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown(lm: LocationManager, provider: String): Location? = lm.getLastKnownLocation(provider)

    @SuppressLint("MissingPermission")
    private suspend fun currentFix(lm: LocationManager, provider: String): Location? =
        if (Build.VERSION.SDK_INT >= 30) {
            suspendCancellableCoroutine { cont ->
                val signal = CancellationSignal()
                cont.invokeOnCancellation { signal.cancel() }
                lm.getCurrentLocation(provider, signal, ContextCompat.getMainExecutor(context)) { loc -> if (cont.isActive) cont.resume(loc) }
            }
        } else {
            suspendCancellableCoroutine { cont ->
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        if (cont.isActive) cont.resume(location)
                    }

                    @Deprecated("Required below API 30")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
                    override fun onProviderEnabled(provider: String) = Unit
                    override fun onProviderDisabled(provider: String) = Unit
                }
                cont.invokeOnCancellation { lm.removeUpdates(listener) }
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            }
        }

    // ───────────────────────────── clipboard ─────────────────────────────

    /** Android only lets the focused app read the clipboard, so this retries briefly while the window regains focus. */
    suspend fun clipboardGet(): HostToolResult {
        val cm = context.getSystemService(ClipboardManager::class.java)
        repeat(CLIPBOARD_TRIES) {
            val clip = runCatching { cm.primaryClip }.getOrNull()
            if (clip != null) {
                val text = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).coerceToText(context)?.toString() }.joinToString("\n")
                return HostToolResult.text(if (text.isEmpty()) "(the clipboard has no text)" else text.take(MAX_CLIP_CHARS))
            }
            if (!cm.hasPrimaryClip()) return HostToolResult.text("(the clipboard is empty)")
            delay(CLIPBOARD_RETRY_MS)
        }
        return HostToolResult.failure("Android would not let the app read the clipboard. The app has to be open on screen.")
    }

    fun clipboardSet(text: String): HostToolResult {
        if (text.length > MAX_CLIP_CHARS) return HostToolResult.failure("Text is too long (at most $MAX_CLIP_CHARS characters)")
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("From the agent", text))
        return HostToolResult.text("Copied ${text.length} characters to the phone clipboard.")
    }

    // ───────────────────────────── notification ─────────────────────────────

    fun notify(title: String, message: String): HostToolResult =
        if (notifier.showAgentMessage(title.take(MAX_TITLE), message.take(MAX_MESSAGE))) HostToolResult.text("Notification shown.")
        else HostToolResult.failure("Notifications are blocked for this app on the phone")

    // ───────────────────────────── camera ─────────────────────────────

    /** [host] runs the permission prompt and the camera; the photo is shrunk to fit one wire frame and the file is deleted. */
    suspend fun photo(host: ToolUiHost, facing: String?): HostToolResult {
        if (!granted(Manifest.permission.CAMERA) && host.ensurePermissions(Manifest.permission.CAMERA)[Manifest.permission.CAMERA] != true) {
            return HostToolResult.failure("The user did not grant camera permission")
        }
        val file = host.takePhoto(facing) ?: return HostToolResult.failure("The user cancelled the photo")
        try {
            val jpeg = withContext(Dispatchers.IO) { shrink(file) } ?: return HostToolResult.failure("The photo could not be processed or is too large")
            return HostToolResult.image(Base64.encodeToString(jpeg, Base64.NO_WRAP), "image/jpeg")
        } finally {
            file.delete()
        }
    }

    private fun shrink(file: File): ByteArray? = PhotoFit.fit { side, quality ->
        val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
            val longest = max(info.size.width, info.size.height)
            if (longest > side) {
                val scale = side.toFloat() / longest
                decoder.setTargetSize((info.size.width * scale).roundToInt().coerceAtLeast(1), (info.size.height * scale).roundToInt().coerceAtLeast(1))
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        ByteArrayOutputStream().also {
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, it)
            bmp.recycle()
        }.toByteArray()
    }

    companion object {
        const val MAX_CLIP_CHARS = 20_000
        private const val MAX_TITLE = 80
        private const val MAX_MESSAGE = 500
        private const val GPS_WAIT_MS = 15_000L
        private const val NETWORK_WAIT_MS = 8_000L
        private const val CLIPBOARD_TRIES = 5
        private const val CLIPBOARD_RETRY_MS = 200L

        /** The JSON the agent sees for a fix. */
        fun describeFix(l: Location, stale: Boolean, nowMs: Long): JsonObject = buildJsonObject {
            put("latitude", Math.round(l.latitude * 1e6) / 1e6)
            put("longitude", Math.round(l.longitude * 1e6) / 1e6)
            if (l.hasAccuracy()) put("accuracyMeters", l.accuracy.roundToInt())
            if (l.hasAltitude()) put("altitudeMeters", l.altitude.roundToInt())
            put("provider", l.provider ?: "unknown")
            put("fixAgeSeconds", max(0L, (nowMs - l.time) / 1000))
            if (stale) put("stale", true)
        }
    }
}
