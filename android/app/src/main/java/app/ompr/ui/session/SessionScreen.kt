package app.ompr.ui.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.SessionPhase
import app.ompr.ui.files.SessionFilesMenu
import app.ompr.net.ConnState
import app.ompr.ui.common.AttachmentController
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.ErrorState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.StatusChip
import app.ompr.ui.common.rememberAttachmentLaunchers
import app.ompr.ui.common.rememberFragmentActivity
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.userMessage
import app.ompr.ui.session.sheets.RequestSheet
import app.ompr.ui.session.sheets.SessionSettingsSheet
import app.ompr.ui.session.sheets.SessionSheetActions
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
    hostId: String,
    sid: String,
    onBack: () -> Unit,
    onSwitchSession: (String) -> Unit,
    onOpenOnHost: (hostId: String, sid: String) -> Unit,
    onOpenFiles: (cwd: String) -> Unit,
    onOpenChanges: (cwd: String) -> Unit,
) {
    val graph = LocalGraph.current
    val conn = rememberHostConnection(hostId)
    val activity = rememberFragmentActivity()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val connState by conn.state.collectAsState()

    val handle = remember(conn, sid) { conn.session(sid) }
    DisposableEffect(handle) { onDispose { handle.close() } }
    val view by handle.view.collectAsState()

    // Don't notify about the session the user is looking at; clear what is already showing.
    DisposableEffect(hostId, sid) {
        graph.presence.enterSession(hostId, sid)
        graph.notifier.cancelForSession(hostId, sid)
        onDispose { graph.presence.leaveSession(hostId, sid) }
    }

    val attachments = remember(conn, sid) { AttachmentController(graph.app, graph.scope, conn, sid) }
    DisposableEffect(attachments) { onDispose { attachments.clear() } }
    val launchers = rememberAttachmentLaunchers(attachments)

    var draft by rememberSaveable(sid) { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf(SendMode.FOLLOW_UP) }
    var sending by remember { mutableStateOf(false) }
    var interrupting by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

    // ── pending UI requests ──
    val pending = view.pendingUi.sortedBy { it.createdAt }
    val first = pending.firstOrNull()
    var sheetFor by remember { mutableStateOf<String?>(null) }
    var dismissedFor by remember { mutableStateOf<String?>(null) }
    var answering by remember { mutableStateOf(false) }
    var answerError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(first?.reqId) {
        answerError = null
        if (first != null && first.reqId != dismissedFor) sheetFor = first.reqId else if (first == null) sheetFor = null
    }

    val actions = remember(onSwitchSession, onOpenOnHost, onBack) {
        object : SessionSheetActions {
            override fun switchSession(sid: String) = onSwitchSession(sid)
            override fun openOnHost(hostId: String, sid: String) = onOpenOnHost(hostId, sid)
            override fun leave() = onBack()
            override fun toast(msg: String) { scope.launch { snack.showSnackbar(msg) } }
        }
    }

    // ── transcript ──
    val rows = remember(view.messages, view.busy) { buildRows(view) }
    val listState = rememberLazyListState()
    var stick by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress to listState.canScrollForward }.collect { (dragging, canFwd) -> if (dragging) stick = !canFwd }
    }
    val lastKey = rows.lastOrNull()?.key
    LaunchedEffect(rows.size, lastKey, view.rev, view.phase) {
        if (stick && rows.isNotEmpty()) listState.scrollToItem(rows.size + (if (view.hasMore) 1 else 0) - 1)
    }
    LaunchedEffect(view.hasMore, view.messages.firstOrNull()?.id) {
        if (view.hasMore && view.phase is SessionPhase.Ready) {
            snapshotFlow { listState.firstVisibleItemIndex }.collect { idx ->
                if (idx <= 1) runCatching { handle.loadOlder() }
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f, fill = false)) {
                            Text(view.title.ifBlank { "Session" }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            view.summary?.cwd?.let { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        view.summary?.let {
                            Spacer(Modifier.size(8.dp))
                            StatusChip(if (view.closed) "offline" else if (view.busy) "working" else it.status, pending = view.pendingUi.size)
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { showSettings = true }, enabled = view.summary != null) { Icon(Icons.Filled.Tune, "Session settings") }
                    SessionFilesMenu(conn, view.summary?.cwd, onOpenFiles, onOpenChanges)
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            when (val ph = view.phase) {
                SessionPhase.Loading -> {
                    if (connState is ConnState.Connected || connState is ConnState.Connecting || connState is ConnState.Idle) CenteredProgress(label = "Loading session…")
                    else Box(Modifier.weight(1f))
                }
                is SessionPhase.Failed -> ErrorState(ph.message.ifBlank { "Could not open this session" }, onRetry = { scope.launch { runCatching { handle.refresh() } } })
                else -> {
                    if (ph is SessionPhase.Closed) {
                        Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.WarningAmber, null, Modifier.size(18.dp))
                                Spacer(Modifier.size(8.dp))
                                Text("Session ended${ph.reason.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    StatusBar(view)
                    if (view.busy && view.pendingUi.isEmpty()) LinearProgressIndicator(Modifier.fillMaxWidth())
                    TodoGoalPanel(view)
                    SubagentPanel(
                        view,
                        onCancel = { s -> scope.launch { runCatching { handle.cancelSubagent(s.id) }.onFailure { snack.showSnackbar(it.userMessage()) } } },
                        onSteer = { s, msg -> scope.launch { runCatching { handle.steerSubagent(s.id, msg) }.onFailure { snack.showSnackbar(it.userMessage()) } } },
                    )
                    for (n in view.notices.takeLast(1)) {
                        if (n.level != "info" && System.currentTimeMillis() - n.at < 15_000) {
                            Text(n.message, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = if (n.level == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary)
                        }
                    }

                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        PullToRefreshBox(isRefreshing = false, onRefresh = { scope.launch { runCatching { handle.refresh() } } }, modifier = Modifier.fillMaxSize()) {
                            if (rows.isEmpty()) {
                                Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                                    Text("No messages yet. Send the first one below.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            } else {
                                LazyColumn(
                                    Modifier.fillMaxSize().semantics { contentDescription = "Conversation" },
                                    state = listState,
                                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    if (view.hasMore) item(key = "more") {
                                        Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                            if (view.loadingMore) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                                            else TextButton(onClick = { scope.launch { runCatching { handle.loadOlder() } } }) { Text("Load earlier messages") }
                                        }
                                    }
                                    items(rows, key = { it.key }) { r -> TranscriptRow(r, view, handle, conn) }
                                }
                            }
                        }
                        if (!stick && rows.isNotEmpty()) {
                            SmallFloatingActionButton(
                                onClick = { stick = true; scope.launch { listState.animateScrollToItem(listState.layoutInfo.totalItemsCount - 1) } },
                                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                            ) { Icon(Icons.Filled.KeyboardArrowDown, "Jump to latest") }
                        }
                    }

                    if (first != null && sheetFor == null) {
                        Surface(
                            color = MaterialTheme.colorScheme.tertiaryContainer,
                            modifier = Modifier.fillMaxWidth().clickable { dismissedFor = null; sheetFor = first.reqId }.testTag("pending_bar"),
                        ) {
                            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    if (pending.size == 1) "The agent is waiting for you" else "${pending.size} requests are waiting for you",
                                    style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f),
                                )
                                Text("Review", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                    QueueChips(
                        view,
                        onRemove = { msg, q -> scope.launch { runCatching { handle.removeQueued(msg, q) }.onFailure { snack.showSnackbar(it.userMessage()) } } },
                        onPromote = { msg -> scope.launch { runCatching { handle.promoteQueued(msg) }.onFailure { snack.showSnackbar(it.userMessage()) } } },
                    )
                    Composer(
                        view = view,
                        draft = draft,
                        onDraft = { draft = it },
                        attachments = attachments,
                        launchers = launchers,
                        mode = mode,
                        onMode = { mode = it },
                        sending = sending,
                        interrupting = interrupting,
                        onSend = {
                            val text = draft.trim()
                            val refs = attachments.refs()
                            val behavior = if (view.busy) (if (mode == SendMode.STEER && view.can(app.ompr.data.Cap.STEER)) "steer" else "followUp") else null
                            sending = true
                            scope.launch {
                                try {
                                    handle.prompt(text, refs, behavior)
                                    draft = ""
                                    attachments.clear()
                                    stick = true
                                } catch (e: Exception) {
                                    snack.showSnackbar(e.userMessage())
                                } finally {
                                    sending = false
                                }
                            }
                        },
                        onInterrupt = {
                            interrupting = true
                            scope.launch {
                                try {
                                    val restored = handle.abort()
                                    val back = restored?.let { it.steering + it.followUp }.orEmpty().joinToString("\n\n")
                                    if (back.isNotBlank()) draft = if (draft.isBlank()) back else draft + "\n\n" + back
                                } catch (e: Exception) {
                                    snack.showSnackbar(e.userMessage())
                                } finally {
                                    interrupting = false
                                }
                            }
                        },
                    )
                }
            }
        }
    }

    // ── sheets ──
    val req = pending.firstOrNull { it.reqId == sheetFor }
    if (req != null) {
        RequestSheet(
            request = req,
            position = pending.indexOf(req) + 1,
            total = pending.size,
            busy = answering,
            error = answerError,
            onDismiss = { dismissedFor = req.reqId; sheetFor = null },
            onAnswer = { answer, authorises ->
                scope.launch {
                    answerError = null
                    if (authorises && !graph.gate.guard(activity, "Approve ${(req as? app.ompr.data.UiRequest.Approval)?.tool ?: "request"}")) {
                        answerError = "Authentication is required to approve."
                        return@launch
                    }
                    answering = true
                    try {
                        handle.respond(req.reqId, answer)
                        handle.dropPending(req.reqId)
                        dismissedFor = null
                        sheetFor = null
                    } catch (e: Exception) {
                        answerError = e.userMessage()
                    } finally {
                        answering = false
                    }
                }
            },
        )
    }
    if (showSettings) SessionSettingsSheet(view, handle, actions, onDismiss = { showSettings = false })
}
