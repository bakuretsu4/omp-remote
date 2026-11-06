package app.ompr.ui.session

import android.content.Context
import android.graphics.BitmapFactory
import android.text.format.DateUtils
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.data.Block
import app.ompr.data.Message
import app.ompr.data.SessionView
import app.ompr.data.ToolRun
import app.ompr.data.UiRequest
import app.ompr.net.HostConnection
import app.ompr.net.SessionHandle
import app.ompr.ui.common.LocalSnack
import app.ompr.ui.common.userMessage
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownPadding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.ZoneId

private val PrettyJson = Json { prettyPrint = true }

/** A time label is inserted between two messages that are further apart than this (or on different days). */
private const val GROUP_GAP_MS = 10 * 60_000L

/** One visual row of the transcript. */
sealed interface TRow {
    val key: String

    data class User(val msg: Message) : TRow {
        override val key get() = "u:${msg.id}"
    }

    data class Text(val id: String, val index: Int, val text: String, val streaming: Boolean, val ts: Long = 0) : TRow {
        override val key get() = "t:$id:$index"
    }

    data class Thinking(val id: String, val index: Int, val text: String) : TRow {
        override val key get() = "k:$id:$index"
    }

    data class Tool(val id: String, val index: Int, val call: Block.ToolCall) : TRow {
        override val key get() = "c:$id:$index"
    }

    data class Img(val id: String, val index: Int, val block: Block.Image) : TRow {
        override val key get() = "i:$id:$index"
    }

    data class Notice(val id: String, val text: String, val error: Boolean) : TRow {
        override val key get() = "n:$id"
    }

    /** Small centered day/time label shown above the first message after a pause. */
    data class TimeLabel(val id: String, val at: Long) : TRow {
        override val key get() = "d:$id"
    }
}

private fun sameDay(a: Long, b: Long): Boolean {
    val zone = ZoneId.systemDefault()
    return Instant.ofEpochMilli(a).atZone(zone).toLocalDate() == Instant.ofEpochMilli(b).atZone(zone).toLocalDate()
}

/** Flattens messages into rows. `toolResult` messages are folded into their tool card, not shown on their own. */
fun buildRows(view: SessionView): List<TRow> {
    val out = ArrayList<TRow>(view.messages.size * 2)
    val lastAssistant = view.messages.lastOrNull { it.role == "assistant" }?.id
    val seenCalls = HashSet<String>()
    for (m in view.messages) {
        if (m.role == "assistant") for (b in m.content) if (b is Block.ToolCall) seenCalls += b.id
    }
    var lastStamp = 0L
    for (m in view.messages) {
        val start = out.size
        when (m.role) {
            "user" -> out += TRow.User(m)
            "developer" -> m.text.takeIf { it.isNotBlank() }?.let { out += TRow.Notice(m.id, it, false) }
            "assistant" -> {
                m.content.forEachIndexed { i, b ->
                    when (b) {
                        is Block.Text -> if (b.text.isNotBlank()) out += TRow.Text(m.id, i, b.text, view.busy && m.id == lastAssistant && i == m.content.lastIndex, m.timestamp)
                        is Block.Thinking -> if (b.thinking.isNotBlank()) out += TRow.Thinking(m.id, i, b.thinking)
                        is Block.ToolCall -> out += TRow.Tool(m.id, i, b)
                        is Block.Image -> out += TRow.Img(m.id, i, b)
                        Block.Unknown -> Unit
                    }
                }
                if (!m.errorMessage.isNullOrBlank()) out += TRow.Notice(m.id + ":err", m.errorMessage, true)
            }
            "toolResult" -> if (m.toolCallId == null || m.toolCallId !in seenCalls) {
                m.content.forEachIndexed { i, b -> if (b is Block.Image) out += TRow.Img(m.id, i, b) }
            }
            else -> Unit
        }
        if ((m.role == "user" || m.role == "assistant") && m.timestamp > 0 && out.size > start) {
            if (lastStamp == 0L || m.timestamp - lastStamp > GROUP_GAP_MS || !sameDay(lastStamp, m.timestamp)) out.add(start, TRow.TimeLabel(m.id, m.timestamp))
            lastStamp = m.timestamp
        }
    }
    return out
}

@Composable
fun TranscriptRow(row: TRow, view: SessionView, handle: SessionHandle, conn: HostConnection) {
    when (row) {
        is TRow.User -> UserBubble(row.msg, conn)
        is TRow.Text -> AssistantText(row.text, row.ts)
        is TRow.Thinking -> ThinkingBlock(row.text)
        is TRow.Tool -> {
            val name = row.call.name
            ToolCard(
                row.call, view.tools[row.call.id], view.fullOutputs[row.call.id], handle, conn,
                awaitingApproval = view.pendingUi.any { it is UiRequest.Approval && it.tool.equals(name, ignoreCase = true) },
                queued = view.busy,
            )
        }
        is TRow.Img -> InlineImage(row.block.ref, row.block.mimeType, conn)
        is TRow.TimeLabel -> TimeLabel(row.at)
        is TRow.Notice -> Text(
            row.text,
            style = MaterialTheme.typography.bodySmall,
            color = if (row.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            fontStyle = FontStyle.Italic,
            modifier = Modifier.padding(horizontal = Dimens.xs),
        )
    }
}

// ───────────────────────── time labels ─────────────────────────

private fun stampLabel(ctx: Context, ts: Long, withYear: Boolean): String {
    val time = DateUtils.formatDateTime(ctx, ts, DateUtils.FORMAT_SHOW_TIME)
    if (DateUtils.isToday(ts)) return "Today, $time"
    var flags = DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH
    if (withYear) flags = flags or DateUtils.FORMAT_SHOW_YEAR
    return DateUtils.formatDateTime(ctx, ts, flags)
}

@Composable
private fun TimeLabel(ts: Long) {
    val ctx = LocalContext.current
    Box(Modifier.fillMaxWidth().padding(vertical = Dimens.xs), contentAlignment = Alignment.Center) {
        Text(remember(ts) { stampLabel(ctx, ts, false) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ───────────────────────── messages ─────────────────────────

/**
 * Long-press menu of a message: when it was sent, copy, and "Select text" (which turns the body into selectable text
 * until "Done"; a SelectionContainer would otherwise swallow the long-press).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageActions(text: String, timestamp: Long, modifier: Modifier = Modifier, content: @Composable (selecting: Boolean) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var selecting by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val haptics = LocalHapticFeedback.current
    val snack = LocalSnack.current
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    Column(modifier) {
        Box {
            Box(
                if (selecting) Modifier else Modifier.combinedClickable(
                    onClick = {},
                    onLongClickLabel = "Message actions",
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menu = true
                    },
                ),
            ) { content(selecting) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (timestamp > 0) {
                    DropdownMenuItem(
                        text = { Text(stampLabel(ctx, timestamp, true)) },
                        onClick = {},
                        enabled = false,
                        leadingIcon = { Icon(Icons.Filled.Schedule, null) },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Copy") },
                    leadingIcon = { Icon(Icons.Filled.ContentCopy, null) },
                    onClick = {
                        menu = false
                        clipboard.setText(AnnotatedString(text))
                        snack?.let { s -> scope.launch { s.showSnackbar("Copied") } }
                    },
                )
                DropdownMenuItem(
                    text = { Text("Select text") },
                    leadingIcon = { Icon(Icons.Filled.SelectAll, null) },
                    onClick = {
                        menu = false
                        selecting = true
                    },
                )
            }
        }
        if (selecting) TextButton(onClick = { selecting = false }) { Text("Done selecting") }
    }
}

@Composable
private fun MaybeSelectable(selecting: Boolean, content: @Composable () -> Unit) {
    if (selecting) SelectionContainer(content = content) else content()
}

@Composable
private fun UserBubble(m: Message, conn: HostConnection) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        MessageActions(m.text, m.timestamp, Modifier.widthIn(max = 560.dp)) { selecting ->
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = OmprShapes.bubble.copy(bottomEnd = CornerSize(Dimens.xs)),
                modifier = Modifier.semantics { contentDescription = "You said" },
            ) {
                Column(Modifier.padding(horizontal = Dimens.lg - Dimens.xxs, vertical = Dimens.md - Dimens.xxs), verticalArrangement = Arrangement.spacedBy(Dimens.sm - Dimens.xxs)) {
                    if (!m.from.isNullOrBlank()) Text(m.from, style = MaterialTheme.typography.labelSmall)
                    for (b in m.content) when (b) {
                        is Block.Text -> MaybeSelectable(selecting) { Text(b.text, style = MaterialTheme.typography.bodyLarge) }
                        is Block.Image -> InlineImage(b.ref, b.mimeType, conn, maxHeight = 220)
                        else -> Unit
                    }
                }
            }
        }
    }
}

@Composable
private fun AssistantText(text: String, ts: Long) {
    MessageActions(text, ts, Modifier.fillMaxWidth()) { selecting ->
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            contentColor = MaterialTheme.colorScheme.onSurface,
            shape = OmprShapes.bubble.copy(topStart = CornerSize(Dimens.xs)),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Assistant message" },
        ) {
            Box(Modifier.padding(horizontal = Dimens.lg - Dimens.xxs, vertical = Dimens.md)) {
                MaybeSelectable(selecting) { MarkdownBody(text) }
            }
        }
    }
}

// ───────────────────────── markdown ─────────────────────────

private sealed interface MdSeg {
    data class Md(val text: String) : MdSeg
    data class Table(val header: List<String>, val rows: List<List<String>>, val aligns: List<TextAlign>) : MdSeg
}

private val TableSeparator = Regex("""^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$""")

private fun splitCells(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.substring(1)
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
    val out = ArrayList<String>()
    val cur = StringBuilder()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '\\' && i + 1 < s.length && s[i + 1] == '|') {
            cur.append('|')
            i += 2
            continue
        }
        if (c == '|') {
            out += cur.toString().trim()
            cur.setLength(0)
        } else cur.append(c)
        i++
    }
    out += cur.toString().trim()
    return out
}

/** The markdown renderer has no table support, so tables are cut out of the text and drawn by [MarkdownTable]. */
private fun splitMarkdown(text: String): List<MdSeg> {
    if (!text.contains('|')) return listOf(MdSeg.Md(text))
    val lines = text.split('\n')
    val out = ArrayList<MdSeg>()
    val buf = StringBuilder()
    fun flush() {
        if (buf.isNotBlank()) out += MdSeg.Md(buf.toString().trimEnd('\n'))
        buf.setLength(0)
    }
    var fence: String? = null
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val t = line.trimStart()
        val open = fence
        if (open != null) {
            if (t.startsWith(open)) fence = null
            buf.append(line).append('\n')
            i++
            continue
        }
        if (t.startsWith("```") || t.startsWith("~~~")) {
            fence = t.take(3)
            buf.append(line).append('\n')
            i++
            continue
        }
        if (line.contains('|') && i + 1 < lines.size && lines[i + 1].contains('|') && TableSeparator.matches(lines[i + 1])) {
            val header = splitCells(line)
            val sep = splitCells(lines[i + 1])
            if (header.size == sep.size) {
                var j = i + 2
                val rows = ArrayList<List<String>>()
                while (j < lines.size && lines[j].isNotBlank() && lines[j].contains('|')) {
                    val cells = splitCells(lines[j])
                    rows += List(header.size) { c -> cells.getOrElse(c) { "" } }
                    j++
                }
                flush()
                out += MdSeg.Table(
                    header, rows,
                    sep.map { s ->
                        when {
                            s.startsWith(":") && s.endsWith(":") -> TextAlign.Center
                            s.endsWith(":") -> TextAlign.End
                            else -> TextAlign.Start
                        }
                    },
                )
                i = j
                continue
            }
        }
        buf.append(line).append('\n')
        i++
    }
    flush()
    return out
}

/** `**bold**` and `` `code` `` inside a table cell. */
private fun inlineMd(s: String, codeBackground: Color): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        if (s.startsWith("**", i)) {
            val e = s.indexOf("**", i + 2)
            if (e >= 0) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(s.substring(i + 2, e)) }
                i = e + 2
                continue
            }
        }
        if (s[i] == '`') {
            val e = s.indexOf('`', i + 1)
            if (e >= 0) {
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(s.substring(i + 1, e)) }
                i = e + 1
                continue
            }
        }
        append(s[i])
        i++
    }
}

@Composable
private fun MarkdownTable(t: MdSeg.Table) {
    val scheme = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val widths = remember(t, density) {
        t.header.indices.map { c ->
            val longest = maxOf(t.header[c].length, t.rows.maxOfOrNull { it[c].length } ?: 0)
            with(density) { (longest.coerceIn(3, 30) * 9f).sp.toDp() } + Dimens.xl
        }
    }
    val total = widths.fold(0.dp) { a, b -> a + b }
    @Composable
    fun TableRow(cells: List<String>, header: Boolean) {
        Row(Modifier.width(total).let { if (header) it.background(scheme.surfaceContainerHighest) else it }) {
            cells.forEachIndexed { c, cell ->
                Text(
                    inlineMd(cell, scheme.surfaceContainerHighest),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (header) FontWeight.SemiBold else null,
                    textAlign = t.aligns[c],
                    modifier = Modifier.width(widths[c]).padding(horizontal = Dimens.sm, vertical = Dimens.sm - Dimens.xxs),
                )
            }
        }
    }
    Surface(
        color = scheme.surface,
        shape = OmprShapes.block,
        border = BorderStroke(1.dp, scheme.outlineVariant),
        modifier = Modifier.padding(vertical = Dimens.sm).semantics { contentDescription = "Table with ${t.rows.size} rows" },
    ) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            TableRow(t.header, header = true)
            for (r in t.rows) {
                HorizontalDivider(Modifier.width(total), color = scheme.outlineVariant)
                TableRow(r, header = false)
            }
        }
    }
}

/** Assistant markdown on the app's type scale: chat-sized headings, tonal code blocks, tables as grids. */
@Composable
private fun MarkdownBody(text: String) {
    val scheme = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    val colors = markdownColor(
        text = scheme.onSurface,
        codeText = scheme.onSurface,
        inlineCodeText = scheme.onSurface,
        linkText = scheme.primary,
        codeBackground = scheme.surfaceContainerHighest,
        inlineCodeBackground = scheme.surfaceContainerHighest,
        dividerColor = scheme.outlineVariant,
    )
    val body = type.bodyLarge
    val typography = markdownTypography(
        h1 = type.titleLarge,
        h2 = type.titleLarge,
        h3 = type.titleMedium,
        h4 = type.titleSmall,
        h5 = type.titleSmall,
        h6 = type.labelLarge,
        text = body,
        code = type.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp),
        inlineCode = body.copy(fontFamily = FontFamily.Monospace, fontSize = 14.sp),
        quote = type.bodyMedium.copy(fontStyle = FontStyle.Italic),
        paragraph = body,
        ordered = body,
        bullet = body,
        list = body,
        link = body.copy(fontWeight = FontWeight.Medium, textDecoration = TextDecoration.Underline),
    )
    val padding = markdownPadding(block = Dimens.sm, list = Dimens.xs, listItemBottom = Dimens.xs, indentList = Dimens.sm, codeBlock = PaddingValues(Dimens.md))
    val dimens = markdownDimens(codeBackgroundCornerSize = 12.dp)
    val segments = remember(text) { splitMarkdown(text) }
    Column(Modifier.fillMaxWidth()) {
        for (seg in segments) when (seg) {
            is MdSeg.Md -> Markdown(content = seg.text, colors = colors, typography = typography, modifier = Modifier.fillMaxWidth(), padding = padding, dimens = dimens)
            is MdSeg.Table -> MarkdownTable(seg)
        }
    }
}

// ───────────────────────── thinking ─────────────────────────

/** Quiet by design: no fill, a muted one-line preview, and a thin rule beside the text once opened. */
@Composable
private fun ThinkingBlock(text: String) {
    var open by rememberSaveable(text.length / 2000) { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        Modifier.fillMaxWidth().clip(OmprShapes.block).clickable { open = !open }.padding(horizontal = Dimens.sm, vertical = Dimens.xs)
            .semantics { contentDescription = if (open) "Thinking, expanded" else "Thinking, collapsed" },
    ) {
        Row(Modifier.heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Psychology, null, Modifier.size(16.dp), tint = muted)
            Spacer(Modifier.size(Dimens.sm - Dimens.xxs))
            Text("Thinking", style = MaterialTheme.typography.labelMedium, color = muted, modifier = Modifier.weight(1f))
            Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Collapse thinking" else "Expand thinking", Modifier.size(18.dp), tint = muted)
        }
        if (!open) {
            Text(
                text.trim().lineSequence().lastOrNull { it.isNotBlank() }.orEmpty(),
                style = MaterialTheme.typography.bodySmall, color = muted.copy(alpha = 0.8f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontStyle = FontStyle.Italic,
                modifier = Modifier.padding(start = Dimens.lg + Dimens.xxs),
            )
        }
        AnimatedVisibility(open) {
            Row(Modifier.height(IntrinsicSize.Min).padding(start = Dimens.sm, top = Dimens.xs)) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant, OmprShapes.chip))
                SelectionContainer {
                    Text(
                        text.trim(),
                        style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic, color = muted,
                        modifier = Modifier.padding(start = Dimens.md),
                    )
                }
            }
        }
    }
}

private fun JsonElement.asText(): String? = (this as? JsonPrimitive)?.contentOrNull

/** One-line summary of a tool call: intent first, else its most telling argument. */
fun toolSummary(call: Block.ToolCall?, run: ToolRun?): String {
    val intent = call?.intent ?: run?.intent
    if (!intent.isNullOrBlank()) return intent
    val args = (call?.arguments ?: (run?.args as? JsonObject)) ?: return ""
    for (k in listOf("command", "cmd", "path", "file_path", "pattern", "query", "url", "description", "task")) {
        args[k]?.asText()?.takeIf { it.isNotBlank() }?.let { return it.lineSequence().first() }
    }
    return args.entries.firstOrNull { it.value is JsonPrimitive }?.value?.asText().orEmpty()
}

// ───────────────────────── tool card ─────────────────────────

/**
 * A tool call, collapsed to one line: state icon (spinner = running, lock = waiting for your approval, hourglass =
 * about to run, check = ok, error = failed), tool name and a summary. Tap to see the arguments and output.
 */
@Composable
fun ToolCard(
    call: Block.ToolCall,
    run: ToolRun?,
    fullOutput: String?,
    handle: SessionHandle,
    conn: HostConnection,
    awaitingApproval: Boolean = false,
    queued: Boolean = false,
) {
    var open by rememberSaveable(call.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var fetching by remember { mutableStateOf(false) }
    var fetchError by remember { mutableStateOf<String?>(null) }
    val scheme = MaterialTheme.colorScheme
    val running = run?.running ?: false
    val isError = run?.isError == true
    val locked = awaitingApproval && (run == null || running)
    val name = call.name.ifBlank { run?.tool.orEmpty() }
    val state = when {
        locked -> "waiting for approval"
        running -> "running"
        isError -> "failed"
        run != null -> "done"
        queued -> "queued"
        else -> "no result"
    }
    val summary = toolSummary(call, run)
    val border = when {
        isError -> scheme.error
        locked -> scheme.tertiary
        running -> scheme.primary.copy(alpha = 0.6f)
        else -> scheme.outlineVariant
    }
    OutlinedCard(
        shape = OmprShapes.block,
        colors = CardDefaults.outlinedCardColors(containerColor = scheme.surface),
        border = BorderStroke(1.dp, border),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Tool $name, $state. $summary" },
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().heightIn(min = Dimens.touch).clickable { open = !open }.padding(horizontal = Dimens.md, vertical = Dimens.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                    when {
                        locked -> Icon(Icons.Filled.Lock, "Waiting for your approval", Modifier.size(20.dp), tint = scheme.tertiary)
                        running -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        isError -> Icon(Icons.Filled.Error, "Failed", Modifier.size(20.dp), tint = scheme.error)
                        run != null -> Icon(Icons.Filled.CheckCircle, "Done", Modifier.size(20.dp), tint = scheme.tertiary)
                        queued -> Icon(Icons.Filled.HourglassTop, "About to run", Modifier.size(18.dp), tint = scheme.onSurfaceVariant)
                        else -> Icon(Icons.Filled.Build, null, Modifier.size(18.dp), tint = scheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.size(Dimens.md))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                        Text(name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        if (locked) Text("needs approval", style = MaterialTheme.typography.labelSmall, color = scheme.tertiary)
                        else if (isError) Text("failed", style = MaterialTheme.typography.labelSmall, color = scheme.error)
                    }
                    if (summary.isNotBlank()) Text(summary, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
                }
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Collapse tool call" else "Expand tool call", tint = scheme.onSurfaceVariant)
            }
            if (running && !locked) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
            val images = run?.images.orEmpty()
            if (images.isNotEmpty()) {
                Column(
                    Modifier.padding(start = Dimens.md, end = Dimens.md, bottom = Dimens.md - Dimens.xxs),
                    verticalArrangement = Arrangement.spacedBy(Dimens.sm),
                ) {
                    for (img in images) {
                        InlineImage(img.ref, img.mimeType, conn, maxHeight = 320)
                    }
                }
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(start = Dimens.md, end = Dimens.md, bottom = Dimens.md), verticalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                    val rawArgs = if (call.arguments.isNotEmpty()) call.arguments else (run?.args as? JsonObject)
                    // omp passes the intent under the reserved argument "i"; it is already the card subtitle.
                    val args = rawArgs?.let { a -> if (!call.intent.isNullOrBlank() || run?.intent != null) JsonObject(a.filterKeys { it != "i" }) else a }
                    if (args != null && args.isNotEmpty()) {
                        Text("Arguments", style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
                        CodeBox(argsText(args), maxHeight = 180)
                    }
                    val output = fullOutput ?: run?.output.orEmpty()
                    if (output.isNotEmpty()) {
                        Text("Output", style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
                        CodeBox(output, maxHeight = 320, error = isError)
                    } else if (locked) {
                        Text("Waiting for your approval before this runs.", style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                    } else if (!running) {
                        Text("No output", style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                    }
                    if (run?.truncated == true && fullOutput == null) {
                        TextButton(enabled = !fetching, onClick = {
                            fetching = true
                            fetchError = null
                            scope.launch {
                                try {
                                    handle.fetchFullToolOutput(call.id)
                                } catch (e: Exception) {
                                    fetchError = e.userMessage()
                                } finally {
                                    fetching = false
                                }
                            }
                        }) { Text(if (fetching) "Loading…" else "Load full output") }
                        fetchError?.let { Text(it, color = scheme.error, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

private fun argsText(args: JsonObject): String {
    // A lone string argument (e.g. bash "command") reads better raw than as JSON.
    val only = args.entries.singleOrNull()
    val prim = only?.value as? JsonPrimitive
    if (prim != null && prim.isString) return prim.content
    return PrettyJson.encodeToString(JsonObject.serializer(), args)
}

@Composable
fun CodeBox(text: String, maxHeight: Int, error: Boolean = false, modifier: Modifier = Modifier) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(Dimens.sm),
        modifier = modifier.fillMaxWidth().heightIn(max = maxHeight.dp),
    ) {
        SelectionContainer {
            Box(Modifier.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(Dimens.sm)) {
                Text(
                    text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
fun InlineImage(ref: String, mime: String, conn: HostConnection, maxHeight: Int = 320) {
    val bmp by produceState<Result<androidx.compose.ui.graphics.ImageBitmap>?>(null, ref) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val blob = conn.blobs.get(ref)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(blob.bytes, 0, blob.bytes.size, bounds)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1600) sample *= 2
                val opts = BitmapFactory.Options().apply { inSampleSize = sample }
                BitmapFactory.decodeByteArray(blob.bytes, 0, blob.bytes.size, opts)!!.asImageBitmap()
            }
        }
    }
    val r = bmp
    Box(Modifier.heightIn(max = maxHeight.dp).clip(OmprShapes.block), contentAlignment = Alignment.Center) {
        when {
            r == null -> Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
            r.isSuccess -> Image(r.getOrThrow(), "Image from the conversation", contentScale = ContentScale.Fit, modifier = Modifier.heightIn(max = maxHeight.dp))
            else -> Row(Modifier.padding(Dimens.sm), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.BrokenImage, null)
                Spacer(Modifier.size(Dimens.sm))
                Text("Image unavailable ($mime)", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
