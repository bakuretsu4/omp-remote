package app.ompr.tools

import androidx.fragment.app.FragmentActivity
import app.ompr.data.PhoneToolSpec
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** What a phone tool needs from the activity that is on screen: runtime permissions and the camera. */
interface ToolUiHost {
    val activity: FragmentActivity

    /** Asks for runtime permissions (a no-op for those already granted). Returns permission → granted. */
    suspend fun ensurePermissions(vararg permissions: String): Map<String, Boolean>

    /** Opens the camera. Returns the saved JPEG, or null when the user backs out. [facing] is `back`, `front` or null. */
    suspend fun takePhoto(facing: String?): File?
}

/** One "Allow the agent to …?" question waiting for the user. */
class ToolRequest(
    val id: Long,
    val tool: PhoneToolSpec,
    /** What exactly is being asked, e.g. the text the agent wants to copy. */
    val detail: String,
    val hostName: String,
) {
    val decision = CompletableDeferred<Boolean>()
}

/**
 * Pending consent questions plus the activity (when one is on screen) that can run tools needing UI.
 * Process-wide: the handler talks to it from background coroutines, the activity and its dialog observe it.
 */
class ToolRuntime {
    /** The started [MainActivity], or null while the app is in the background. */
    val host = MutableStateFlow<ToolUiHost?>(null)

    private val _requests = MutableStateFlow<List<ToolRequest>>(emptyList())
    val requests: StateFlow<List<ToolRequest>> = _requests.asStateFlow()

    private val seq = AtomicLong()

    fun newRequest(tool: PhoneToolSpec, detail: String, hostName: String): ToolRequest {
        val r = ToolRequest(seq.incrementAndGet(), tool, detail, hostName)
        _requests.update { it + r }
        return r
    }

    fun finish(r: ToolRequest) {
        _requests.update { it - r }
    }
}
