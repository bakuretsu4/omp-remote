package app.ompr.ui.session

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.data.Block
import app.ompr.data.Message
import app.ompr.data.SessionView
import app.ompr.data.ToolRun
import app.ompr.net.HostConnection
import app.ompr.net.SessionHandle
import app.ompr.ui.common.userMessage
import com.mikepenz.markdown.m3.Markdown
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private val PrettyJson = Json { prettyPrint = true }

/** One visual row of the transcript. */
sealed interface TRow {
    val key: String

    data class User(val msg: Message) : TRow {
        override val key get() = "u:${msg.id}"
    }

    data class Text(val id: String, val index: Int, val text: String, val streaming: Boolean) : TRow {
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
}

/** Flattens messages into rows. `toolResult` messages are folded into their tool card, not shown on their own. */
fun buildRows(view: SessionView): List<TRow> {
    val out = ArrayList<TRow>(view.messages.size * 2)
    val lastAssistant = view.messages.lastOrNull { it.role == "assistant" }?.id
    val seenCalls = HashSet<String>()
    for (m in view.messages) {
        if (m.role == "assistant") for (b in m.content) if (b is Block.ToolCall) seenCalls += b.id
    }
    for (m in view.messages) {
        when (m.role) {
            "user" -> out += TRow.User(m)
            "developer" -> m.text.takeIf { it.isNotBlank() }?.let { out += TRow.Notice(m.id, it, false) }
            "assistant" -> {
                m.content.forEachIndexed { i, b ->
                    when (b) {
                        is Block.Text -> if (b.text.isNotBlank()) out += TRow.Text(m.id, i, b.text, view.busy && m.id == lastAssistant && i == m.content.lastIndex)
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
    }
    return out
}

@Composable
fun TranscriptRow(row: TRow, view: SessionView, handle: SessionHandle, conn: HostConnection) {
    when (row) {
        is TRow.User -> UserBubble(row.msg, conn)
        is TRow.Text -> AssistantText(row.text)
        is TRow.Thinking -> ThinkingBlock(row.text)
        is TRow.Tool -> ToolCard(row.call, view.tools[row.call.id], view.fullOutputs[row.call.id], handle, conn)
        is TRow.Img -> InlineImage(row.block.ref, row.block.mimeType, conn)
        is TRow.Notice -> Text(
            row.text,
            style = MaterialTheme.typography.bodySmall,
            color = if (row.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            fontStyle = FontStyle.Italic,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
    }
}

@Composable
private fun UserBubble(m: Message, conn: HostConnection) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
            modifier = Modifier.widthIn(max = 560.dp).semantics { contentDescription = "You said" },
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (!m.from.isNullOrBlank()) Text(m.from, style = MaterialTheme.typography.labelSmall)
                for (b in m.content) when (b) {
                    is Block.Text -> SelectionContainer { Text(b.text, style = MaterialTheme.typography.bodyLarge) }
                    is Block.Image -> InlineImage(b.ref, b.mimeType, conn, maxHeight = 220)
                    else -> Unit
                }
            }
        }
    }
}

@Composable
private fun AssistantText(text: String) {
    Box(Modifier.fillMaxWidth().semantics { contentDescription = "Assistant message" }) {
        SelectionContainer {
            Markdown(content = text, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun ThinkingBlock(text: String) {
    var open by rememberSaveable(text.length / 2000) { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().clickable { open = !open },
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Psychology, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(8.dp))
                Text("Thinking", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Collapse thinking" else "Expand thinking", Modifier.size(20.dp))
            }
            if (!open) {
                Text(text.trim().lineSequence().lastOrNull { it.isNotBlank() }.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, fontStyle = FontStyle.Italic)
            }
            AnimatedVisibility(open) {
                SelectionContainer {
                    Text(text.trim(), style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
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

@Composable
fun ToolCard(call: Block.ToolCall, run: ToolRun?, fullOutput: String?, handle: SessionHandle, conn: HostConnection) {
    var open by rememberSaveable(call.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var fetching by remember { mutableStateOf(false) }
    var fetchError by remember { mutableStateOf<String?>(null) }
    val running = run?.running ?: false
    val isError = run?.isError == true
    val name = call.name.ifBlank { run?.tool.orEmpty() }
    val state = when {
        running -> "running"
        isError -> "failed"
        run != null -> "done"
        else -> "waiting"
    }
    val summary = toolSummary(call, run)
    OutlinedCard(
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Tool $name, $state. $summary" },
        border = BorderStroke(1.dp, if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                    when {
                        running -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        isError -> Icon(Icons.Filled.Error, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                        run != null -> Icon(Icons.Filled.CheckCircle, null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(20.dp))
                        else -> Icon(Icons.Filled.Build, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.size(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.labelLarge)
                    if (summary.isNotBlank()) Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
                }
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Collapse tool call" else "Expand tool call")
            }
            val images = run?.images.orEmpty()
            if (images.isNotEmpty()) {
                Column(
                    Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (img in images) {
                        InlineImage(img.ref, img.mimeType, conn, maxHeight = 320)
                    }
                }
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val rawArgs = if (call.arguments.isNotEmpty()) call.arguments else (run?.args as? JsonObject)
                    // omp passes the intent under the reserved argument "i"; it is already the card subtitle.
                    val args = rawArgs?.let { a -> if (!call.intent.isNullOrBlank() || run?.intent != null) JsonObject(a.filterKeys { it != "i" }) else a }
                    if (args != null && args.isNotEmpty()) {
                        Text("Arguments", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        CodeBox(argsText(args), maxHeight = 180)
                    }
                    val output = fullOutput ?: run?.output.orEmpty()
                    if (output.isNotEmpty()) {
                        Text("Output", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        CodeBox(output, maxHeight = 320, error = isError)
                    } else if (!running) {
                        Text("No output", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                        fetchError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
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
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        shape = RoundedCornerShape(8.dp),
        modifier = modifier.fillMaxWidth().heightIn(max = maxHeight.dp),
    ) {
        SelectionContainer {
            Box(Modifier.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(8.dp)) {
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
    Box(Modifier.heightIn(max = maxHeight.dp).clip(RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        when {
            r == null -> Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
            r.isSuccess -> Image(r.getOrThrow(), "Image from the conversation", contentScale = ContentScale.Fit, modifier = Modifier.heightIn(max = maxHeight.dp))
            else -> Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.BrokenImage, null)
                Spacer(Modifier.size(8.dp))
                Text("Image unavailable ($mime)", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
