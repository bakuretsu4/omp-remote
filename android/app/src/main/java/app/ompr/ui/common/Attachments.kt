package app.ompr.ui.common

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import app.ompr.net.HostConnection
import app.ompr.net.upload
import coil.compose.AsyncImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicLong

sealed interface AttachState {
    data class Uploading(val sent: Long, val total: Long) : AttachState
    data class Done(val ref: String, val path: String?) : AttachState
    data class Failed(val message: String) : AttachState
}

class PendingAttachment(
    val id: Long,
    val uri: Uri,
    val name: String,
    val mime: String,
    val size: Long,
    val isImage: Boolean,
    val state: AttachState,
)

/**
 * Holds the attachments of one composer and uploads each one as soon as it is added (`upload.*`, ≤192 KiB chunks).
 * [sid] is required for files (the bridge stores them in the session's cwd); images work without it (new-session wizard).
 */
class AttachmentController(
    context: Context,
    private val scope: CoroutineScope,
    private val conn: HostConnection,
    private val sid: String?,
) {
    private val app = context.applicationContext
    private val ids = AtomicLong(0)
    private val jobs = HashMap<Long, Job>()
    val items = MutableStateFlow<List<PendingAttachment>>(emptyList())

    val busy: Boolean get() = items.value.any { it.state is AttachState.Uploading }
    val hasFailed: Boolean get() = items.value.any { it.state is AttachState.Failed }

    /** Refs of everything uploaded successfully, in order. */
    fun refs(): List<String> = items.value.mapNotNull { (it.state as? AttachState.Done)?.ref }

    fun clear() {
        synchronized(jobs) { jobs.values.forEach { it.cancel() }; jobs.clear() }
        items.value = emptyList()
    }

    fun remove(id: Long) {
        synchronized(jobs) { jobs.remove(id)?.cancel() }
        items.update { l -> l.filterNot { it.id == id } }
    }

    fun addImage(uri: Uri) = add(uri, asImage = true)
    fun addFile(uri: Uri) = add(uri, asImage = false)

    fun retry(id: Long) {
        val a = items.value.firstOrNull { it.id == id } ?: return
        remove(id)
        add(a.uri, a.isImage)
    }

    private fun add(uri: Uri, asImage: Boolean) {
        val id = ids.incrementAndGet()
        val meta = queryMeta(app, uri)
        val placeholder = PendingAttachment(id, uri, meta.name, meta.mime, meta.size, asImage, AttachState.Uploading(0, meta.size))
        items.update { it + placeholder }
        val job = scope.launch(Dispatchers.IO) {
            try {
                if (!asImage && sid == null) error("Files can be attached once the session exists")
                val prepared: Prepared = if (asImage) prepareImage(app, uri, meta) else Prepared(meta.name, meta.mime, meta.size) { app.contentResolver.openInputStream(uri) ?: error("cannot read file") }
                update(id) { it.copyWith(name = prepared.name, mime = prepared.mime, size = prepared.size, state = AttachState.Uploading(0, prepared.size)) }
                val res = prepared.open().use { input ->
                    conn.upload(prepared.name, prepared.mime, prepared.size, input, if (asImage) "image" else "file", sid) { sent ->
                        update(id) { it.copyWith(state = AttachState.Uploading(sent, prepared.size)) }
                    }
                }
                update(id) { it.copyWith(state = AttachState.Done(res.ref, res.path)) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                update(id) { it.copyWith(state = AttachState.Failed(e.userMessage())) }
            }
        }
        synchronized(jobs) { jobs[id] = job }
    }

    private fun update(id: Long, f: (PendingAttachment) -> PendingAttachment) {
        items.update { l -> l.map { if (it.id == id) f(it) else it } }
    }

    private fun PendingAttachment.copyWith(
        name: String = this.name, mime: String = this.mime, size: Long = this.size, state: AttachState = this.state,
    ) = PendingAttachment(id, uri, name, mime, size, isImage, state)

    // ───────────── content resolver helpers ─────────────

    class Meta(val name: String, val mime: String, val size: Long)

    class Prepared(val name: String, val mime: String, val size: Long, val open: () -> java.io.InputStream)

    companion object {
        private const val MAX_SIDE = 2048

        fun queryMeta(ctx: Context, uri: Uri): Meta {
            var name = uri.lastPathSegment ?: "attachment"
            var size = -1L
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it)?.let { n -> name = n } }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { if (!c.isNull(it)) size = c.getLong(it) }
                }
            }
            val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
            return Meta(name, mime, size)
        }

        /**
         * Photos are decoded with subsampling to at most 2048 px on the long side, EXIF-rotated and re-encoded as JPEG
         * (keeps uploads small and avoids sending 12 MP frames to the model). Small PNG/JPEG/WEBP pass through.
         */
        fun prepareImage(ctx: Context, uri: Uri, meta: Meta): Prepared {
            val passthrough = meta.size in 1..1_500_000 && meta.mime in setOf("image/png", "image/jpeg", "image/webp")
            if (passthrough) return Prepared(meta.name, meta.mime, meta.size) { ctx.contentResolver.openInputStream(uri)!! }

            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            ctx.contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it, null, bounds) }
            require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Not an image" }
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            var bmp = ctx.contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it, null, opts) } ?: error("Cannot decode image")
            val orientation = ctx.contentResolver.openInputStream(uri)!!.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            }
            val m = Matrix()
            when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
                ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
                ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            }
            val longest = maxOf(bmp.width, bmp.height)
            if (longest > MAX_SIDE) {
                val f = MAX_SIDE.toFloat() / longest
                m.postScale(f, f)
            }
            if (!m.isIdentity) {
                val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
                if (rotated !== bmp) bmp.recycle()
                bmp = rotated
            }
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
            bmp.recycle()
            val bytes = out.toByteArray()
            val base = meta.name.substringBeforeLast('.', meta.name)
            return Prepared("$base.jpg", "image/jpeg", bytes.size.toLong()) { bytes.inputStream() }
        }
    }
}

class AttachmentLaunchers(val photo: () -> Unit, val camera: () -> Unit, val file: () -> Unit)

/** Photo picker, camera and document picker wired to [controller]. `allowFiles=false` hides the file option. */
@Composable
fun rememberAttachmentLaunchers(controller: AttachmentController): AttachmentLaunchers {
    val ctx = LocalContext.current
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        uris.forEach { controller.addImage(it) }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { controller.addFile(it) }
    }
    val pendingCameraUri = remember { arrayOfNulls<Uri>(1) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val u = pendingCameraUri[0]
        if (ok && u != null) controller.addImage(u)
        pendingCameraUri[0] = null
    }
    fun launchCamera() {
        val dir = File(ctx.cacheDir, "camera").apply { mkdirs() }
        val f = File.createTempFile("photo_", ".jpg", dir)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
        pendingCameraUri[0] = uri
        takePicture.launch(uri)
    }
    // CAMERA is declared in the manifest (QR scanner), so ACTION_IMAGE_CAPTURE needs the grant too.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera()
    }
    return remember(controller) {
        AttachmentLaunchers(
            photo = { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            camera = {
                if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera()
                else cameraPermission.launch(Manifest.permission.CAMERA)
            },
            file = { pickFile.launch(arrayOf("*/*")) },
        )
    }
}

/** Dropdown with Photo / Camera / File entries. Anchor it inside the Box that holds the "+" button. */
@Composable
fun AttachmentMenu(launchers: AttachmentLaunchers, expanded: Boolean, onDismiss: () -> Unit, allowFiles: Boolean = true) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text("Photo library") },
            leadingIcon = { Icon(Icons.Filled.PhotoLibrary, null) },
            onClick = { onDismiss(); launchers.photo() },
        )
        DropdownMenuItem(
            text = { Text("Camera") },
            leadingIcon = { Icon(Icons.Filled.PhotoCamera, null) },
            onClick = { onDismiss(); launchers.camera() },
        )
        if (allowFiles) DropdownMenuItem(
            text = { Text("File") },
            leadingIcon = { Icon(Icons.Filled.AttachFile, null) },
            onClick = { onDismiss(); launchers.file() },
        )
    }
}

/** Horizontal strip of attachment chips with thumbnail, upload progress, retry-on-tap for failures and a remove button. */
@Composable
fun AttachmentStrip(controller: AttachmentController, modifier: Modifier = Modifier) {
    val items by controller.items.collectAsState()
    if (items.isEmpty()) return
    LazyRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
        items(items, key = { it.id }) { a ->
            val failed = a.state as? AttachState.Failed
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = if (failed != null) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier
                    .semantics { contentDescription = "Attachment ${a.name}" + (failed?.let { ", failed: ${it.message}" } ?: "") }
                    .let { if (failed != null) it.clickable { controller.retry(a.id) } else it },
            ) {
                Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                        if (a.isImage) AsyncImage(a.uri, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                        else Icon(Icons.Filled.AttachFile, null)
                        when (val s = a.state) {
                            is AttachState.Uploading -> CircularProgressIndicator(
                                progress = { if (s.total > 0) (s.sent.toFloat() / s.total).coerceIn(0f, 1f) else 0f },
                                modifier = Modifier.size(24.dp), strokeWidth = 2.dp,
                            )
                            is AttachState.Failed -> Icon(Icons.Filled.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                            is AttachState.Done -> Unit
                        }
                    }
                    Column(Modifier.padding(horizontal = 8.dp).width(96.dp)) {
                        Text(a.name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            failed?.message ?: humanSize(a.size),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (failed != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    IconButton(onClick = { controller.remove(a.id) }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.Close, "Remove ${a.name}", Modifier.size(16.dp))
                    }
                }
            }
        }
    }
}

fun humanSize(bytes: Long): String = when {
    bytes < 0 -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0)
}
