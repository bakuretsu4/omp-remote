package app.ompr.ui.files

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.ui.theme.Dimens
import app.ompr.R
import app.ompr.data.GitStatusFile
import app.ompr.data.GitStatusResult
import app.ompr.net.ConnState
import app.ompr.net.gitDiff
import app.ompr.net.gitStatus
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.ErrorState
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.userMessage
import kotlinx.coroutines.CancellationException

private sealed interface StatusLoad {
    data object Loading : StatusLoad
    data class Ok(val status: GitStatusResult) : StatusLoad
    data object NotRepo : StatusLoad
    data class Failed(val message: String) : StatusLoad
}

/** `git status` of [path] (a session's working directory) as a list; tapping a file opens its diff. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangesScreen(hostId: String, path: String, onBack: () -> Unit) {
    val conn = rememberHostConnection(hostId)
    val connState by conn.state.collectAsState()
    var attempt by remember { mutableStateOf(0) }
    var load by remember { mutableStateOf<StatusLoad>(StatusLoad.Loading) }
    var selected by remember { mutableStateOf<GitStatusFile?>(null) }
    val connected = connState is ConnState.Connected
    LaunchedEffect(path, attempt, connected) {
        if (!connected) return@LaunchedEffect
        load = StatusLoad.Loading
        load = try {
            StatusLoad.Ok(conn.gitStatus(path))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (isNotRepository(e)) StatusLoad.NotRepo else StatusLoad.Failed(e.userMessage())
        }
    }

    val ok = load as? StatusLoad.Ok
    val sel = selected
    if (ok != null && sel != null) {
        BackHandler { selected = null }
        FileChange(hostId, ok.status.root, sel, onClose = { selected = null })
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Column {
                        Text(stringResource(R.string.changes_title))
                        val branch = ok?.status?.branch
                        if (branch != null) Text(branch, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = { IconButton(onClick = { attempt++ }) { Icon(Icons.Filled.Refresh, stringResource(R.string.files_refresh)) } },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            when (val l = load) {
                StatusLoad.Loading -> CenteredProgress(label = if (connected) "Reading changes\u2026" else "Waiting for connection\u2026")
                StatusLoad.NotRepo -> EmptyState(stringResource(R.string.changes_not_repo_title), stringResource(R.string.changes_not_repo_body))
                is StatusLoad.Failed -> ErrorState(l.message, onRetry = { attempt++ })
                is StatusLoad.Ok -> {
                    if (l.status.truncated) Notice(stringResource(R.string.changes_truncated))
                    if (l.status.files.isEmpty()) EmptyState(stringResource(R.string.changes_clean_title), stringResource(R.string.changes_clean_body))
                    else LazyColumn(Modifier.fillMaxSize()) {
                        items(l.status.files, key = { it.path }) { f ->
                            val code = StatusCode(f.status)
                            ListItem(
                                headlineContent = { Text(baseName(f.path), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                supportingContent = {
                                    Column {
                                        if (f.path.contains('/')) Text(parentOf(f.path), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                                        Text(code.label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                },
                                leadingContent = { StatusBadge(code) },
                                modifier = Modifier.clickable { selected = f },
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusBadge(code: StatusCode) {
    val scheme = MaterialTheme.colorScheme
    val (bg, fg) = when (code.kind) {
        ChangeKind.ADDED, ChangeKind.COPIED -> scheme.primaryContainer to scheme.onPrimaryContainer
        ChangeKind.DELETED, ChangeKind.CONFLICT -> scheme.errorContainer to scheme.onErrorContainer
        ChangeKind.MODIFIED, ChangeKind.RENAMED, ChangeKind.TYPE_CHANGED -> scheme.tertiaryContainer to scheme.onTertiaryContainer
        else -> scheme.surfaceVariant to scheme.onSurfaceVariant
    }
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(6.dp)) {
        Text(code.badge, Modifier.padding(horizontal = Dimens.sm, vertical = Dimens.xs), style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace)
    }
}

private sealed interface DiffLoad {
    data object Loading : DiffLoad
    data class Ok(val lines: List<DiffLine>, val truncated: Boolean) : DiffLoad
    data class Failed(val message: String) : DiffLoad
}

/** One changed file: its diff (staged or work tree), or the file itself when it is untracked and has no diff. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FileChange(hostId: String, root: String, file: GitStatusFile, onClose: () -> Unit) {
    val code = remember(file) { StatusCode(file.status) }
    if (code.untracked) {
        FileViewer(hostId, joinPath(root, file.path), onClose)
        return
    }
    val conn = rememberHostConnection(hostId)
    val connState by conn.state.collectAsState()
    var staged by remember(file) { mutableStateOf(defaultStaged(code)) }
    var attempt by remember { mutableStateOf(0) }
    var load by remember(file) { mutableStateOf<DiffLoad>(DiffLoad.Loading) }
    val connected = connState is ConnState.Connected
    LaunchedEffect(file, staged, attempt, connected) {
        if (!connected) return@LaunchedEffect
        load = DiffLoad.Loading
        load = try {
            val r = conn.gitDiff(root, file.path, staged)
            DiffLoad.Ok(parseDiff(r.diff), r.truncated)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DiffLoad.Failed(e.userMessage())
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Column {
                        Text(baseName(file.path), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(code.label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            if (code.staged && code.unstaged) {
                Row(Modifier.padding(horizontal = Dimens.lg, vertical = Dimens.sm), horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                    FilterChip(selected = !staged, onClick = { staged = false }, label = { Text(stringResource(R.string.changes_unstaged)) })
                    FilterChip(selected = staged, onClick = { staged = true }, label = { Text(stringResource(R.string.changes_staged)) })
                }
            }
            when (val l = load) {
                DiffLoad.Loading -> CenteredProgress(label = if (connected) "Loading diff\u2026" else "Waiting for connection\u2026")
                is DiffLoad.Failed -> ErrorState(l.message, onRetry = { attempt++ })
                is DiffLoad.Ok -> {
                    if (l.truncated) Notice(stringResource(R.string.changes_diff_truncated))
                    if (l.lines.isEmpty()) EmptyState(stringResource(R.string.changes_no_diff))
                    else DiffView(l.lines)
                }
            }
        }
    }
}

@Composable
private fun DiffView(lines: List<DiffLine>) {
    val dark = isSystemInDarkTheme()
    val addedBg = if (dark) Color(0xFF1B4D2B).copy(alpha = 0.6f) else Color(0xFFCFF0D4)
    val removedBg = if (dark) Color(0xFF6B1F1F).copy(alpha = 0.6f) else Color(0xFFFFD6D6)
    val hunkBg = MaterialTheme.colorScheme.secondaryContainer
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // Rows are as wide as the longest line (or the screen) so the added/removed tint is a full-width band.
    val longest = remember(lines) { lines.maxOf { clipLine(it.text).length } }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val rowWidth = maxOf(maxWidth, (longest * 7.4f + 16f).dp)
        Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
            LazyColumn(Modifier.fillMaxSize()) {
                items(lines.size) { i ->
                    val line = lines[i]
                    val bg = when (line.kind) {
                        DiffLineKind.ADDED -> addedBg
                        DiffLineKind.REMOVED -> removedBg
                        DiffLineKind.HUNK -> hunkBg
                        else -> Color.Transparent
                    }
                    val fg = when (line.kind) {
                        DiffLineKind.HUNK -> MaterialTheme.colorScheme.onSecondaryContainer
                        DiffLineKind.HEADER, DiffLineKind.NOTE -> muted
                        else -> MaterialTheme.colorScheme.onSurface
                    }
                    Text(
                        clipLine(line.text).ifEmpty { " " },
                        Modifier.widthIn(min = rowWidth).background(bg).padding(horizontal = Dimens.sm),
                        color = fg,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        softWrap = false,
                    )
                }
            }
        }
    }
}
