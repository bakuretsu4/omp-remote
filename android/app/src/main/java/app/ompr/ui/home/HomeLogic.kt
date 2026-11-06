package app.ompr.ui.home

import app.ompr.data.AttentionItem
import app.ompr.data.AttentionKinds
import app.ompr.data.HostEvent
import app.ompr.data.SessionKind
import app.ompr.data.SessionStatus
import app.ompr.data.SessionSummary
import app.ompr.net.ConnState
import app.ompr.net.SessionList
import java.util.Calendar
import java.util.TimeZone

/*
 * Everything the unified Home and the per-PC dashboard decide, as plain Kotlin: which section a session belongs to, the
 * order inside a section, how recents are grouped by day, the filter and the empty states. The composables only draw
 * a [HomeModel].
 */

/** How a PC is doing, reduced to what the UI shows. */
enum class LinkState { CONNECTED, CONNECTING, UNREACHABLE }

fun linkStateOf(s: ConnState): LinkState = when (s) {
    is ConnState.Connected -> LinkState.CONNECTED
    // Idle is the instant between acquiring the connection and the first attempt.
    is ConnState.Connecting, ConnState.Idle -> LinkState.CONNECTING
    is ConnState.Offline, is ConnState.Fatal -> LinkState.UNREACHABLE
}

/** Why a PC cannot be reached, for the banner. */
fun reasonOf(s: ConnState): String? = when (s) {
    is ConnState.Offline -> s.reason
    is ConnState.Fatal -> s.reason
    else -> null
}

/** One paired PC and what we currently know about it. */
data class HostInput(
    val hostId: String,
    val name: String,
    val colorIndex: Int,
    val link: LinkState,
    val sessions: SessionList = SessionList(),
    /** Unresolved attention items (approvals and questions) of this PC. */
    val attention: List<AttentionItem> = emptyList(),
    val reason: String? = null,
)

enum class Bucket { NEEDS_YOU, RUNNING, OPEN, RECENT }

/** A session together with the PC it lives on. */
data class HomeSession(
    val hostId: String,
    val hostName: String,
    val colorIndex: Int,
    val summary: SessionSummary,
    val bucket: Bucket,
    /** What the session is waiting for ("Approve bash: ls?"); only on [Bucket.NEEDS_YOU]. */
    val ask: String? = null,
    /** Unresolved asks beyond the first one. */
    val moreAsks: Int = 0,
) {
    val key: String get() = "$hostId/${summary.sid}"
}

enum class DayGroup { TODAY, YESTERDAY, EARLIER }

data class RecentGroup(val day: DayGroup, val items: List<HomeSession>)

/** A PC that cannot be reached right now. */
data class UnreachableHost(val hostId: String, val name: String, val colorIndex: Int, val reason: String?)

enum class HomeEmpty {
    /** There is something to show. */
    NONE,

    /** Still waiting for the first session list of at least one PC. */
    LOADING,

    /** Every shown PC is unreachable. */
    UNREACHABLE,

    /** Connected and loaded, but no sessions exist. */
    NO_SESSIONS,
}

data class HomeModel(
    val needsYou: List<HomeSession>,
    val running: List<HomeSession>,
    val open: List<HomeSession>,
    val recent: List<RecentGroup>,
    /** Recent sessions not shown because of the cap. */
    val recentHidden: Int,
    val unreachable: List<UnreachableHost>,
    val empty: HomeEmpty,
) {
    val recentShown: Int get() = recent.sumOf { it.items.size }
    val isEmpty: Boolean get() = needsYou.isEmpty() && running.isEmpty() && open.isEmpty() && recent.isEmpty()
}

const val DEFAULT_RECENT_CAP = 8

// ───────────────────────── colours ─────────────────────────

/**
 * A stable palette slot per PC. Each PC prefers the slot its id hashes to; PCs are processed in pairing order and take
 * the next free slot when the preferred one is taken, so adding a PC never recolours an existing one and no two PCs
 * share a slot until the palette runs out.
 */
fun hostColorIndices(hosts: List<Pair<String, Long>>, paletteSize: Int): Map<String, Int> {
    require(paletteSize > 0)
    val taken = HashSet<Int>()
    val out = LinkedHashMap<String, Int>()
    for ((id, _) in hosts.sortedWith(compareBy({ it.second }, { it.first }))) {
        var slot = Math.floorMod(id.hashCode(), paletteSize)
        if (taken.size < paletteSize) while (slot in taken) slot = (slot + 1) % paletteSize
        taken += slot
        out[id] = slot
    }
    return out
}

// ───────────────────────── attention ─────────────────────────

private fun actionable(kind: String) = kind == AttentionKinds.APPROVAL || kind == AttentionKinds.QUESTION

/** The unresolved approvals and questions of a full `attention.list` answer. */
fun actionableAttention(items: List<AttentionItem>): List<AttentionItem> =
    items.filter { !it.resolved && actionable(it.kind) }

/** Folds one live host event into the tracked unresolved approvals and questions. */
fun applyAttentionEvent(current: List<AttentionItem>, ev: HostEvent): List<AttentionItem> = when (ev) {
    is HostEvent.Attention -> {
        val rest = current.filter { it.id != ev.item.id }
        if (!ev.item.resolved && actionable(ev.item.kind)) rest + ev.item else rest
    }
    is HostEvent.AttentionResolved -> current.filter { it.id != ev.id }
    else -> current
}

/** "Approve bash: ls?" for an approval, "Question: Which database?" for a question. */
fun askLabel(item: AttentionItem): String {
    val text = item.summary.trim().replace(Regex("\\s+"), " ")
    return when (item.kind) {
        AttentionKinds.APPROVAL -> text.ifEmpty { "Approval needed" }
        else -> if (text.isEmpty()) "Question" else "Question: $text"
    }
}

// ───────────────────────── sections ─────────────────────────

private val sessionOrder: Comparator<HomeSession> =
    compareByDescending<HomeSession> { it.summary.lastActivity }
        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.hostName }
        .thenBy { it.summary.sid }

/** True when the session waits on the user: an unresolved approval/question, status waiting, or a pending UI request. */
private fun waiting(s: SessionSummary, asks: List<AttentionItem>): Boolean =
    asks.isNotEmpty() || s.status == SessionStatus.WAITING || s.pendingUi > 0

/**
 * The selected chip only counts while that PC still exists (a removed PC falls back to "All").
 */
fun effectiveFilter(hosts: List<HostInput>, selected: String?): String? =
    selected?.takeIf { id -> hosts.any { it.hostId == id } }

fun buildHome(
    hosts: List<HostInput>,
    filterHostId: String?,
    now: Long,
    zone: TimeZone = TimeZone.getDefault(),
    showAllRecent: Boolean = false,
    recentCap: Int = DEFAULT_RECENT_CAP,
): HomeModel {
    val shown = effectiveFilter(hosts, filterHostId).let { f -> if (f == null) hosts else hosts.filter { it.hostId == f } }

    val needs = ArrayList<HomeSession>()
    val running = ArrayList<HomeSession>()
    val open = ArrayList<HomeSession>()
    val recent = ArrayList<HomeSession>()
    for (h in shown) {
        // An unreachable PC contributes no sessions (its cached list may be stale); it gets a banner instead.
        if (h.link == LinkState.UNREACHABLE) continue
        for (s in h.sessions.items) {
            if (s.kind == SessionKind.RECENT) {
                recent += HomeSession(h.hostId, h.name, h.colorIndex, s, Bucket.RECENT)
                continue
            }
            val asks = h.attention.filter { it.sid == s.sid && !it.resolved && actionable(it.kind) }.sortedByDescending { it.ts }
            when {
                waiting(s, asks) -> {
                    val first = asks.firstOrNull()
                    val label = first?.let { askLabel(it) } ?: when {
                        s.pendingUi > 1 -> "${s.pendingUi} items need your answer"
                        else -> "Waiting for your answer"
                    }
                    needs += HomeSession(h.hostId, h.name, h.colorIndex, s, Bucket.NEEDS_YOU, label, (asks.size - 1).coerceAtLeast(0))
                }
                s.status == SessionStatus.WORKING -> running += HomeSession(h.hostId, h.name, h.colorIndex, s, Bucket.RUNNING)
                else -> open += HomeSession(h.hostId, h.name, h.colorIndex, s, Bucket.OPEN)
            }
        }
    }
    needs.sortWith(sessionOrder)
    running.sortWith(sessionOrder)
    open.sortWith(sessionOrder)
    recent.sortWith(sessionOrder)

    val visibleRecent = if (showAllRecent) recent else recent.take(recentCap.coerceAtLeast(0))
    val groups = visibleRecent.groupBy { dayGroup(it.summary.lastActivity, now, zone) }
    val recentGroups = DayGroup.entries.mapNotNull { d -> groups[d]?.let { RecentGroup(d, it) } }

    val unreachable = shown.filter { it.link == LinkState.UNREACHABLE }.map { UnreachableHost(it.hostId, it.name, it.colorIndex, it.reason) }

    val any = needs.isNotEmpty() || running.isNotEmpty() || open.isNotEmpty() || recent.isNotEmpty()
    val empty = when {
        any -> HomeEmpty.NONE
        shown.isNotEmpty() && shown.all { it.link == LinkState.UNREACHABLE } -> HomeEmpty.UNREACHABLE
        shown.any { it.link != LinkState.UNREACHABLE && !it.sessions.loaded } -> HomeEmpty.LOADING
        else -> HomeEmpty.NO_SESSIONS
    }
    return HomeModel(needs, running, open, recentGroups, recent.size - visibleRecent.size, unreachable, empty)
}

// ───────────────────────── days ─────────────────────────

/**
 * Today / Yesterday / Earlier by calendar day in [zone]. Day starts are computed with calendar arithmetic, so a 23 or 25
 * hour day (DST change) is bucketed correctly. A timestamp in the future (clock skew) counts as today; an unknown one
 * (<= 0) as earlier.
 */
fun dayGroup(ts: Long, now: Long, zone: TimeZone = TimeZone.getDefault()): DayGroup {
    if (ts <= 0) return DayGroup.EARLIER
    val cal = Calendar.getInstance(zone).apply { timeInMillis = now }
    cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
    val todayStart = cal.timeInMillis
    cal.add(Calendar.DAY_OF_MONTH, -1)
    val yesterdayStart = cal.timeInMillis
    return when {
        ts >= todayStart -> DayGroup.TODAY
        ts >= yesterdayStart -> DayGroup.YESTERDAY
        else -> DayGroup.EARLIER
    }
}

fun DayGroup.label(): String = when (this) {
    DayGroup.TODAY -> "Today"
    DayGroup.YESTERDAY -> "Yesterday"
    DayGroup.EARLIER -> "Earlier"
}
