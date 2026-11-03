package app.ompr.service

import java.util.concurrent.atomic.AtomicReference

/**
 * What the user is looking at right now. Used to suppress notifications for the session that is on screen.
 * The session screen calls [enterSession] / [leaveSession]; the process lifecycle observer toggles [appVisible].
 */
class Presence {
    @Volatile
    var appVisible: Boolean = false

    private val current = AtomicReference<Pair<String, String>?>(null)

    fun enterSession(hostId: String, sid: String) {
        current.set(hostId to sid)
    }

    fun leaveSession(hostId: String, sid: String) {
        current.compareAndSet(hostId to sid, null)
    }

    fun isViewing(hostId: String, sid: String): Boolean = appVisible && current.get() == (hostId to sid)
}
