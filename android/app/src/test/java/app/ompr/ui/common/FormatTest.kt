package app.ompr.ui.common

import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    private val now = 1_800_000_000_000L
    private val s = 1000L
    private val m = 60 * s
    private val h = 60 * m
    private val d = 24 * h

    @Test
    fun timeAgoBuckets() {
        assertEquals("", timeAgo(0, now))
        assertEquals("", timeAgo(-1, now))
        assertEquals("just now", timeAgo(now, now))
        assertEquals("just now", timeAgo(now - 9 * s, now))
        assertEquals("10s ago", timeAgo(now - 10 * s, now))
        assertEquals("59s ago", timeAgo(now - 59 * s, now))
        assertEquals("1m ago", timeAgo(now - 60 * s, now))
        assertEquals("59m ago", timeAgo(now - 59 * m - 59 * s, now))
        assertEquals("1h ago", timeAgo(now - h, now))
        assertEquals("23h ago", timeAgo(now - 23 * h - 59 * m, now))
        assertEquals("1d ago", timeAgo(now - d, now))
        assertEquals("13d ago", timeAgo(now - 13 * d - 23 * h, now))
    }

    @Test
    fun aTimestampInTheFutureIsJustNow() {
        assertEquals("just now", timeAgo(now + 5 * m, now))
    }

    @Test
    fun costFormatting() {
        assertEquals("", formatCost(null))
        assertEquals("<$0.01", formatCost(0.004))
        assertEquals("$0.01", formatCost(0.01))
        assertEquals("$9.99", formatCost(9.994))
        assertEquals("$12.5", formatCost(12.46))
    }

    @Test
    fun tokenAndPercentFormatting() {
        assertEquals("", formatTokens(null))
        assertEquals("999", formatTokens(999))
        assertEquals("1.5k", formatTokens(1500))
        assertEquals("12k", formatTokens(12_345))
        assertEquals("2.5M", formatTokens(2_500_000))
        assertEquals("", formatPercent(null))
        assertEquals("42%", formatPercent(42.9))
        assertEquals("0%", formatPercent(-3.0))
        assertEquals("999%", formatPercent(5000.0))
    }

    @Test
    fun pathHelpers() {
        assertEquals("/", shortPath(""))
        assertEquals("/", shortPath("/"))
        assertEquals("/a/b", shortPath("/a/b"))
        assertEquals("…/b/c", shortPath("/a/b/c"))
        assertEquals("…/projects/app", shortPath("/home/me/projects/app/"))
        assertEquals("app", lastSegment("/home/me/projects/app/"))
        assertEquals("/", lastSegment("/"))
        assertEquals("/", lastSegment(""))
    }
}
