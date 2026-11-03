package app.ompr.data

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** Loading phase of a session subscription. */
sealed interface SessionPhase {
    /** `session.open` has not completed yet (first time). */
    data object Loading : SessionPhase
    data object Ready : SessionPhase

    /** `session.open` failed (e.g. not_found, forbidden). */
    data class Failed(val code: String, val message: String) : SessionPhase

    /** The bridge reported that the session ended (`closed` event). */
    data class Closed(val reason: String) : SessionPhase
}

/** Live or finished execution of one tool call, joined from `tool.*` events and `toolResult` messages. */
@Immutable
data class ToolRun(
    val callId: String,
    val tool: String = "",
    val args: JsonElement = JsonNull,
    val intent: String? = null,
    val output: String = "",
    val images: List<Block.Image> = emptyList(),
    val truncated: Boolean = false,
    val isError: Boolean = false,
    val running: Boolean = true,
    val startedAt: Long = 0,
)

@Immutable
data class SessionNotice(val level: String, val message: String, val at: Long = System.currentTimeMillis())

/**
 * Everything the session screen renders. Produced by [SessionReducer] from `session.open` + `ev` frames;
 * replaced wholesale by a fresh snapshot after every reconnect.
 */
@Immutable
data class SessionView(
    val sid: String,
    val phase: SessionPhase = SessionPhase.Loading,
    val summary: SessionSummary? = null,
    val state: SessionState = SessionState(),
    /** Chronological transcript incl. `toolResult` messages (render those as part of their tool card). */
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val queue: QueueState = QueueState(),
    val todos: List<TodoPhase> = emptyList(),
    val goal: GoalState? = null,
    val pendingUi: List<UiRequest> = emptyList(),
    val subagents: List<SubagentInfo> = emptyList(),
    /** callId → run. Look up with `Block.ToolCall.id`. */
    val tools: Map<String, ToolRun> = emptyMap(),
    /** callId → full output fetched through `tool.output` (when `ToolRun.truncated`). */
    val fullOutputs: Map<String, String> = emptyMap(),
    val notices: List<SessionNotice> = emptyList(),
    val agentRunning: Boolean = false,
    val compacting: Boolean = false,
    /** Monotonic counter bumped by every applied change (cheap "did anything change" key for scrolling). */
    val rev: Long = 0,
) {
    val caps: Set<String> get() = summary?.caps?.toSet() ?: emptySet()
    fun can(cap: String): Boolean = summary?.caps?.contains(cap) == true
    val busy: Boolean get() = agentRunning || state.isStreaming
    val title: String get() = summary?.title.orEmpty()
    val closed: Boolean get() = phase is SessionPhase.Closed
}

/** Pure state transitions. Unit tested. */
object SessionReducer {
    fun fromSnapshot(prev: SessionView, s: SessionSnapshot): SessionView {
        val tools = LinkedHashMap<String, ToolRun>()
        for (r in s.runningTools) {
            tools[r.callId] = ToolRun(r.callId, r.tool, r.args, r.intent, running = true, startedAt = r.startedAt)
        }
        for (m in s.messages) absorbToolResult(tools, m)
        return prev.copy(
            phase = SessionPhase.Ready,
            summary = s.summary,
            state = s.state,
            messages = s.messages,
            hasMore = s.hasMore,
            loadingMore = false,
            queue = s.queue,
            todos = s.todos,
            goal = s.goal,
            pendingUi = s.pendingUi,
            subagents = s.subagents,
            tools = tools,
            agentRunning = s.state.isStreaming || s.runningTools.isNotEmpty(),
            compacting = s.state.isCompacting,
            rev = prev.rev + 1,
        )
    }

    private fun absorbToolResult(tools: MutableMap<String, ToolRun>, m: Message) {
        if (m.role != "toolResult") return
        val id = m.toolCallId ?: return
        val old = tools[id]
        val text = m.content.filterIsInstance<Block.Text>().joinToString("\n") { it.text }
        val images = m.content.filterIsInstance<Block.Image>()
        val truncated = m.content.any { it is Block.Text && it.truncated }
        tools[id] = (old ?: ToolRun(id, m.toolName.orEmpty())).copy(
            tool = old?.tool?.takeIf { it.isNotEmpty() } ?: m.toolName.orEmpty(),
            output = text.ifEmpty { old?.output.orEmpty() },
            images = images.ifEmpty { old?.images.orEmpty() },
            truncated = truncated || (old?.truncated == true && text.length >= (old.output.length)),
            isError = m.isError,
            running = false,
        )
    }

    fun apply(v: SessionView, e: SessionEvent): SessionView {
        val next = when (e) {
            is SessionEvent.AgentStart -> v.copy(agentRunning = true)
            is SessionEvent.AgentEnd -> v.copy(agentRunning = false, state = v.state.copy(isStreaming = false))
            is SessionEvent.Msg -> {
                val idx = v.messages.indexOfFirst { it.id == e.message.id }
                val list = if (idx >= 0) v.messages.toMutableList().also { it[idx] = e.message } else v.messages + e.message
                val tools = if (e.message.role == "toolResult") {
                    LinkedHashMap(v.tools).also { absorbToolResult(it, e.message) }
                } else v.tools
                v.copy(messages = list, tools = tools)
            }
            is SessionEvent.ToolStart -> v.copy(
                tools = v.tools + (e.callId to ToolRun(e.callId, e.tool, e.args, e.intent, running = true, startedAt = System.currentTimeMillis())),
            )
            is SessionEvent.ToolUpdate -> {
                val cur = v.tools[e.callId] ?: ToolRun(e.callId)
                v.copy(tools = v.tools + (e.callId to cur.copy(output = e.output, truncated = e.truncated)))
            }
            is SessionEvent.ToolEnd -> {
                val cur = v.tools[e.callId] ?: ToolRun(e.callId)
                v.copy(tools = v.tools + (e.callId to cur.copy(output = e.output, isError = e.isError, truncated = e.truncated, running = false)))
            }
            is SessionEvent.UiReq -> {
                val others = v.pendingUi.filterNot { it.reqId == e.request.reqId }
                v.copy(pendingUi = others + e.request)
            }
            is SessionEvent.UiEnd -> v.copy(pendingUi = v.pendingUi.filterNot { it.reqId == e.reqId })
            is SessionEvent.StateEv -> v.copy(
                state = e.state,
                compacting = e.state.isCompacting,
                summary = v.summary?.let { s ->
                    s.copy(
                        model = e.state.model ?: s.model,
                        thinkingLevel = e.state.thinkingLevel ?: s.thinkingLevel,
                        approvalMode = e.state.approvalMode ?: s.approvalMode,
                        contextPercent = e.state.contextUsage?.percent ?: s.contextPercent,
                        costUsd = e.state.costUsd ?: s.costUsd,
                    )
                },
            )
            is SessionEvent.QueueEv -> v.copy(queue = e.queue)
            is SessionEvent.TodosEv -> v.copy(todos = e.phases)
            is SessionEvent.GoalEv -> v.copy(goal = e.goal)
            is SessionEvent.SubagentsEv -> v.copy(subagents = e.subagents)
            is SessionEvent.Notice -> v.copy(notices = (v.notices + SessionNotice(e.level, e.message)).takeLast(20))
            is SessionEvent.Compaction -> when (e.phase) {
                "start" -> v.copy(compacting = true)
                else -> v.copy(
                    compacting = false,
                    notices = if (e.ok == false) (v.notices + SessionNotice("error", e.message ?: "Compaction failed")).takeLast(20) else v.notices,
                )
            }
            is SessionEvent.Closed -> v.copy(phase = SessionPhase.Closed(e.reason), agentRunning = false)
            is SessionEvent.LivePhase, is SessionEvent.LiveTranscript, is SessionEvent.LiveEnd, SessionEvent.Unknown -> return v
        }
        return next.copy(rev = next.rev + 1)
    }

    /** Prepend older messages fetched by `session.history`. */
    fun prepend(v: SessionView, older: List<Message>, hasMore: Boolean): SessionView {
        val known = v.messages.mapTo(HashSet()) { it.id }
        val add = older.filter { it.id !in known }
        val tools = LinkedHashMap(v.tools)
        for (m in add) absorbToolResult(tools, m)
        return v.copy(messages = add + v.messages, hasMore = hasMore, loadingMore = false, tools = tools, rev = v.rev + 1)
    }
}
