package app.ompr.net

import app.ompr.data.BlobResult
import app.ompr.data.ErrorCodes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.LinkedHashMap

class BlobData(val bytes: ByteArray, val mimeType: String)

/**
 * `blob.get` chunk assembler with an in-memory LRU (24 MiB). Image refs are only valid for the bridge process
 * lifetime (§6.3), so entries are never persisted.
 */
class BlobCache(private val conn: HostConnection, private val maxBytes: Long = 24L * 1024 * 1024) {
    private val lock = Any()
    private var size = 0L
    private val lru = LinkedHashMap<String, BlobData>(16, 0.75f, true)
    private val inflight = HashMap<String, CompletableDeferred<BlobData>>()

    fun peek(ref: String): BlobData? = synchronized(lock) { lru[ref] }

    /** Downloads (or returns the cached) blob. Concurrent callers for one ref share a single download. */
    suspend fun get(ref: String, chunkBytes: Int = 256 * 1024): BlobData {
        peek(ref)?.let { return it }
        var mine = false
        val d = synchronized(lock) {
            inflight[ref] ?: CompletableDeferred<BlobData>().also { inflight[ref] = it; mine = true }
        }
        if (!mine) return d.await()
        try {
            val out = java.io.ByteArrayOutputStream()
            var off = 0L
            var mime = "application/octet-stream"
            while (true) {
                val r = conn.call(
                    "blob.get",
                    buildJsonObject {
                        put("ref", ref)
                        put("off", off)
                        put("len", chunkBytes)
                    },
                    BlobResult.serializer(),
                    60_000,
                )
                mime = r.mimeType
                val chunk = decodeBase64Any(r.data)
                out.write(chunk)
                off += chunk.size
                if (chunk.isEmpty() || off >= r.total) break
            }
            val blob = BlobData(out.toByteArray(), mime)
            synchronized(lock) {
                lru[ref] = blob
                size += blob.bytes.size
                val it = lru.entries.iterator()
                while (size > maxBytes && it.hasNext()) {
                    val e = it.next()
                    if (e.key == ref) continue
                    size -= e.value.bytes.size
                    it.remove()
                }
            }
            d.complete(blob)
            return blob
        } catch (e: Throwable) {
            d.completeExceptionally(if (e is WireException) e else WireException(ErrorCodes.INTERNAL, e.message ?: "blob download failed"))
            throw e
        } finally {
            synchronized(lock) { inflight.remove(ref) }
        }
    }
}
