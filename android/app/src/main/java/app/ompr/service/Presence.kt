package app.ompr.service

import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the user is looking at right now. Used to suppress notifications for the session that is on screen and to let
 * phone tools wait until the app is open. The session screen calls [enterSession] / [leaveSession]; the process
 * lifecycle observer toggles [appVisible].
 */
class Presence {
    private val _visible = MutableStateFlow(false)
    val visible: StateFlow<Boolean> = _visible.asStateFlow()

    var appVisible: Boolean
        get() = _visible.value
        set(v) {
            _visible.value = v
        }

    private val current = AtomicReference<Pair<String, String>?>(null)

    fun enterSession(hostId: String, sid: String) {
        current.set(hostId to sid)
    }

    fun leaveSession(hostId: String, sid: String) {
        current.compareAndSet(hostId to sid, null)
    }

    fun isViewing(hostId: String, sid: String): Boolean = appVisible && current.get() == (hostId to sid)
}
