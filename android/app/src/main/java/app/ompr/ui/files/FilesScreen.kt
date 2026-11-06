package app.ompr.ui.files

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.ui.theme.Dimens
import app.ompr.R
import app.ompr.data.FsEntry
import app.ompr.data.FsReadResult
import app.ompr.net.ConnState
import app.ompr.net.fsList
import app.ompr.net.fsRead
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.ErrorState
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.userMessage
import kotlinx.coroutines.CancellationException

private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ok<T>(val value: T) : Load<T>
    data class Failed(val message: String) : Load<Nothing>
}

/**
 * Browses [startPath] (a session's working directory) with `fs.list`, and opens files with `fs.read`.
 * Back steps out of a file, then up through the folders visited, then leaves the screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(hostId: String, startPath: String, onBack: () -> Unit) {
    val conn = rememberHostConnection(hostId)
    val connState by conn.state.collectAsState()
    val info by conn.info.collectAsState()
    val stack = remember { mutableStateListOf(startPath) }
    var viewing by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    val dir = stack.last()

    BackHandler(enabled = viewing != null || stack.size > 1) {
        if (viewing != null) viewing = null else stack.removeAt(stack.lastIndex)
    }

    val connected = connState is ConnState.Connected
    var listing by remember { mutableStateOf<Load<List<FsEntry>>>(Load.Loading) }
    LaunchedEffect(dir, attempt, connected) {
        if (!connected) return@LaunchedEffect
        listing = Load.Loading
        listing = try {
            Load.Ok(conn.fsList(dir, files = true).entries)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Failed(e.userMessage())
        }
    }

    val open = viewing
    if (open != null) {
        FileViewer(hostId, open, onClose = { viewing = null })
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else onBack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Column {
                        Text(stringResource(R.string.files_title))
                        Text(dir, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = { IconButton(onClick = { attempt++ }) { Icon(Icons.Filled.Refresh, stringResource(R.string.files_refresh)) } },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            when (val l = listing) {
                Load.Loading -> CenteredProgress(label = if (connected) "Loading folder\u2026" else "Waiting for connection\u2026")
                is Load.Failed -> ErrorState(l.message, onRetry = { attempt++ })
                is Load.Ok -> {
                    val up = canGoUp(dir, info?.roots.orEmpty())
                    if (l.value.isEmpty() && !up) EmptyState(stringResource(R.string.files_empty))
                    else LazyColumn(Modifier.fillMaxSize()) {
                        if (up) item(key = "up") {
                            ListItem(
                                headlineContent = { Text("..") },
                                leadingContent = { Icon(Icons.Filled.ArrowUpward, "Parent folder") },
                                modifier = Modifier.clickable { stack.add(parentOf(dir)) },
                            )
                        }
                        items(l.value, key = { it.path }) { e ->
                            ListItem(
                                headlineContent = { Text(e.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                supportingContent = e.size?.takeIf { !e.dir }?.let { { Text(formatSize(it)) } },
                                leadingContent = { Icon(if (e.dir) Icons.Filled.Folder else Icons.AutoMirrored.Filled.InsertDriveFile, if (e.dir) "Folder" else "File") },
                                modifier = Modifier.clickable { if (e.dir) stack.add(e.path) else viewing = e.path },
                            )
                            HorizontalDivider()
                        }
                        if (l.value.isEmpty()) item(key = "empty") { Text(stringResource(R.string.files_empty), Modifier.padding(Dimens.lg), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}

/** Full-screen text view of one file (`fs.read`): monospace, line numbers, notices for truncated and binary files. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileViewer(hostId: String, path: String, onClose: () -> Unit) {
    val conn = rememberHostConnection(hostId)
    val connState by conn.state.collectAsState()
    var attempt by remember { mutableStateOf(0) }
    var load by remember(path) { mutableStateOf<Load<FsReadResult>>(Load.Loading) }
    val connected = connState is ConnState.Connected
    LaunchedEffect(path, attempt, connected) {
        if (!connected) return@LaunchedEffect
        load = Load.Loading
        load = try {
            Load.Ok(conn.fsRead(path))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Failed(e.userMessage())
        }
    }
    val clipboard = LocalClipboardManager.current
    BackHandler(onBack = onClose)

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Column {
                        Text(baseName(path), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(path, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = {
                    val text = (load as? Load.Ok)?.value?.text
                    if (text != null) IconButton(onClick = { clipboard.setText(AnnotatedString(text)) }) { Icon(Icons.Filled.ContentCopy, stringResource(R.string.files_copy)) }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            when (val l = load) {
                Load.Loading -> CenteredProgress(label = if (connected) "Opening file\u2026" else "Waiting for connection\u2026")
                is Load.Failed -> ErrorState(l.message, onRetry = { attempt++ })
                is Load.Ok -> {
                    val r = l.value
                    when {
                        r.binary -> EmptyState(stringResource(R.string.files_binary_title), stringResource(R.string.files_binary_body, formatSize(r.size)))
                        else -> {
                            val shown = r.text.orEmpty()
                            if (r.truncated) Notice(stringResource(R.string.files_truncated, formatSize(remember(shown) { shown.toByteArray().size.toLong() }), formatSize(r.size)))
                            if (shown.isEmpty()) EmptyState(stringResource(R.string.files_empty_file)) else CodeView(splitLines(shown))
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun Notice(text: String) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Text(text, Modifier.padding(horizontal = Dimens.lg, vertical = Dimens.sm), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

/** Lines with a right-aligned line-number gutter, horizontally scrollable (no wrapping). */
@Composable
private fun CodeView(lines: List<String>) {
    val digits = gutterDigits(lines.size)
    Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(lines.size) { i ->
                Row(Modifier.padding(horizontal = Dimens.sm)) {
                    Text(
                        (i + 1).toString().padStart(digits),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        softWrap = false,
                        modifier = Modifier.padding(end = Dimens.md),
                    )
                    Text(clipLine(lines[i]), fontFamily = FontFamily.Monospace, fontSize = 12.sp, softWrap = false)
                }
            }
        }
    }
}
