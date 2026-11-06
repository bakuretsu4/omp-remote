package app.ompr.ui.common

import java.text.NumberFormat
import java.util.Locale

/** Plain-Kotlin formatting helpers (no Compose) so they can be unit-tested on the JVM. */

fun timeAgo(ms: Long, now: Long = System.currentTimeMillis()): String {
    if (ms <= 0) return ""
    val d = (now - ms).coerceAtLeast(0) / 1000
    return when {
        d < 10 -> "just now"
        d < 60 -> "${d}s ago"
        d < 3600 -> "${d / 60}m ago"
        d < 86400 -> "${d / 3600}h ago"
        d < 86400 * 14 -> "${d / 86400}d ago"
        else -> java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ms))
    }
}

fun formatCost(usd: Double?): String = when {
    usd == null -> ""
    usd < 0.01 -> "<$0.01"
    usd < 10 -> String.format(Locale.US, "$%.2f", usd)
    else -> String.format(Locale.US, "$%.1f", usd)
}

fun formatTokens(n: Long?): String = when {
    n == null -> ""
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 10_000 -> "${n / 1000}k"
    n >= 1000 -> String.format(Locale.US, "%.1fk", n / 1000.0)
    else -> NumberFormat.getIntegerInstance().format(n)
}

fun formatPercent(p: Double?): String = if (p == null) "" else "${p.toInt().coerceIn(0, 999)}%"

/** `/home/me/projects/app` → `~/projects/app` style shortening is not possible without $HOME; keep the last 2 segments. */
fun shortPath(path: String): String {
    val parts = path.trimEnd('/').split('/').filter { it.isNotEmpty() }
    return when {
        parts.isEmpty() -> "/"
        parts.size <= 2 -> path
        else -> "…/" + parts.takeLast(2).joinToString("/")
    }
}

fun lastSegment(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { "/" }
