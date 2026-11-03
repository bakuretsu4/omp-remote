package app.ompr.net

import app.ompr.data.HostEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Result of a phone tool call, sent back as `hosttool.result`. */
class HostToolResult private constructor(
    val ok: Boolean,
    /** Each entry is `{type:"text",text}` or `{type:"image",data,mimeType}`. */
    val content: List<JsonObject>,
    val error: String?,
) {
    fun toArgs(callId: String): JsonObject = buildJsonObject {
        put("callId", callId)
        put("ok", ok)
        if (ok) put("content", JsonArray(content))
        if (!ok && error != null) put("error", error)
    }

    companion object {
        fun text(text: String) = HostToolResult(true, listOf(buildJsonObject { put("type", "text"); put("text", text) }), null)

        fun image(base64: String, mimeType: String) =
            HostToolResult(true, listOf(buildJsonObject { put("type", "image"); put("data", base64); put("mimeType", mimeType) }), null)

        fun failure(message: String) = HostToolResult(false, emptyList(), message)
    }
}

/**
 * "Phone as agent tools" (docs/PROTOCOL.md §6.6). `HostConnection` routes every `hosttool.call` here and answers with the
 * returned result. The implementation is `app.ompr.tools.PhoneToolHandler`.
 */
interface HostToolHandler {
    /** Device capabilities advertised in HELLO (`location|clipboard|notify|camera|voice`). Empty = none. */
    suspend fun supportedCaps(): List<String>

    suspend fun call(conn: HostConnection, call: HostEvent.HostToolCall): HostToolResult

    /** The bridge gave up on a call (timeout / session closed). Cooperative; the coroutine is cancelled as well. */
    fun cancel(callId: String) {}
}
