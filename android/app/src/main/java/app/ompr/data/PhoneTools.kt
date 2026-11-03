package app.ompr.data

/** How the user lets agents use one phone tool (Settings → Phone tools). Every tool starts [OFF]. */
enum class ToolMode(val id: String) {
    OFF("off"),
    /** Confirm every single call on screen. */
    ASK("ask"),
    ALLOW("allow");

    companion object {
        fun parse(id: String?): ToolMode = entries.firstOrNull { it.id == id } ?: OFF
    }
}

/** Static description of one `phone_*` tool (docs/PROTOCOL.md §6.6). */
data class PhoneToolSpec(
    val id: String,
    /** Device capability advertised in HELLO (`location|clipboard|notify|camera`). */
    val cap: String,
    val title: String,
    val summary: String,
    /** Phrase for confirmations and notifications: "Allow the agent to …?". */
    val action: String,
    /** Android only lets the app do this while it is on screen, or it needs the user to act on screen. */
    val needsForeground: Boolean,
    val allowedModes: List<ToolMode>,
)

object PhoneTools {
    const val LOCATION = "phone_location"
    const val CLIPBOARD_GET = "phone_clipboard_get"
    const val CLIPBOARD_SET = "phone_clipboard_set"
    const val NOTIFY = "phone_notify"
    const val CAMERA = "phone_camera_photo"

    private val ALL_MODES = listOf(ToolMode.OFF, ToolMode.ASK, ToolMode.ALLOW)

    val all: List<PhoneToolSpec> = listOf(
        PhoneToolSpec(
            LOCATION, "location", "Location", "Your current GPS position.",
            "share your current location", needsForeground = true, allowedModes = ALL_MODES,
        ),
        PhoneToolSpec(
            CLIPBOARD_GET, "clipboard", "Read clipboard", "What you last copied. Can contain passwords; leave on Ask.",
            "read what is on your clipboard", needsForeground = true, allowedModes = ALL_MODES,
        ),
        PhoneToolSpec(
            CLIPBOARD_SET, "clipboard", "Write clipboard", "Put text on your clipboard. You might paste it somewhere without checking; leave on Ask.",
            "put text on your clipboard", needsForeground = false, allowedModes = ALL_MODES,
        ),
        PhoneToolSpec(
            NOTIFY, "notify", "Notifications", "Show you a notification when a result is ready.",
            "show you a notification", needsForeground = false, allowedModes = listOf(ToolMode.OFF, ToolMode.ALLOW),
        ),
        PhoneToolSpec(
            CAMERA, "camera", "Camera", "Ask you to take a photo and send it to the agent.",
            "ask you to take a photo", needsForeground = true, allowedModes = ALL_MODES,
        ),
    )

    fun spec(id: String): PhoneToolSpec? = all.firstOrNull { it.id == id }

    /** Capabilities to advertise in HELLO: one per capability with at least one tool that is not switched off. */
    fun capsFor(modes: Map<String, ToolMode>): List<String> =
        all.filter { (modes[it.id] ?: ToolMode.OFF) != ToolMode.OFF }.map { it.cap }.distinct()
}

/** What to do with an incoming call, given the tool's mode and whether the app is on screen. */
sealed interface ToolGate {
    /** The user has not allowed this tool: answer with an error, touch nothing. */
    data object Disabled : ToolGate

    data object RunNow : ToolGate

    /** The user has to be involved first. [consent] = show the Allow/Deny dialog; otherwise just wait for the app to open. */
    data class WaitForUser(val consent: Boolean) : ToolGate
}

object PhoneToolPolicy {
    fun gate(mode: ToolMode, spec: PhoneToolSpec, appVisible: Boolean): ToolGate = when {
        mode == ToolMode.OFF || mode !in spec.allowedModes -> ToolGate.Disabled
        mode == ToolMode.ASK -> ToolGate.WaitForUser(consent = true)
        spec.needsForeground && !appVisible -> ToolGate.WaitForUser(consent = false)
        else -> ToolGate.RunNow
    }
}

/** Fits a photo into one wire frame: `hosttool.result` is not chunked and a frame carries at most 512 KiB. */
object PhotoFit {
    const val MAX_BYTES = 300_000

    /** (longest side in px, JPEG quality), largest first. */
    val STEPS: List<Pair<Int, Int>> = listOf(1280 to 75, 1280 to 60, 1024 to 60, 800 to 55, 640 to 50)

    /** The first encoding that fits [maxBytes]; null when even the smallest step is too big. */
    fun fit(
        maxBytes: Int = MAX_BYTES,
        steps: List<Pair<Int, Int>> = STEPS,
        encode: (maxSide: Int, quality: Int) -> ByteArray,
    ): ByteArray? {
        for ((side, quality) in steps) {
            val bytes = encode(side, quality)
            if (bytes.size <= maxBytes) return bytes
        }
        return null
    }
}
