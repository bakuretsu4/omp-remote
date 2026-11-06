package app.ompr.ui.home

import app.ompr.data.AttentionItem
import app.ompr.data.AttentionKinds
import app.ompr.data.HostEvent
import app.ompr.data.ModelRef
import app.ompr.data.SessionKind
import app.ompr.data.SessionStatus
import app.ompr.data.SessionSummary
import app.ompr.net.ConnState
import app.ompr.net.OfflineHint
import app.ompr.net.SessionList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class HomeLogicTest {
    private val utc = TimeZone.getTimeZone("UTC")
    private val min = 60_000L
    private val hour = 60 * min
    private val day = 24 * hour

    /** 2024-06-15 14:30 UTC. */
    private val now = Calendar.getInstance(utc).apply { clear(); set(2024, Calendar.JUNE, 15, 14, 30, 0) }.timeInMillis
    private val todayStart = now - (14 * hour + 30 * min)

    private fun s(sid: String, kind: String = SessionKind.MANAGED, status: String = SessionStatus.IDLE, last: Long = now - hour, pending: Int = 0, title: String = sid, cwd: String = "/p/$sid") =
        SessionSummary(sid = sid, kind = kind, title = title, cwd = cwd, status = status, lastActivity = last, pendingUi = pending, sessionFile = if (kind == SessionKind.RECENT) "/f/$sid.jsonl" else null)

    private fun attn(sid: String, kind: String = AttentionKinds.APPROVAL, summary: String = "Approve bash: ls?", id: String = "a_$sid", resolved: Boolean = false, ts: Long = 1) =
        AttentionItem(id = id, ts = ts, sid = sid, kind = kind, summary = summary, resolved = resolved)

    private fun host(id: String, name: String = id, items: List<SessionSummary> = emptyList(), link: LinkState = LinkState.CONNECTED, loaded: Boolean = true, attention: List<AttentionItem> = emptyList(), color: Int = 0) =
        HostInput(id, name, color, link, SessionList(items, loaded = loaded), attention)

    private fun build(hosts: List<HostInput>, filter: String? = null, all: Boolean = false, cap: Int = DEFAULT_RECENT_CAP) =
        buildHome(hosts, filter, now, utc, all, cap)

    private fun List<HomeSession>.sids() = map { it.summary.sid }

    // ───────────── sections ─────────────

    @Test
    fun sessionsLandInTheRightSection() {
        val h = host(
            "A",
            items = listOf(
                s("wait", status = SessionStatus.WAITING),
                s("pend", pending = 2),
                s("work", status = SessionStatus.WORKING),
                s("idle"),
                s("tui", kind = SessionKind.TUI),
                s("off", status = SessionStatus.OFFLINE, kind = SessionKind.TUI),
                s("rec", kind = SessionKind.RECENT),
            ),
        )
        val m = build(listOf(h))
        assertEquals(setOf("wait", "pend"), m.needsYou.sids().toSet())
        assertEquals(listOf("work"), m.running.sids())
        assertEquals(setOf("idle", "tui", "off"), m.open.sids().toSet())
        assertEquals(listOf("rec"), m.recent.flatMap { it.items }.sids())
        assertEquals(HomeEmpty.NONE, m.empty)
    }

    @Test
    fun unresolvedApprovalOrQuestionMakesAnIdleSessionNeedYou() {
        val h = host("A", items = listOf(s("x"), s("y"), s("z")), attention = listOf(attn("x"), attn("y", AttentionKinds.QUESTION, "Which db?")))
        val m = build(listOf(h))
        assertEquals(setOf("x", "y"), m.needsYou.sids().toSet())
        assertEquals(listOf("z"), m.open.sids())
    }

    @Test
    fun resolvedOrNonActionableAttentionDoesNotCount() {
        val h = host(
            "A",
            items = listOf(s("x"), s("y"), s("z")),
            attention = listOf(attn("x", resolved = true), attn("y", AttentionKinds.DONE, "Finished"), attn("z", AttentionKinds.ERROR, "boom")),
        )
        val m = build(listOf(h))
        assertTrue(m.needsYou.isEmpty())
        assertEquals(3, m.open.size)
    }

    @Test
    fun attentionOnARecentSessionDoesNotPromoteIt() {
        val h = host("A", items = listOf(s("r", kind = SessionKind.RECENT)), attention = listOf(attn("r")))
        val m = build(listOf(h))
        assertTrue(m.needsYou.isEmpty())
        assertEquals(1, m.recentShown)
    }

    @Test
    fun workingSessionWithAnApprovalIsNeedsYouNotRunning() {
        val h = host("A", items = listOf(s("x", status = SessionStatus.WORKING)), attention = listOf(attn("x")))
        val m = build(listOf(h))
        assertEquals(listOf("x"), m.needsYou.sids())
        assertTrue(m.running.isEmpty())
    }

    // ───────────── what is asked ─────────────

    @Test
    fun askShowsWhatIsAsked() {
        val h = host(
            "A",
            items = listOf(s("a"), s("q"), s("w", status = SessionStatus.WAITING), s("p2", pending = 2)),
            attention = listOf(attn("a", summary = "Approve bash: echo hi?"), attn("q", AttentionKinds.QUESTION, "Which database?")),
        )
        val by = build(listOf(h)).needsYou.associateBy { it.summary.sid }
        assertEquals("Approve bash: echo hi?", by.getValue("a").ask)
        assertEquals("Question: Which database?", by.getValue("q").ask)
        assertEquals("Waiting for your answer", by.getValue("w").ask)
        assertEquals("2 items need your answer", by.getValue("p2").ask)
    }

    @Test
    fun severalAsksShowTheNewestAndCountTheRest() {
        val h = host("A", items = listOf(s("x")), attention = listOf(attn("x", id = "1", ts = 1, summary = "old"), attn("x", id = "2", ts = 5, summary = "newest"), attn("x", AttentionKinds.QUESTION, "q", id = "3", ts = 3)))
        val it = build(listOf(h)).needsYou.single()
        assertEquals("newest", it.ask)
        assertEquals(2, it.moreAsks)
    }

    @Test
    fun askLabelFallbacks() {
        assertEquals("Approval needed", askLabel(attn("x", summary = "  ")))
        assertEquals("Question", askLabel(attn("x", AttentionKinds.QUESTION, "")))
        assertEquals("Approve bash: a b?", askLabel(attn("x", summary = "Approve bash:\n a   b?")))
    }

    // ───────────── order ─────────────

    @Test
    fun sectionsAreNewestFirstWithStableTieBreaks() {
        val a = host("A", "alpha", items = listOf(s("old", last = now - day), s("new", last = now - min), s("tie2", last = now - hour)))
        val b = host("B", "Beta", items = listOf(s("mid", last = now - 5 * hour), s("tie1", last = now - hour)))
        val m = build(listOf(a, b))
        // tie on time: host name (case-insensitive) first, then sid
        assertEquals(listOf("new", "tie2", "tie1", "mid", "old"), m.open.sids())
    }

    @Test
    fun needsYouSortsByActivityToo() {
        val h = host("A", items = listOf(s("a", pending = 1, last = now - 10 * min), s("b", pending = 1, last = now - min)))
        assertEquals(listOf("b", "a"), build(listOf(h)).needsYou.sids())
    }

    @Test
    fun sessionsOfAllPcsAreMerged() {
        val a = host("A", items = listOf(s("a1", last = now - 3 * min)))
        val b = host("B", items = listOf(s("b1", last = now - 1 * min)))
        val m = build(listOf(a, b))
        assertEquals(listOf("b1", "a1"), m.open.sids())
        assertEquals(listOf("B", "A"), m.open.map { it.hostId })
    }

    // ───────────── recents ─────────────

    @Test
    fun recentGroupsByCalendarDayBoundaries() {
        assertEquals(DayGroup.TODAY, dayGroup(todayStart, now, utc))
        assertEquals(DayGroup.TODAY, dayGroup(now, now, utc))
        assertEquals(DayGroup.YESTERDAY, dayGroup(todayStart - 1, now, utc))
        assertEquals(DayGroup.YESTERDAY, dayGroup(todayStart - day, now, utc))
        assertEquals(DayGroup.EARLIER, dayGroup(todayStart - day - 1, now, utc))
        assertEquals(DayGroup.EARLIER, dayGroup(now - 400 * day, now, utc))
    }

    @Test
    fun futureAndUnknownTimestamps() {
        assertEquals(DayGroup.TODAY, dayGroup(now + 3 * day, now, utc))
        assertEquals(DayGroup.EARLIER, dayGroup(0, now, utc))
        assertEquals(DayGroup.EARLIER, dayGroup(-5, now, utc))
    }

    @Test
    fun dayBoundariesFollowTheTimeZone() {
        val tokyo = TimeZone.getTimeZone("Asia/Tokyo") // UTC+9: 14:30 UTC is 23:30 on the 15th there
        assertEquals(DayGroup.TODAY, dayGroup(now - 23 * hour, now, tokyo))
        // 2024-06-15 00:30 Tokyo = 2024-06-14 15:30 UTC
        assertEquals(DayGroup.YESTERDAY, dayGroup(now - 23 * hour - 31 * min, now, tokyo))
        // Same instant seen from UTC is "yesterday" at 15:30 the day before.
        assertEquals(DayGroup.YESTERDAY, dayGroup(now - 23 * hour, now, utc))
    }

    @Test
    fun dstDayLengthsDoNotShiftTheBuckets() {
        val ny = TimeZone.getTimeZone("America/New_York")
        // 2024-03-10 spring forward (23 h day). Now: 2024-03-11 09:00 local.
        val n = Calendar.getInstance(ny).apply { clear(); set(2024, Calendar.MARCH, 11, 9, 0, 0) }.timeInMillis
        val sunday0030 = Calendar.getInstance(ny).apply { clear(); set(2024, Calendar.MARCH, 10, 0, 30, 0) }.timeInMillis
        val saturday2330 = Calendar.getInstance(ny).apply { clear(); set(2024, Calendar.MARCH, 9, 23, 30, 0) }.timeInMillis
        assertEquals(DayGroup.YESTERDAY, dayGroup(sunday0030, n, ny))
        assertEquals(DayGroup.EARLIER, dayGroup(saturday2330, n, ny))
    }

    @Test
    fun recentIsGroupedInDayOrderAndLabelled() {
        val items = listOf(
            s("e", SessionKind.RECENT, last = now - 5 * day),
            s("t1", SessionKind.RECENT, last = now - hour),
            s("y", SessionKind.RECENT, last = todayStart - hour),
            s("t2", SessionKind.RECENT, last = now - 2 * hour),
        )
        val m = build(listOf(host("A", items = items)))
        assertEquals(listOf(DayGroup.TODAY, DayGroup.YESTERDAY, DayGroup.EARLIER), m.recent.map { it.day })
        assertEquals(listOf("t1", "t2"), m.recent[0].items.sids())
        assertEquals(listOf("Today", "Yesterday", "Earlier"), m.recent.map { it.day.label() })
    }

    @Test
    fun emptyDayGroupsAreOmitted() {
        val m = build(listOf(host("A", items = listOf(s("e", SessionKind.RECENT, last = now - 9 * day)))))
        assertEquals(listOf(DayGroup.EARLIER), m.recent.map { it.day })
    }

    @Test
    fun recentIsCappedUntilShowMore() {
        val items = (1..12).map { s("r$it", SessionKind.RECENT, last = now - it * min) }
        val h = host("A", items = items)
        val capped = build(listOf(h), cap = 5)
        assertEquals(5, capped.recentShown)
        assertEquals(7, capped.recentHidden)
        assertEquals(listOf("r1", "r2", "r3", "r4", "r5"), capped.recent.flatMap { it.items }.sids())
        val all = build(listOf(h), all = true, cap = 5)
        assertEquals(12, all.recentShown)
        assertEquals(0, all.recentHidden)
    }

    @Test
    fun capAppliesAcrossDayGroupsInOrder() {
        val items = listOf(
            s("t", SessionKind.RECENT, last = now - hour),
            s("y1", SessionKind.RECENT, last = todayStart - hour),
            s("y2", SessionKind.RECENT, last = todayStart - 2 * hour),
            s("e", SessionKind.RECENT, last = now - 8 * day),
        )
        val m = build(listOf(host("A", items = items)), cap = 2)
        assertEquals(listOf(DayGroup.TODAY, DayGroup.YESTERDAY), m.recent.map { it.day })
        assertEquals(2, m.recentHidden)
    }

    @Test
    fun defaultCapIsEight() {
        val items = (1..20).map { s("r$it", SessionKind.RECENT, last = now - it * min) }
        assertEquals(8, build(listOf(host("A", items = items))).recentShown)
    }

    // ───────────── filter ─────────────

    @Test
    fun filterKeepsOnlyThatPc() {
        val a = host("A", items = listOf(s("a1"), s("a2", status = SessionStatus.WORKING)))
        val b = host("B", items = listOf(s("b1", pending = 1), s("b2", SessionKind.RECENT)))
        val onlyB = build(listOf(a, b), filter = "B")
        assertEquals(listOf("b1"), onlyB.needsYou.sids())
        assertTrue(onlyB.open.isEmpty() && onlyB.running.isEmpty())
        assertEquals(1, onlyB.recentShown)
        val all = build(listOf(a, b), filter = null)
        assertEquals(4, all.needsYou.size + all.running.size + all.open.size + all.recentShown)
    }

    @Test
    fun filterForARemovedPcFallsBackToAll() {
        val a = host("A", items = listOf(s("a1")))
        assertNull(effectiveFilter(listOf(a), "gone"))
        assertEquals("A", effectiveFilter(listOf(a), "A"))
        assertNull(effectiveFilter(listOf(a), null))
        assertEquals(listOf("a1"), build(listOf(a), filter = "gone").open.sids())
    }

    // ───────────── unreachable PCs and empty states ─────────────

    @Test
    fun unreachablePcGetsABannerAndItsSessionsAreAbsent() {
        val a = host("A", "carcosa", items = listOf(s("a1")))
        val b = HostInput("B", "alyx", 1, LinkState.UNREACHABLE, SessionList(listOf(s("stale")), loaded = true), reason = "Cannot reach the relay")
        val m = build(listOf(a, b))
        assertEquals(listOf("a1"), m.open.sids())
        assertEquals(listOf(UnreachableHost("B", "alyx", 1, "Cannot reach the relay")), m.unreachable)
        assertEquals(HomeEmpty.NONE, m.empty)
    }

    @Test
    fun unreachablePcDoesNotBlockTheOthersAndConnectingKeepsCachedSessions() {
        val a = host("A", link = LinkState.CONNECTING, items = listOf(s("cached")))
        val b = host("B", link = LinkState.UNREACHABLE, items = listOf(s("x")))
        val m = build(listOf(a, b))
        assertEquals(listOf("cached"), m.open.sids())
        assertEquals(1, m.unreachable.size)
    }

    @Test
    fun filteringToAnUnreachablePcShowsOnlyItsBanner() {
        val a = host("A", items = listOf(s("a1")))
        val b = host("B", link = LinkState.UNREACHABLE)
        val m = build(listOf(a, b), filter = "B")
        assertEquals(listOf("B"), m.unreachable.map { it.hostId })
        assertTrue(m.isEmpty)
        assertEquals(HomeEmpty.UNREACHABLE, m.empty)
        val onlyA = build(listOf(a, b), filter = "A")
        assertTrue(onlyA.unreachable.isEmpty())
    }

    @Test
    fun emptyStates() {
        assertEquals(HomeEmpty.NO_SESSIONS, build(listOf(host("A"))).empty)
        assertEquals(HomeEmpty.NO_SESSIONS, build(emptyList()).empty)
        assertEquals(HomeEmpty.LOADING, build(listOf(host("A", loaded = false, link = LinkState.CONNECTING))).empty)
        assertEquals(HomeEmpty.UNREACHABLE, build(listOf(host("A", link = LinkState.UNREACHABLE, loaded = false))).empty)
        assertEquals(HomeEmpty.UNREACHABLE, build(listOf(host("A", link = LinkState.UNREACHABLE), host("B", link = LinkState.UNREACHABLE))).empty)
        // one PC loaded and empty, the other still loading
        assertEquals(HomeEmpty.LOADING, build(listOf(host("A"), host("B", loaded = false, link = LinkState.CONNECTING))).empty)
        // one empty and connected, the other down: nothing to wait for
        assertEquals(HomeEmpty.NO_SESSIONS, build(listOf(host("A"), host("B", link = LinkState.UNREACHABLE))).empty)
    }

    @Test
    fun anySessionMeansNotEmpty() {
        val m = build(listOf(host("A", items = listOf(s("r", SessionKind.RECENT)))))
        assertEquals(HomeEmpty.NONE, m.empty)
        assertFalse(m.isEmpty)
    }

    // ───────────── link state ─────────────

    @Test
    fun linkStateMapping() {
        val info = app.ompr.data.HostInfo()
        assertEquals(LinkState.CONNECTED, linkStateOf(ConnState.Connected("ws://x", true, info)))
        assertEquals(LinkState.CONNECTING, linkStateOf(ConnState.Connecting(0)))
        assertEquals(LinkState.CONNECTING, linkStateOf(ConnState.Idle))
        assertEquals(LinkState.UNREACHABLE, linkStateOf(ConnState.Offline("nope", 0, 1, OfflineHint.NETWORK)))
        assertEquals(LinkState.UNREACHABLE, linkStateOf(ConnState.Fatal("revoked")))
        assertEquals("nope", reasonOf(ConnState.Offline("nope", 0, 1, OfflineHint.NETWORK)))
        assertEquals("revoked", reasonOf(ConnState.Fatal("revoked")))
        assertNull(reasonOf(ConnState.Idle))
    }

    // ───────────── attention tracking ─────────────

    @Test
    fun attentionSnapshotKeepsOnlyUnresolvedApprovalsAndQuestions() {
        val items = listOf(
            attn("a", id = "1"),
            attn("b", AttentionKinds.QUESTION, id = "2"),
            attn("c", AttentionKinds.DONE, id = "3"),
            attn("d", id = "4", resolved = true),
            attn("e", AttentionKinds.ERROR, id = "5"),
        )
        assertEquals(listOf("1", "2"), actionableAttention(items).map { it.id })
    }

    @Test
    fun attentionEventsRaiseAndAnswerAnAsk() {
        var cur = emptyList<AttentionItem>()
        cur = applyAttentionEvent(cur, HostEvent.Attention(attn("x", id = "1")))
        assertEquals(listOf("1"), cur.map { it.id })
        // the same item again does not duplicate
        cur = applyAttentionEvent(cur, HostEvent.Attention(attn("x", id = "1")))
        assertEquals(1, cur.size)
        cur = applyAttentionEvent(cur, HostEvent.Attention(attn("y", AttentionKinds.DONE, id = "2")))
        assertEquals(1, cur.size)
        cur = applyAttentionEvent(cur, HostEvent.SessionsChanged)
        assertEquals(1, cur.size)
        cur = applyAttentionEvent(cur, HostEvent.AttentionResolved("1"))
        assertTrue(cur.isEmpty())
        cur = applyAttentionEvent(cur, HostEvent.AttentionResolved("nope"))
        assertTrue(cur.isEmpty())
    }

    @Test
    fun aResolvedAttentionEventRemovesTheItem() {
        var cur = listOf(attn("x", id = "1"))
        cur = applyAttentionEvent(cur, HostEvent.Attention(attn("x", id = "1", resolved = true)))
        assertTrue(cur.isEmpty())
    }

    @Test
    fun needsYouAppearsAndDisappearsWithTheApproval() {
        val items = listOf(s("x", status = SessionStatus.WORKING))
        var att = emptyList<AttentionItem>()
        assertEquals(1, build(listOf(host("A", items = items, attention = att))).running.size)
        att = applyAttentionEvent(att, HostEvent.Attention(attn("x", id = "1")))
        val raised = build(listOf(host("A", items = items, attention = att)))
        assertEquals(listOf("x"), raised.needsYou.sids())
        assertTrue(raised.running.isEmpty())
        att = applyAttentionEvent(att, HostEvent.AttentionResolved("1"))
        val answered = build(listOf(host("A", items = items, attention = att)))
        assertTrue(answered.needsYou.isEmpty())
        assertEquals(listOf("x"), answered.running.sids())
    }

    // ───────────── colours ─────────────

    @Test
    fun colourAssignmentIsStableAndDeterministic() {
        val hosts = listOf("host-a" to 100L, "host-b" to 200L, "host-c" to 300L)
        val first = hostColorIndices(hosts, 8)
        assertEquals(first, hostColorIndices(hosts, 8))
        assertEquals(first, hostColorIndices(hosts.reversed(), 8))
        assertTrue(first.values.all { it in 0 until 8 })
    }

    @Test
    fun noTwoPcsShareASlotWhileTheyFit() {
        val hosts = (1..8).map { "h$it" to it.toLong() }
        val m = hostColorIndices(hosts, 8)
        assertEquals(8, m.values.toSet().size)
        // more PCs than slots: still valid indices
        val many = hostColorIndices((1..20).map { "h$it" to it.toLong() }, 8)
        assertEquals(20, many.size)
        assertTrue(many.values.all { it in 0 until 8 })
    }

    @Test
    fun addingAPcNeverRecoloursExistingOnes() {
        val base = listOf("p1" to 1L, "p2" to 2L, "p3" to 3L)
        val before = hostColorIndices(base, 8)
        val after = hostColorIndices(base + ("p4" to 4L) + ("p5" to 5L), 8)
        for ((id, c) in before) assertEquals(c, after[id])
    }

    @Test
    fun collidingHashesFallToTheNextFreeSlot() {
        // "Aa" and "BB" have the same String.hashCode().
        assertEquals("Aa".hashCode(), "BB".hashCode())
        val m = hostColorIndices(listOf("Aa" to 1L, "BB" to 2L), 8)
        assertEquals(Math.floorMod("Aa".hashCode(), 8), m["Aa"])
        assertEquals((Math.floorMod("Aa".hashCode(), 8) + 1) % 8, m["BB"])
    }
}
