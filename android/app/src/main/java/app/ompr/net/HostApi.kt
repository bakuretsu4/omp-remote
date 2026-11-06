package app.ompr.net

import app.ompr.data.AbortResult
import app.ompr.data.AttentionItem
import app.ompr.data.AttentionListResult
import app.ompr.data.BlobResult
import app.ompr.data.BtwResult
import app.ompr.data.CreateSessionArgs
import app.ompr.data.DeviceEntry
import app.ompr.data.DevicesListResult
import app.ompr.data.FsListResult
import app.ompr.data.FsRootsResult
import app.ompr.data.GoalResult
import app.ompr.data.GoalState
import app.ompr.data.HistoryResult
import app.ompr.data.HostInfo
import app.ompr.data.ModelEntry
import app.ompr.data.ModelsListResult
import app.ompr.data.QueueState
import app.ompr.data.SessionReducer
import app.ompr.data.SessionState
import app.ompr.data.SessionView
import app.ompr.data.SetResult
import app.ompr.data.SidResult
import app.ompr.data.ToolOutputResult
import app.ompr.data.UiAnswer
import app.ompr.data.UploadBeginResult
import app.ompr.data.UploadEndResult
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.io.Closeable
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

const val UPLOAD_CHUNK_BYTES = 192 * 1024

/** The bridge gives `peer.sync` up to 15 min before answering `timeout`; the phone waits 5 min, and the sync carries on in the background. */
const val PEER_SYNC_TIMEOUT_MS = 300_000L

fun UiAnswer.toJson(): JsonObject = when (this) {
    is UiAnswer.Value -> buildJsonObject { put("value", value) }
    is UiAnswer.Confirmed -> buildJsonObject { put("confirmed", confirmed) }
    is UiAnswer.Answers -> buildJsonObject {
        putJsonArray("answers") {
            for (a in answers) add(
                buildJsonObject {
                    put("id", a.id)
                    put("selectedOptions", JsonArray(a.selectedOptions.map { JsonPrimitive(it) }))
                    if (a.customInput != null) put("customInput", a.customInput)
                },
            )
        }
    }
    UiAnswer.Cancelled -> buildJsonObject { put("cancelled", true) }
}

private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((k, v) in pairs) when (v) {
        null -> Unit
        is String -> put(k, v)
        is Boolean -> put(k, v)
        is Number -> put(k, v)
        is JsonObject -> put(k, v)
        else -> error("unsupported arg type")
    }
}

// ───────────────────────── host-level operations ─────────────────────────

suspend fun HostConnection.hostInfo(): HostInfo = call("host.info", obj(), HostInfo.serializer())

suspend fun HostConnection.listModels(sid: String? = null): List<ModelEntry> =
    call("models.list", obj("sid" to sid), ModelsListResult.serializer()).models

suspend fun HostConnection.fsRoots(): List<String> = call("fs.roots", obj(), FsRootsResult.serializer()).roots

suspend fun HostConnection.fsList(path: String, files: Boolean = false): FsListResult =
    call("fs.list", obj("path" to path, "files" to files), FsListResult.serializer())

suspend fun HostConnection.attentionList(since: Long? = null): List<AttentionItem> =
    call("attention.list", obj("since" to since), AttentionListResult.serializer()).items

suspend fun HostConnection.attentionDismiss(id: String) {
    request("attention.dismiss", obj("id" to id))
}

suspend fun HostConnection.pushRegister(token: String) {
    request("push.register", obj("provider" to "fcm", "token" to token))
}

suspend fun HostConnection.pushRegisterUnified(endpoint: String) {
    request("push.register", obj("provider" to "unifiedpush", "endpoint" to endpoint))
}

suspend fun HostConnection.pushUnregister() {
    request("push.unregister", obj())
}

suspend fun HostConnection.devicesList(): List<DeviceEntry> =
    call("devices.list", obj(), DevicesListResult.serializer()).devices

suspend fun HostConnection.devicesRevoke(did: String) {
    request("devices.revoke", obj("did" to did))
}

suspend fun HostConnection.createSession(args: CreateSessionArgs): String =
    call("sessions.create", CreateSessionArgs.serializer(), args, SidResult.serializer(), 60_000).sid

/** Turns a `recent` session into a managed one. Returns the new sid. */
suspend fun HostConnection.openRecent(sessionFile: String): String =
    call("sessions.open", obj("sessionFile" to sessionFile), SidResult.serializer(), 60_000).sid

suspend fun HostConnection.stopSession(sid: String, timeoutMs: Long = 20_000) {
    request("sessions.stop", obj("sid" to sid), timeoutMs)
}

/** Mirrors sessions with this PC's configured peer (`features` has "peer-sync"). A big sync takes minutes: the wait is generous. */
suspend fun HostConnection.peerSync(timeoutMs: Long = PEER_SYNC_TIMEOUT_MS): app.ompr.data.SyncSummary =
    call("peer.sync", obj(), app.ompr.data.SyncSummary.serializer(), timeoutMs)

/** tui → managed. Fails with `busy` while the TUI still holds the session lease. */
suspend fun HostConnection.handoverSession(sid: String): String =
    call("sessions.handover", obj("sid" to sid), SidResult.serializer(), 60_000).sid

suspend fun HostConnection.renameSession(sid: String, name: String) {
    request("sessions.rename", obj("sid" to sid, "name" to name))
}

/**
 * Uploads [input] in ≤192 KiB chunks (`upload.begin/chunk/end`). [onProgress] receives bytes sent so far.
 * `purpose = "image"` → `ref` for prompt attachments; `"file"` → also `path` on the PC (needs [sid] for the cwd).
 */
suspend fun HostConnection.upload(
    name: String,
    mime: String,
    size: Long,
    input: InputStream,
    purpose: String,
    sid: String? = null,
    onProgress: (Long) -> Unit = {},
): UploadEndResult {
    val begin = call(
        "upload.begin",
        obj("name" to name, "mime" to mime, "size" to size, "purpose" to purpose, "sid" to sid),
        UploadBeginResult.serializer(),
    )
    val enc = java.util.Base64.getEncoder()
    val buf = ByteArray(UPLOAD_CHUNK_BYTES)
    var index = 0
    var sent = 0L
    while (true) {
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        if (n == 0) break
        val chunk = if (n == buf.size) buf else buf.copyOf(n)
        request(
            "upload.chunk",
            obj("uploadId" to begin.uploadId, "i" to index, "d" to enc.encodeToString(chunk)),
            60_000,
        )
        index++
        sent += n
        onProgress(sent)
        if (n < buf.size) break
    }
    return call("upload.end", obj("uploadId" to begin.uploadId), UploadEndResult.serializer(), 60_000)
}

suspend fun HostConnection.upload(name: String, mime: String, bytes: ByteArray, purpose: String, sid: String? = null, onProgress: (Long) -> Unit = {}) =
    upload(name, mime, bytes.size.toLong(), bytes.inputStream(), purpose, sid, onProgress)

// ───────────────────────── session handle ─────────────────────────

/**
 * UI-facing API of one subscribed session. Every `suspend` function throws [WireException] on failure
 * (`code`: unsupported / busy / readonly / session_closed / disconnected / timeout …). Call [close] when leaving.
 */
class SessionHandle internal constructor(val conn: HostConnection, private val store: SessionStore) : Closeable {
    val sid: String get() = store.sid
    val view: StateFlow<SessionView> get() = store.view
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) conn.releaseStore(store)
    }

    /** Removes a request from the pending list right after it was answered (the bridge's `ui.end` follows). */
    fun dropPending(reqId: String) {
        store.updateView { v -> v.copy(pendingUi = v.pendingUi.filterNot { it.reqId == reqId }, rev = v.rev + 1) }
    }

    /** Re-snapshot (pull-to-refresh / retry after a failed open). */
    suspend fun refresh() = store.open()

    /** Sends a prompt. [behavior]: "steer" interrupts the running turn at the next tool boundary, "followUp" queues it. */
    suspend fun prompt(message: String, attachmentRefs: List<String> = emptyList(), behavior: String? = null) {
        val a = buildJsonObject {
            put("sid", sid)
            put("message", message)
            if (attachmentRefs.isNotEmpty()) putJsonArray("attachments") {
                for (r in attachmentRefs) add(buildJsonObject { put("ref", r) })
            }
            if (behavior != null) put("behavior", behavior)
        }
        conn.request("session.prompt", a, 60_000)
    }

    /** Aborts the running turn. Returns queued messages the bridge restored (to put back into the composer). */
    suspend fun abort(): QueueState? =
        conn.call("session.abort", obj("sid" to sid), AbortResult.serializer()).restored

    suspend fun respond(reqId: String, answer: UiAnswer) {
        conn.request(
            "ui.respond",
            buildJsonObject {
                put("sid", sid)
                put("reqId", reqId)
                put("answer", answer.toJson())
            },
        )
    }

    suspend fun removeQueued(message: String, queue: String): Boolean {
        val d = conn.request("session.queue.remove", obj("sid" to sid, "message" to message, "queue" to queue))
        return (d as? JsonObject)?.get("removed")?.let { it is JsonPrimitive && it.content == "true" } ?: true
    }

    suspend fun promoteQueued(message: String) {
        conn.request("session.queue.promote", obj("sid" to sid, "message" to message))
    }

    private suspend fun set(vararg pairs: Pair<String, Any?>): SessionState {
        val r = conn.call("session.set", obj("sid" to sid, *pairs), SetResult.serializer())
        store.updateView { it.copy(state = r.state, rev = it.rev + 1) }
        return r.state
    }

    suspend fun setModel(provider: String, id: String) {
        set("model" to buildJsonObject { put("provider", provider); put("id", id) })
    }

    suspend fun setThinking(level: String) { set("thinkingLevel" to level) }
    suspend fun setFastMode(on: Boolean) { set("fastMode" to on) }
    suspend fun setApprovalMode(mode: String) { set("approvalMode" to mode) }
    suspend fun setAutoCompaction(on: Boolean) { set("autoCompaction" to on) }

    suspend fun compact(instructions: String? = null) {
        conn.request("session.compact", obj("sid" to sid, "instructions" to instructions), 120_000)
    }

    /** op: create | pause | resume | drop */
    suspend fun goal(op: String, objective: String? = null, tokenBudget: Long? = null): GoalState? {
        val r = conn.call("session.goal", obj("sid" to sid, "op" to op, "objective" to objective, "tokenBudget" to tokenBudget), GoalResult.serializer())
        store.updateView { it.copy(goal = r.goal, rev = it.rev + 1) }
        return r.goal
    }

    suspend fun cancelSubagent(id: String) {
        conn.request("subagent.cancel", obj("sid" to sid, "id" to id))
    }

    suspend fun steerSubagent(id: String, message: String) {
        conn.request("subagent.steer", obj("sid" to sid, "id" to id, "message" to message))
    }

    suspend fun fork(entryId: String? = null): String =
        conn.call("session.fork", obj("sid" to sid, "entryId" to entryId), SidResult.serializer(), 60_000).sid

    suspend fun btw(question: String): String =
        conn.call("session.btw", obj("sid" to sid, "question" to question), BtwResult.serializer(), 120_000).answer

    suspend fun stop() = conn.stopSession(sid)
    suspend fun rename(name: String) = conn.renameSession(sid, name)
    suspend fun handover(): String = conn.handoverSession(sid)

    /** Pages older messages (`session.history`) into the view. */
    suspend fun loadOlder() {
        val cur = store.view.value
        if (!cur.hasMore || cur.loadingMore) return
        val before = cur.messages.firstOrNull()?.id ?: return
        store.updateView { it.copy(loadingMore = true) }
        try {
            val r = conn.call("session.history", obj("sid" to sid, "before" to before, "limit" to 100), HistoryResult.serializer())
            store.updateView { SessionReducer.prepend(it, r.messages, r.hasMore) }
        } catch (e: WireException) {
            store.updateView { it.copy(loadingMore = false) }
            throw e
        }
    }

    /** Fetches the complete (≤256 KiB) output of a truncated tool call into `view.fullOutputs[callId]`. */
    suspend fun fetchFullToolOutput(callId: String): String {
        val sb = StringBuilder()
        var off: Long? = null
        var guard = 0
        while (guard++ < 64) {
            val r = conn.call(
                "tool.output",
                obj("sid" to sid, "callId" to callId, "off" to off),
                ToolOutputResult.serializer(),
            )
            sb.append(r.text)
            off = r.next ?: break
        }
        val text = sb.toString()
        store.updateView { it.copy(fullOutputs = it.fullOutputs + (callId to text), rev = it.rev + 1) }
        return text
    }

    /** Uploads a file/photo for this session (`purpose`: "image" or "file"). */
    suspend fun upload(
        name: String, mime: String, size: Long, input: InputStream, purpose: String, onProgress: (Long) -> Unit = {},
    ): UploadEndResult = conn.upload(name, mime, size, input, purpose, sid, onProgress)
}

/** Decodes base64 in either the standard or URL-safe alphabet, with or without padding. */
fun decodeBase64Any(s: String): ByteArray {
    val t = s.replace('-', '+').replace('_', '/').trimEnd('=')
    return java.util.Base64.getDecoder().decode(t.padEnd((t.length + 3) / 4 * 4, '='))
}
