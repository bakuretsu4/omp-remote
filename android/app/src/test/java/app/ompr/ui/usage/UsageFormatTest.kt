package app.ompr.ui.usage

import app.ompr.data.UsageAccount
import app.ompr.data.UsageLimit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UsageFormatTest {
    private val now = 1_000_000_000_000L
    private val min = 60_000L
    private val hour = 60 * min
    private val day = 24 * hour

    @Test
    fun resetCountdownUsesTheTwoLargestUnits() {
        assertNull(resetsInText(null, now))
        assertEquals("reset pending", resetsInText(now - 1, now))
        assertEquals("reset pending", resetsInText(now, now))
        assertEquals("resets in <1m", resetsInText(now + 30_000, now))
        assertEquals("resets in 5m", resetsInText(now + 5 * min, now))
        assertEquals("resets in 1h", resetsInText(now + hour, now))
        assertEquals("resets in 2h 15m", resetsInText(now + 2 * hour + 15 * min + 10_000, now))
        assertEquals("resets in 3d 4h", resetsInText(now + 3 * day + 4 * hour + 59 * min, now))
        assertEquals("resets in 7d", resetsInText(now + 7 * day, now))
    }

    @Test
    fun usedTextRoundsWithoutClaimingAFullWindow() {
        assertEquals("—", usedText(null))
        assertEquals("0% used", usedText(0.0))
        assertEquals("96% used", usedText(0.96))
        assertEquals("33% used", usedText(0.334))
        assertEquals("99% used", usedText(0.996)) // still room left: never shows 100%
        assertEquals("100% used", usedText(1.0))
        assertEquals("100% used", usedText(7.0))
        assertEquals("0% used", usedText(-1.0))
    }

    @Test
    fun severityFollowsTheProviderStatusThenTheFraction() {
        assertEquals(LimitSeverity.EXHAUSTED, limitSeverity("exhausted", 0.2))
        assertEquals(LimitSeverity.WARNING, limitSeverity("warning", 0.5))
        assertEquals(LimitSeverity.EXHAUSTED, limitSeverity("warning", 1.0))
        assertEquals(LimitSeverity.OK, limitSeverity("ok", 0.1))
        assertEquals(LimitSeverity.WARNING, limitSeverity("ok", 0.95)) // a stale "ok" does not hide a nearly full window
        assertEquals(LimitSeverity.OK, limitSeverity("ok", null))
        assertEquals(LimitSeverity.UNKNOWN, limitSeverity("unknown", null))
        assertEquals(LimitSeverity.OK, limitSeverity("something-new", 0.3))
        assertEquals(LimitSeverity.EXHAUSTED, limitSeverity("EXHAUSTED", null))
        assertEquals(LimitSeverity.WARNING, UsageLimit(status = "unknown", usedFraction = 0.9).severity)
    }

    @Test
    fun groupsAccountsByProviderInFirstSeenOrder() {
        val a = UsageAccount("anthropic", email = "one@example.invalid")
        val b = UsageAccount("openai-codex")
        val c = UsageAccount("anthropic", email = "two@example.invalid")
        val groups = groupByProvider(listOf(a, b, c))
        assertEquals(listOf("anthropic", "openai-codex"), groups.map { it.provider })
        assertEquals(listOf(a, c), groups[0].accounts)
        assertEquals("OpenAI Codex", groups[1].label)
        assertEquals("Some New Ai", providerLabel("some-new-ai"))
        assertEquals("Unknown provider", providerLabel(""))
    }

    @Test
    fun accountTitlesPreferTheEmail() {
        assertEquals("a@example.invalid", accountTitle(UsageAccount("p", email = "a@example.invalid", org = "Org")))
        assertEquals("Org", accountSubtitle(UsageAccount("p", email = "a@example.invalid", org = "Org")))
        assertEquals("Org", accountTitle(UsageAccount("p", org = "Org")))
        assertNull(accountSubtitle(UsageAccount("p", org = "Org"))) // would only repeat the title
        assertEquals("Account", accountTitle(UsageAccount("p")))
        assertEquals(0f, barProgress(null), 0f)
        assertEquals(1f, barProgress(3.0), 0f)
    }
}
