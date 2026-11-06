package app.ompr.ui.files

import app.ompr.net.WireException
import java.util.Locale

// ───────────────────────────── git status codes ─────────────────────────────

enum class ChangeKind { MODIFIED, ADDED, DELETED, RENAMED, COPIED, TYPE_CHANGED, UNTRACKED, IGNORED, CONFLICT, UNKNOWN }

/** Decoded two-character `git status --porcelain=v1` code (X = index, Y = work tree). */
class StatusCode(val code: String) {
    private val x = code.getOrElse(0) { ' ' }
    private val y = code.getOrElse(1) { ' ' }

    val untracked: Boolean get() = code == "??"
    val ignored: Boolean get() = code == "!!"
    val conflict: Boolean get() = code == "DD" || code == "AA" || x == 'U' || y == 'U'
    val staged: Boolean get() = !untracked && !ignored && !conflict && x != ' '
    val unstaged: Boolean get() = !untracked && !ignored && !conflict && y != ' '

    /** The change a user would call this file's: the work-tree side wins over the index side. */
    val kind: ChangeKind
        get() = when {
            untracked -> ChangeKind.UNTRACKED
            ignored -> ChangeKind.IGNORED
            conflict -> ChangeKind.CONFLICT
            else -> kindOf(if (y != ' ') y else x)
        }

    /** Single-letter badge. */
    val badge: String
        get() = when (kind) {
            ChangeKind.MODIFIED -> "M"
            ChangeKind.ADDED -> "A"
            ChangeKind.DELETED -> "D"
            ChangeKind.RENAMED -> "R"
            ChangeKind.COPIED -> "C"
            ChangeKind.TYPE_CHANGED -> "T"
            ChangeKind.UNTRACKED -> "?"
            ChangeKind.IGNORED -> "!"
            ChangeKind.CONFLICT -> "U"
            ChangeKind.UNKNOWN -> "·"
        }

    val label: String
        get() {
            val base = when (kind) {
                ChangeKind.MODIFIED -> "Modified"
                ChangeKind.ADDED -> "Added"
                ChangeKind.DELETED -> "Deleted"
                ChangeKind.RENAMED -> "Renamed"
                ChangeKind.COPIED -> "Copied"
                ChangeKind.TYPE_CHANGED -> "Type changed"
                ChangeKind.UNTRACKED -> "Untracked"
                ChangeKind.IGNORED -> "Ignored"
                ChangeKind.CONFLICT -> "Conflict"
                ChangeKind.UNKNOWN -> "Changed"
            }
            return when {
                staged && unstaged -> "$base · staged + more edits"
                staged -> "$base · staged"
                else -> base
            }
        }

    private fun kindOf(c: Char): ChangeKind = when (c) {
        'M' -> ChangeKind.MODIFIED
        'A' -> ChangeKind.ADDED
        'D' -> ChangeKind.DELETED
        'R' -> ChangeKind.RENAMED
        'C' -> ChangeKind.COPIED
        'T' -> ChangeKind.TYPE_CHANGED
        else -> ChangeKind.UNKNOWN
    }
}

/** Which diff to open first for a file: the work-tree one when it has changes, else the staged one. */
fun defaultStaged(code: StatusCode): Boolean = !code.unstaged && code.staged

// ─────────────────────────────── diff parsing ────────────────────────────────

enum class DiffLineKind { HEADER, HUNK, ADDED, REMOVED, CONTEXT, NOTE }

class DiffLine(val kind: DiffLineKind, val text: String)

private val HUNK_RE = Regex("""^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@""")

/**
 * Classifies a unified diff line by line. Hunk bodies are tracked with the counts in their `@@` header, so a removed
 * line that reads `-- x` (shown as `--- x`) or an added `++ x` is not mistaken for a file header.
 */
fun parseDiff(diff: String): List<DiffLine> {
    val out = ArrayList<DiffLine>()
    var oldLeft = 0
    var newLeft = 0
    for (line in splitLines(diff)) {
        if (oldLeft > 0 || newLeft > 0) {
            val kind = when {
                line.startsWith("+") -> { newLeft = maxOf(0, newLeft - 1); DiffLineKind.ADDED }
                line.startsWith("-") -> { oldLeft = maxOf(0, oldLeft - 1); DiffLineKind.REMOVED }
                line.startsWith(" ") || line.isEmpty() -> { oldLeft = maxOf(0, oldLeft - 1); newLeft = maxOf(0, newLeft - 1); DiffLineKind.CONTEXT }
                line.startsWith("\\") -> DiffLineKind.NOTE
                else -> null
            }
            if (kind != null) {
                out.add(DiffLine(kind, line))
                continue
            }
            // Anything else inside a hunk means the output was cut or malformed: read it as a header again.
            oldLeft = 0
            newLeft = 0
        }
        val hunk = HUNK_RE.find(line)
        when {
            hunk != null -> {
                oldLeft = hunk.groupValues[1].ifEmpty { "1" }.toInt()
                newLeft = hunk.groupValues[2].ifEmpty { "1" }.toInt()
                out.add(DiffLine(DiffLineKind.HUNK, line))
            }
            line.startsWith("@@") -> out.add(DiffLine(DiffLineKind.HUNK, line)) // combined-diff marker: no counts
            line.startsWith("\\") -> out.add(DiffLine(DiffLineKind.NOTE, line))
            else -> out.add(DiffLine(DiffLineKind.HEADER, line))
        }
    }
    return out
}

// ─────────────────────────────── text helpers ────────────────────────────────

/** Splits on `\n` / `\r\n`; a trailing newline does not add an empty last line. */
fun splitLines(text: String): List<String> {
    if (text.isEmpty()) return emptyList()
    val lines = text.split('\n').map { it.removeSuffix("\r") }
    return if (text.endsWith('\n')) lines.dropLast(1) else lines
}

/** Very long lines (minified files) would make a single Text composable huge: clip them with a visible marker. */
fun clipLine(line: String, max: Int = 2000): String = if (line.length <= max) line else line.take(max) + "… (+${line.length - max} chars)"

/** Width in digits of the line-number gutter for [count] lines. */
fun gutterDigits(count: Int): Int = count.coerceAtLeast(1).toString().length

fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
    else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
}

// ─────────────────────────────────── paths ───────────────────────────────────

fun parentOf(path: String): String {
    val p = path.trimEnd('/')
    val cut = p.lastIndexOf('/')
    return if (cut <= 0) "/" else p.substring(0, cut)
}

fun joinPath(dir: String, name: String): String = dir.trimEnd('/') + "/" + name.trimStart('/')

fun baseName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { "/" }

/** The bridge refuses to list above its roots, so the ".." row is only offered below one. */
fun canGoUp(path: String, roots: List<String>): Boolean {
    val p = path.trimEnd('/')
    return p.isNotEmpty() && roots.none { it.trimEnd('/') == p }
}

// ─────────────────────────────────── errors ──────────────────────────────────

/** `git.status` / `git.diff` on a folder that is not inside a repository. */
fun isNotRepository(e: Throwable): Boolean = e is WireException && e.code == "invalid" && e.message.contains("not a git repository", ignoreCase = true)

