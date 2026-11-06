package app.ompr.ui.usage

import app.ompr.data.UsageAccount
import app.ompr.data.UsageLimit
import java.util.Locale

/** How worried the user should be about one limit. */
enum class LimitSeverity { OK, WARNING, EXHAUSTED, UNKNOWN }

private const val WARN_AT = 0.9

/** The provider's own status word wins; without one (or an unknown word) the used fraction decides. */
fun limitSeverity(status: String, usedFraction: Double?): LimitSeverity {
    val byFraction = when {
        usedFraction == null -> LimitSeverity.UNKNOWN
        usedFraction >= 1.0 -> LimitSeverity.EXHAUSTED
        usedFraction >= WARN_AT -> LimitSeverity.WARNING
        else -> LimitSeverity.OK
    }
    return when (status.lowercase(Locale.ROOT)) {
        "exhausted", "limited", "blocked", "rejected" -> LimitSeverity.EXHAUSTED
        "warning", "warn" -> if (byFraction == LimitSeverity.EXHAUSTED) byFraction else LimitSeverity.WARNING
        "ok", "allowed" -> if (byFraction == LimitSeverity.UNKNOWN) LimitSeverity.OK else byFraction
        else -> byFraction
    }
}

val UsageLimit.severity: LimitSeverity get() = limitSeverity(status, usedFraction)

/** `0.96` → "96% used"; null → "—". Whole percent, rounded; never "100%" while the window still has room. */
fun usedText(fraction: Double?): String {
    if (fraction == null) return "—"
    val pct = Math.round(fraction.coerceIn(0.0, 1.0) * 100).toInt()
    val shown = if (pct == 100 && fraction < 1.0) 99 else pct
    return "$shown% used"
}

/** "resets in 2h 15m" / "resets in 3d 4h" / "resets in <1m"; null when unknown, "reset pending" when already past. */
fun resetsInText(resetsAt: Long?, now: Long): String? {
    if (resetsAt == null) return null
    val ms = resetsAt - now
    if (ms <= 0) return "reset pending"
    val totalMin = ms / 60_000
    val days = totalMin / (60 * 24)
    val hours = totalMin / 60 % 24
    val mins = totalMin % 60
    val span = when {
        totalMin < 1 -> "<1m"
        days > 0 -> if (hours > 0) "${days}d ${hours}h" else "${days}d"
        totalMin >= 60 -> if (mins > 0) "${hours}h ${mins}m" else "${hours}h"
        else -> "${mins}m"
    }
    return "resets in $span"
}

/** Known providers get their brand name; anything else is title-cased from its id (`some-new-ai` → "Some New Ai"). */
fun providerLabel(provider: String): String = when (provider) {
    "anthropic" -> "Anthropic"
    "openai-codex" -> "OpenAI Codex"
    "openai" -> "OpenAI"
    "google-antigravity" -> "Google Antigravity"
    "google-gemini-cli" -> "Google Gemini CLI"
    "github-copilot" -> "GitHub Copilot"
    "" -> "Unknown provider"
    else -> provider.split('-', '_', ' ').filter { it.isNotEmpty() }.joinToString(" ") { w -> w.replaceFirstChar { it.titlecase(Locale.ROOT) } }
}

class ProviderGroup(val provider: String, val accounts: List<UsageAccount>) {
    val label: String get() = providerLabel(provider)
}

/** Groups accounts by provider, keeping the order in which providers first appear. */
fun groupByProvider(accounts: List<UsageAccount>): List<ProviderGroup> =
    accounts.groupBy { it.provider }.map { (p, list) -> ProviderGroup(p, list) }

/** Headline for an account: the email, else the organisation, else a neutral word. */
fun accountTitle(a: UsageAccount): String = a.email?.takeIf { it.isNotBlank() } ?: a.org?.takeIf { it.isNotBlank() } ?: "Account"

/** Organisation line, shown only when it adds something beyond the title. */
fun accountSubtitle(a: UsageAccount): String? = a.org?.takeIf { it.isNotBlank() && !a.email.isNullOrBlank() }

/** Whole-percent display of a quota used fraction for the progress bar (clamped; null → 0 so the bar renders empty). */
fun barProgress(fraction: Double?): Float = (fraction ?: 0.0).coerceIn(0.0, 1.0).toFloat()
