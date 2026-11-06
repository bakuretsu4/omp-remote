package app.ompr.data

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Kotlin mirror of protocol/src/index.ts. Unknown fields / unknown event kinds are ignored
 * (docs/PROTOCOL.md §8): polymorphic hierarchies decode unknown discriminators into an `Unknown*` case.
 * Enumerated strings (status, kind, level…) stay `String` on purpose so a newer bridge never crashes the app.
 */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
    encodeDefaults = false
}

const val PROTO = 1

/**
 * Numbers the bridge may send as JSON floats where the protocol says integer (e.g. a file mtime `1793691772049.516`).
 * Truncating is the right reading for every `Long` field of the protocol (timestamps, byte counts, token counts).
 */
object FlexLong : KSerializer<Long> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("FlexLong", PrimitiveKind.LONG)
    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
    override fun deserialize(decoder: Decoder): Long {
        val p = (decoder as? JsonDecoder)?.decodeJsonElement()?.jsonPrimitive ?: return decoder.decodeLong()
        return p.longOrNull ?: p.doubleOrNull?.toLong() ?: throw SerializationException("not a number: ${'$'}{p.content.take(32)}")
    }
}

object FlexLongOrNull : KSerializer<Long?> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("FlexLongOrNull", PrimitiveKind.LONG).nullable
    override fun serialize(encoder: Encoder, value: Long?) = if (value == null) encoder.encodeNull() else encoder.encodeLong(value)
    override fun deserialize(decoder: Decoder): Long? {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return decoder.decodeLong()
        if (el is JsonNull) return null
        val p = el.jsonPrimitive
        return p.longOrNull ?: p.doubleOrNull?.toLong()
    }
}

object SessionKind {
    const val MANAGED = "managed"
    const val TUI = "tui"
    const val RECENT = "recent"
}

object SessionStatus {
    const val IDLE = "idle"
    const val WORKING = "working"
    const val WAITING = "waiting"
    const val OFFLINE = "offline"
}

object ApprovalModes {
    const val ALWAYS_ASK = "always-ask"
    const val ALWAYS_ASK_CACHED = "always-ask-cached"
    const val WRITE = "write"
    const val YOLO = "yolo"
    /** Strictest first. */
    val all = listOf(ALWAYS_ASK, ALWAYS_ASK_CACHED, WRITE, YOLO)

    private fun rank(m: String?, unknown: Int) = all.indexOf(m).takeIf { it >= 0 } ?: unknown

    /**
     * True when switching [from] → [to] lets the agent do more without asking. An unknown/absent current mode counts as
     * the strictest and an unknown target as the loosest, so anything unrecognised is gated.
     */
    fun isWeaker(from: String?, to: String): Boolean = rank(to, all.size) > rank(from, 0)

    /** Modes that skip prompts for at least some tools: starting a session in one needs the biometric gate. */
    fun skipsPrompts(m: String): Boolean = m == WRITE || m == YOLO || m !in all

    /** Modes the connected PC will accept, strictest first. A bridge that does not report any (an older build) is assumed to allow all. */
    fun allowedBy(info: HostInfo?): List<String> = info?.approvalModes?.let { allowed -> all.filter { it in allowed } } ?: all

    /** [preferred] when the PC allows it, otherwise the strictest mode it does allow. */
    fun orStrictest(preferred: String, info: HostInfo?): String = allowedBy(info).let { if (preferred in it) preferred else it.firstOrNull() ?: ALWAYS_ASK }
}

object ThinkingLevels {
    val all = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")
}

/** Capability names carried in `SessionSummary.caps`. */
object Cap {
    const val PROMPT = "prompt"
    const val STEER = "steer"
    const val ABORT = "abort"
    const val QUEUE = "queue"
    const val UI = "ui"
    const val IMAGES = "images"
    const val FILES = "files"
    const val MODEL = "model"
    const val THINKING = "thinking"
    const val FAST = "fast"
    const val COMPACT = "compact"
    const val GOAL = "goal"
    const val TODOS = "todos"
    const val FORK = "fork"
    const val TREE = "tree"
    const val SUBAGENTS = "subagents"
    const val HOSTTOOLS = "hosttools"
    const val VOICE = "voice"
    const val APPROVAL_MODE = "approvalMode"
    const val STATS = "stats"
    const val BTW = "btw"
}

object ErrorCodes {
    const val UNAUTHORIZED = "unauthorized"
    const val NOT_FOUND = "not_found"
    const val INVALID = "invalid"
    const val BUSY = "busy"
    const val UNSUPPORTED = "unsupported"
    const val FORBIDDEN_PATH = "forbidden_path"
    const val READONLY = "readonly"
    const val SESSION_CLOSED = "session_closed"
    const val TIMEOUT = "timeout"
    const val INTERNAL = "internal"

    /** Local-only codes (never on the wire). */
    const val DISCONNECTED = "disconnected"
}

@Serializable
data class WireError(val code: String = ErrorCodes.INTERNAL, val message: String = "")

@Serializable
data class HostInfo(
    val proto: Int = PROTO,
    val hostId: String = "",
    val name: String = "",
    val platform: String = "",
    val bridgeVersion: String = "",
    val ompVersion: String? = null,
    val roots: List<String> = emptyList(),
    val push: Boolean = false,
    val approvalModes: List<String>? = null,
    val features: List<String>? = null,
    @Serializable(with = FlexLong::class) val now: Long = 0,
)

@Serializable
data class ModelRef(
    val provider: String,
    val id: String,
    val name: String? = null,
    @Serializable(with = FlexLongOrNull::class) val contextWindow: Long? = null,
) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

@Serializable
data class ModelEntry(
    val provider: String,
    val id: String,
    val name: String? = null,
    @Serializable(with = FlexLongOrNull::class) val contextWindow: Long? = null,
    val thinkingLevels: List<String>? = null,
) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

@Serializable
data class SessionSummary(
    val sid: String,
    val kind: String = SessionKind.MANAGED,
    val title: String = "",
    val cwd: String = "",
    val status: String = SessionStatus.IDLE,
    val model: ModelRef? = null,
    val thinkingLevel: String? = null,
    val approvalMode: String? = null,
    val contextPercent: Double? = null,
    val costUsd: Double? = null,
    @Serializable(with = FlexLong::class) val lastActivity: Long = 0,
    val pendingUi: Int = 0,
    val sessionFile: String? = null,
    val caps: List<String> = emptyList(),
    @Serializable(with = FlexLongOrNull::class) val pid: Long? = null,
) {
    fun can(cap: String): Boolean = cap in caps
}

// ─────────────────────────────── messages ────────────────────────────────

@Serializable(with = BlockSerializer::class)
sealed interface Block {
    @Serializable
    data class Text(val text: String = "", val truncated: Boolean = false) : Block

    @Serializable
    data class Thinking(val thinking: String = "", val truncated: Boolean = false) : Block

    @Serializable
    data class ToolCall(
        val id: String,
        val name: String = "",
        val arguments: JsonObject = JsonObject(emptyMap()),
        val intent: String? = null,
    ) : Block

    @Serializable
    data class Image(val ref: String, val mimeType: String = "image/png", @Serializable(with = FlexLong::class) val bytes: Long = 0) : Block

    @Serializable
    data object Unknown : Block
}

object BlockSerializer : JsonContentPolymorphicSerializer<Block>(Block::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<Block> =
        when (element.jsonObject["type"]?.jsonPrimitive?.contentOrNull) {
            "text" -> Block.Text.serializer()
            "thinking" -> Block.Thinking.serializer()
            "toolCall" -> Block.ToolCall.serializer()
            "image" -> Block.Image.serializer()
            else -> Block.Unknown.serializer()
        }
}

@Serializable
data class Usage(
    @Serializable(with = FlexLong::class) val input: Long = 0,
    @Serializable(with = FlexLong::class) val output: Long = 0,
    @Serializable(with = FlexLong::class) val cacheRead: Long = 0,
    @Serializable(with = FlexLong::class) val cacheWrite: Long = 0,
    val costUsd: Double = 0.0,
)

@Serializable
data class Message(
    val id: String,
    val role: String = "assistant",
    val content: List<Block> = emptyList(),
    val model: String? = null,
    val stopReason: String? = null,
    val errorMessage: String? = null,
    val usage: Usage? = null,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val isError: Boolean = false,
    val from: String? = null,
    @Serializable(with = FlexLong::class) val timestamp: Long = 0,
) {
    /** Concatenated text blocks. */
    val text: String
        get() = content.filterIsInstance<Block.Text>().joinToString("") { it.text }
}

@Serializable
data class TodoTask(val content: String = "", val status: String = "pending", val blocker: String? = null)

@Serializable
data class TodoPhase(val name: String = "", val tasks: List<TodoTask> = emptyList())

@Serializable
data class QueueState(val steering: List<String> = emptyList(), val followUp: List<String> = emptyList())

@Serializable
data class GoalState(
    val objective: String = "",
    val status: String = "",
    @Serializable(with = FlexLongOrNull::class) val tokenBudget: Long? = null,
    @Serializable(with = FlexLongOrNull::class) val tokensUsed: Long? = null,
)

@Serializable
data class SubagentInfo(
    val id: String,
    val name: String = "",
    val kind: String = "sub",
    val status: String = "running",
    val task: String? = null,
    val lastIntent: String? = null,
    val currentTool: String? = null,
    @Serializable(with = FlexLongOrNull::class) val tokens: Long? = null,
    val costUsd: Double? = null,
)

@Serializable
data class ContextUsage(@Serializable(with = FlexLongOrNull::class) val tokens: Long? = null, @Serializable(with = FlexLongOrNull::class) val contextWindow: Long? = null, val percent: Double? = null)

@Serializable
data class Participant(val name: String = "", val role: String = "guest", val readOnly: Boolean = false)

@Serializable
data class SessionState(
    val isStreaming: Boolean = false,
    val isCompacting: Boolean = false,
    val model: ModelRef? = null,
    val thinkingLevel: String? = null,
    val fastMode: Boolean? = null,
    val approvalMode: String? = null,
    val contextUsage: ContextUsage? = null,
    val costUsd: Double? = null,
    val tokensPerSecond: Double? = null,
    val participants: List<Participant>? = null,
)

// ─────────────────────────────── UI requests ──────────────────────────────

@Serializable
data class SelectOption(val label: String, val description: String? = null)

@Serializable
data class AskOption(val label: String, val description: String? = null, val preview: String? = null)

@Serializable
data class AskQuestion(
    val id: String,
    val question: String = "",
    val header: String? = null,
    val multi: Boolean = false,
    val recommended: Int? = null,
    val options: List<AskOption> = emptyList(),
)

@Serializable(with = UiRequestSerializer::class)
sealed interface UiRequest {
    val reqId: String
    val createdAt: Long

    @Serializable
    data class Approval(
        override val reqId: String,
        val tool: String = "",
        val detail: String = "",
        val options: List<String> = emptyList(),
        val title: String = "",
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    @Serializable
    data class Select(
        override val reqId: String,
        val title: String = "",
        val options: List<SelectOption> = emptyList(),
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    @Serializable
    data class Confirm(
        override val reqId: String,
        val title: String = "",
        val message: String? = null,
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    @Serializable
    data class Input(
        override val reqId: String,
        val title: String = "",
        val placeholder: String? = null,
        val secret: Boolean = false,
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    @Serializable
    data class Editor(
        override val reqId: String,
        val title: String = "",
        val prefill: String? = null,
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    @Serializable
    data class Ask(
        override val reqId: String,
        val questions: List<AskQuestion> = emptyList(),
        @Serializable(with = FlexLong::class) override val createdAt: Long = 0,
    ) : UiRequest

    /** A request kind this app version does not know; shown as "open on PC". */
    @Serializable
    data class Unknown(override val reqId: String = "", @Serializable(with = FlexLong::class) override val createdAt: Long = 0) : UiRequest
}

object UiRequestSerializer : JsonContentPolymorphicSerializer<UiRequest>(UiRequest::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<UiRequest> =
        when (element.jsonObject["kind"]?.jsonPrimitive?.contentOrNull) {
            "approval" -> UiRequest.Approval.serializer()
            "select" -> UiRequest.Select.serializer()
            "confirm" -> UiRequest.Confirm.serializer()
            "input" -> UiRequest.Input.serializer()
            "editor" -> UiRequest.Editor.serializer()
            "ask" -> UiRequest.Ask.serializer()
            else -> UiRequest.Unknown.serializer()
        }
}

/** Argument of `ui.respond`. Build with the helpers below; it serialises to one of the wire shapes. */
sealed interface UiAnswer {
    data class Value(val value: String) : UiAnswer
    data class Confirmed(val confirmed: Boolean) : UiAnswer
    data class AskAnswer(val id: String, val selectedOptions: List<String>, val customInput: String? = null)
    data class Answers(val answers: List<AskAnswer>) : UiAnswer
    data object Cancelled : UiAnswer
}

// ─────────────────────────────── snapshot ─────────────────────────────────

@Serializable
data class RunningTool(
    val callId: String,
    val tool: String = "",
    val args: JsonElement = JsonNull,
    val intent: String? = null,
    @Serializable(with = FlexLong::class) val startedAt: Long = 0,
)

@Serializable
data class SessionSnapshot(
    val summary: SessionSummary,
    val state: SessionState = SessionState(),
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val queue: QueueState = QueueState(),
    val todos: List<TodoPhase> = emptyList(),
    val goal: GoalState? = null,
    val pendingUi: List<UiRequest> = emptyList(),
    val subagents: List<SubagentInfo> = emptyList(),
    val runningTools: List<RunningTool> = emptyList(),
)

// ─────────────────────────────── events ───────────────────────────────────

@Serializable(with = SessionEventSerializer::class)
sealed interface SessionEvent {
    @Serializable
    data object AgentStart : SessionEvent

    @Serializable
    data class AgentEnd(val yielded: Boolean = false, val settled: Boolean = true) : SessionEvent

    @Serializable
    data class Msg(val message: Message, @SerialName("final") val isFinal: Boolean = false) : SessionEvent

    @Serializable
    data class ToolStart(
        val callId: String,
        val tool: String = "",
        val args: JsonElement = JsonNull,
        val intent: String? = null,
    ) : SessionEvent

    @Serializable
    data class ToolUpdate(val callId: String, val output: String = "", val truncated: Boolean = false) : SessionEvent

    @Serializable
    data class ToolEnd(
        val callId: String,
        val output: String = "",
        val isError: Boolean = false,
        val truncated: Boolean = false,
    ) : SessionEvent

    @Serializable
    data class UiReq(val request: UiRequest) : SessionEvent

    @Serializable
    data class UiEnd(val reqId: String) : SessionEvent

    @Serializable
    data class StateEv(val state: SessionState) : SessionEvent

    @Serializable
    data class QueueEv(val queue: QueueState) : SessionEvent

    @Serializable
    data class TodosEv(val phases: List<TodoPhase> = emptyList()) : SessionEvent

    @Serializable
    data class GoalEv(val goal: GoalState? = null) : SessionEvent

    @Serializable
    data class SubagentsEv(val subagents: List<SubagentInfo> = emptyList()) : SessionEvent

    @Serializable
    data class Notice(val level: String = "info", val message: String = "") : SessionEvent

    @Serializable
    data class Compaction(
        val phase: String = "start",
        val auto: Boolean = false,
        val ok: Boolean? = null,
        val message: String? = null,
    ) : SessionEvent

    @Serializable
    data class LivePhase(val phase: String = "") : SessionEvent

    @Serializable
    data class LiveTranscript(
        val role: String = "assistant",
        val turn: Int = 0,
        val text: String = "",
        @SerialName("final") val isFinal: Boolean = false,
    ) : SessionEvent

    @Serializable
    data class LiveEnd(val error: String? = null) : SessionEvent

    @Serializable
    data class Closed(val reason: String = "") : SessionEvent

    @Serializable
    data object Unknown : SessionEvent
}

object SessionEventSerializer : JsonContentPolymorphicSerializer<SessionEvent>(SessionEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<SessionEvent> =
        when (element.jsonObject["k"]?.jsonPrimitive?.contentOrNull) {
            "agent.start" -> SessionEvent.AgentStart.serializer()
            "agent.end" -> SessionEvent.AgentEnd.serializer()
            "msg" -> SessionEvent.Msg.serializer()
            "tool.start" -> SessionEvent.ToolStart.serializer()
            "tool.update" -> SessionEvent.ToolUpdate.serializer()
            "tool.end" -> SessionEvent.ToolEnd.serializer()
            "ui.request" -> SessionEvent.UiReq.serializer()
            "ui.end" -> SessionEvent.UiEnd.serializer()
            "state" -> SessionEvent.StateEv.serializer()
            "queue" -> SessionEvent.QueueEv.serializer()
            "todos" -> SessionEvent.TodosEv.serializer()
            "goal" -> SessionEvent.GoalEv.serializer()
            "subagents" -> SessionEvent.SubagentsEv.serializer()
            "notice" -> SessionEvent.Notice.serializer()
            "compaction" -> SessionEvent.Compaction.serializer()
            "live.phase" -> SessionEvent.LivePhase.serializer()
            "live.transcript" -> SessionEvent.LiveTranscript.serializer()
            "live.end" -> SessionEvent.LiveEnd.serializer()
            "closed" -> SessionEvent.Closed.serializer()
            else -> SessionEvent.Unknown.serializer()
        }
}

object AttentionKinds {
    const val APPROVAL = "approval"
    const val QUESTION = "question"
    const val DONE = "done"
    const val ERROR = "error"
    const val LIMIT = "limit"
    val all = listOf(APPROVAL, QUESTION, DONE, ERROR, LIMIT)
}

@Serializable
data class AttentionItem(
    val id: String,
    @Serializable(with = FlexLong::class) val ts: Long = 0,
    val sid: String = "",
    val sessionTitle: String = "",
    val kind: String = AttentionKinds.DONE,
    val summary: String = "",
    val uiReqId: String? = null,
    val resolved: Boolean = false,
)

@Serializable(with = HostEventSerializer::class)
sealed interface HostEvent {
    @Serializable
    data object SessionsChanged : HostEvent

    @Serializable
    data class Attention(val item: AttentionItem) : HostEvent

    @Serializable
    data class AttentionResolved(val id: String) : HostEvent

    @Serializable
    data class HostToolCall(
        val callId: String,
        val sid: String = "",
        val tool: String = "",
        val args: JsonObject = JsonObject(emptyMap()),
    ) : HostEvent

    @Serializable
    data class HostToolCancel(val callId: String) : HostEvent

    @Serializable
    data class HostNotice(val level: String = "info", val message: String = "") : HostEvent

    @Serializable
    data object Unknown : HostEvent
}

object HostEventSerializer : JsonContentPolymorphicSerializer<HostEvent>(HostEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<HostEvent> =
        when (element.jsonObject["k"]?.jsonPrimitive?.contentOrNull) {
            "sessions.changed" -> HostEvent.SessionsChanged.serializer()
            "attention" -> HostEvent.Attention.serializer()
            "attention.resolved" -> HostEvent.AttentionResolved.serializer()
            "hosttool.call" -> HostEvent.HostToolCall.serializer()
            "hosttool.cancel" -> HostEvent.HostToolCancel.serializer()
            "host.notice" -> HostEvent.HostNotice.serializer()
            else -> HostEvent.Unknown.serializer()
        }
}

// ─────────────────────────────── operations ───────────────────────────────

@Serializable
data class FsEntry(
    val name: String,
    val path: String,
    val dir: Boolean = false,
    @Serializable(with = FlexLongOrNull::class) val size: Long? = null,
    @Serializable(with = FlexLongOrNull::class) val mtime: Long? = null,
)

@Serializable
data class RefAttachment(val ref: String)

@Serializable
data class GoalSpec(val objective: String, @Serializable(with = FlexLongOrNull::class) val tokenBudget: Long? = null)

@Serializable
data class ModelId(val provider: String, val id: String)

@Serializable
data class CreateSessionArgs(
    val cwd: String,
    val model: ModelId? = null,
    val thinkingLevel: String? = null,
    val approvalMode: String? = null,
    val prompt: String? = null,
    val attachments: List<RefAttachment>? = null,
    val goal: GoalSpec? = null,
    val hostTools: Boolean? = null,
)

@Serializable data class SessionsListResult(val sessions: List<SessionSummary> = emptyList())
@Serializable data class ModelsListResult(val models: List<ModelEntry> = emptyList())
@Serializable data class FsRootsResult(val roots: List<String> = emptyList())
@Serializable data class FsListResult(val path: String = "", val entries: List<FsEntry> = emptyList())
@Serializable data class AttentionListResult(val items: List<AttentionItem> = emptyList())
@Serializable data class SidResult(val sid: String)
@Serializable data class OpenResult(val snapshot: SessionSnapshot, @Serializable(with = FlexLong::class) val n: Long = 0)
@Serializable data class HistoryResult(val messages: List<Message> = emptyList(), val hasMore: Boolean = false)
@Serializable data class ToolOutputResult(val text: String = "", @Serializable(with = FlexLongOrNull::class) val next: Long? = null)
@Serializable data class BlobResult(val data: String = "", @Serializable(with = FlexLong::class) val total: Long = 0, val mimeType: String = "application/octet-stream")
@Serializable data class AbortResult(val restored: QueueState? = null)
@Serializable data class SetResult(val state: SessionState = SessionState())
@Serializable data class GoalResult(val goal: GoalState? = null)
@Serializable data class UploadBeginResult(val uploadId: String)
@Serializable data class UploadEndResult(val ref: String, val path: String? = null)
@Serializable data class BtwResult(val answer: String = "")
@Serializable data class DeviceEntry(val did: String, val label: String = "", @Serializable(with = FlexLong::class) val lastSeen: Long = 0, val current: Boolean = false)
@Serializable data class DevicesListResult(val devices: List<DeviceEntry> = emptyList())
@Serializable data class LiveConnectResult(val sdpAnswer: String = "", val voice: String = "")
