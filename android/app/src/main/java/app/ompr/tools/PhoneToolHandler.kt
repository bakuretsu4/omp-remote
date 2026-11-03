package app.ompr.tools

import android.content.Context
import android.os.SystemClock
import app.ompr.data.HostEvent
import app.ompr.data.PhoneToolPolicy
import app.ompr.data.PhoneToolSpec
import app.ompr.data.PhoneTools
import app.ompr.data.SettingsStore
import app.ompr.data.ToolGate
import app.ompr.net.HostConnection
import app.ompr.net.HostToolHandler
import app.ompr.net.HostToolResult
import app.ompr.service.ConnectionService
import app.ompr.service.Notifier
import app.ompr.service.Presence
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * "Phone as agent tools" (docs/PROTOCOL.md §6.6). Every tool starts Off. An agent that is prompt-injected could call any of
 * these, so the user decides per tool: Off, Ask (confirm each call) or Allow. Whatever Android restricts to the foreground
 * (clipboard read, location, camera) waits for the user to open the app, with a notification if it is in the background.
 */
class PhoneToolHandler(
    private val context: Context,
    private val settings: SettingsStore,
    private val presence: Presence,
    private val runtime: ToolRuntime,
    private val device: DeviceTools,
    private val notifier: Notifier,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) : HostToolHandler {
    /** Capabilities to advertise; a change means the connection must re-handshake so the bridge re-registers the tools. */
    val capsFlow: Flow<List<String>> = settings.hostToolModes.map(PhoneTools::capsFor).distinctUntilChanged()

    override suspend fun supportedCaps(): List<String> = capsFlow.first()

    private val uiLock = Mutex()
    private val declinedAt = ConcurrentHashMap<String, Long>()
    private val notifyTimes = ArrayDeque<Long>()

    private enum class Outcome { GRANTED, DECLINED, NO_RESPONSE }

    override suspend fun call(conn: HostConnection, call: HostEvent.HostToolCall): HostToolResult {
        val spec = PhoneTools.spec(call.tool) ?: return HostToolResult.failure("Unknown phone tool: ${call.tool}")
        val deadline = now() + BUDGET_MS
        val gate = PhoneToolPolicy.gate(settings.getHostToolMode(spec.id), spec, presence.appVisible)
        if (gate == ToolGate.Disabled) return HostToolResult.failure("The user has not allowed ${spec.id} on their phone")
        declinedAt[spec.id]?.let {
            if (now() - it < COOLDOWN_MS) return HostToolResult.failure("The user declined ${spec.id} a moment ago. Do not ask again right now.")
        }
        val proceed: suspend () -> HostToolResult = {
            var refused: HostToolResult? = null
            if (gate is ToolGate.WaitForUser) {
                when (waitForUser(conn, spec, call.args, gate.consent, deadline)) {
                    Outcome.GRANTED -> Unit
                    Outcome.DECLINED -> {
                        declinedAt[spec.id] = now()
                        refused = HostToolResult.failure("The user declined")
                    }
                    Outcome.NO_RESPONSE -> refused = HostToolResult.failure("The user did not respond in time")
                }
            }
            refused ?: execute(spec, call.args, deadline)
        }
        return if (spec.needsForeground || gate is ToolGate.WaitForUser) withForegroundService(proceed) else proceed()
    }

    private val serviceLock = Any()
    private var leases = 0
    private var startedByUs = false

    /**
     * Android withholds the network from an app that is in the background without a foreground service, and the system camera,
     * a permission dialog or a notification the user has to tap all put the app there. So the connection service runs for the
     * duration of the call (unless "Keep connected" already does), and the bridge does not see the phone disconnect.
     * Overlapping calls share one start; the last one out stops it.
     */
    private suspend fun withForegroundService(block: suspend () -> HostToolResult): HostToolResult {
        val keep = settings.isKeepConnected()
        synchronized(serviceLock) {
            if (leases++ == 0 && !keep) startedByUs = ConnectionService.start(context)
        }
        try {
            return block()
        } finally {
            val keepNow = withContext(NonCancellable) { settings.isKeepConnected() }
            synchronized(serviceLock) {
                if (--leases == 0 && startedByUs) {
                    startedByUs = false
                    if (!keepNow) ConnectionService.stop(context)
                }
            }
        }
    }

    private suspend fun waitForUser(conn: HostConnection, spec: PhoneToolSpec, args: JsonObject, consent: Boolean, deadline: Long): Outcome {
        val hostName = conn.info.value?.name ?: "your PC"
        val request = if (consent) runtime.newRequest(spec, describe(spec, args), hostName) else null
        if (!presence.appVisible) notifier.showToolWaiting(spec.action, hostName)
        try {
            val answer = withTimeoutOrNull((deadline - now()).coerceAtLeast(1)) {
                if (request != null) request.decision.await() else {
                    presence.visible.first { it }
                    true
                }
            }
            return when (answer) {
                null -> Outcome.NO_RESPONSE
                true -> Outcome.GRANTED
                false -> Outcome.DECLINED
            }
        } finally {
            request?.let(runtime::finish)
            notifier.cancelToolWaiting()
        }
    }

    private suspend fun execute(spec: PhoneToolSpec, args: JsonObject, deadline: Long): HostToolResult = try {
        withTimeoutOrNull((deadline - now()).coerceAtLeast(MIN_RUN_MS)) { dispatch(spec, args) }
            ?: HostToolResult.failure("Timed out waiting for the phone")
    } catch (e: CancellationException) {
        throw e
    } catch (e: SecurityException) {
        HostToolResult.failure("Android refused: ${e.message}")
    } catch (e: Exception) {
        HostToolResult.failure(e.message ?: e.javaClass.simpleName)
    }

    private suspend fun dispatch(spec: PhoneToolSpec, args: JsonObject): HostToolResult {
        val host: suspend () -> ToolUiHost = { runtime.host.filterNotNull().first() }
        return when (spec.id) {
            PhoneTools.LOCATION -> uiLock.withLock { device.location(host) }
            PhoneTools.CLIPBOARD_GET -> device.clipboardGet()
            PhoneTools.CLIPBOARD_SET -> device.clipboardSet(args.text("text") ?: return HostToolResult.failure("text is required"))
            PhoneTools.NOTIFY -> {
                if (!allowNotification()) return HostToolResult.failure("Too many notifications; wait a minute")
                device.notify(args.text("title") ?: "Message from the agent", args.text("message") ?: return HostToolResult.failure("message is required"))
            }
            PhoneTools.CAMERA -> uiLock.withLock { device.photo(host(), args.text("facing")) }
            else -> HostToolResult.failure("Unknown phone tool: ${spec.id}")
        }
    }

    /** At most [MAX_NOTIFICATIONS] agent notifications per minute, so a looping agent cannot spam the phone. */
    private fun allowNotification(): Boolean = synchronized(notifyTimes) {
        val t = now()
        while (notifyTimes.isNotEmpty() && t - notifyTimes.first() > 60_000) notifyTimes.removeFirst()
        if (notifyTimes.size >= MAX_NOTIFICATIONS) return false
        notifyTimes.addLast(t)
        true
    }

    private fun describe(spec: PhoneToolSpec, args: JsonObject): String = when (spec.id) {
        PhoneTools.CLIPBOARD_SET -> "Text to copy:\n" + (args.text("text") ?: "").take(300)
        PhoneTools.CAMERA -> "Opens the ${args.text("facing") ?: "back"} camera. You take the photo; it is sent to the agent."
        else -> spec.summary
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    companion object {
        /** The bridge gives up on a call after 60 s; stay below that so our answer still arrives. */
        const val BUDGET_MS = 55_000L
        const val COOLDOWN_MS = 60_000L
        private const val MIN_RUN_MS = 2_000L
        private const val MAX_NOTIFICATIONS = 10
    }
}
