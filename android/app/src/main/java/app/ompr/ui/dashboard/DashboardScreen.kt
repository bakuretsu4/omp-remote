package app.ompr.ui.dashboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.SessionKind
import app.ompr.data.SessionSummary
import app.ompr.net.ConnState
import app.ompr.net.openRecent
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.StatusChip
import app.ompr.ui.common.formatCost
import app.ompr.ui.common.formatPercent
import app.ompr.ui.common.lastSegment
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.shortPath
import app.ompr.ui.common.timeAgo
import app.ompr.ui.common.userMessage
import app.ompr.ui.common.LocalGraph
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    hostId: String,
    onOpenSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onHostSettings: () -> Unit,
    onSettings: () -> Unit,
    onHosts: () -> Unit,
) {
    val graph = LocalGraph.current
    val conn = rememberHostConnection(hostId)
    val hosts by graph.hosts.hosts.collectAsState()
    val host = hosts.firstOrNull { it.hostId == hostId }
    val state by conn.state.collectAsState()
    val list by conn.sessions.collectAsState()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var menu by remember { mutableStateOf(false) }
    var openingFile by remember { mutableStateOf<String?>(null) }

    // Relative timestamps tick.
    var tick by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); tick = System.currentTimeMillis() } }

    val pendingTotal = list.items.sumOf { it.pendingUi }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(host?.name ?: "PC", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val sub = when (val s = state) {
                            is ConnState.Connected -> if (s.lan) "Connected · LAN" else "Connected · relay"
                            is ConnState.Connecting -> "Connecting…"
                            is ConnState.Offline -> "Offline"
                            is ConnState.Fatal -> "Problem"
                            ConnState.Idle -> ""
                        }
                        if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                actions = {
                    if (pendingTotal > 0) Badge(Modifier.padding(end = 4.dp)) { Text("$pendingTotal") }
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("All PCs") }, leadingIcon = { Icon(Icons.Filled.Computer, null) }, onClick = { menu = false; onHosts() })
                        DropdownMenuItem(text = { Text("This PC's settings") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menu = false; onHostSettings() })
                        DropdownMenuItem(text = { Text("App settings") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menu = false; onSettings() })
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewSession,
                icon = { Icon(Icons.Filled.Add, null) },
                text = { Text("New session") },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state, onRetry = { conn.reconnectNow() })
            PullToRefreshBox(
                isRefreshing = list.refreshing && list.loaded,
                onRefresh = {
                    scope.launch {
                        conn.reconnectNow()
                        runCatching { conn.refreshSessions() }.onFailure { snack.showSnackbar(it.userMessage()) }
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                val items = list.items
                when {
                    !list.loaded && state !is ConnState.Fatal && (state is ConnState.Connecting || state is ConnState.Connected || state is ConnState.Idle) ->
                        CenteredProgress(label = "Loading sessions…")
                    !list.loaded -> EmptyState(
                        "Not connected",
                        "Sessions appear here as soon as the PC is reachable.",
                    )
                    items.isEmpty() -> EmptyState(
                        "No sessions yet",
                        "Start one with “New session”, or open omp on the PC — running TUI sessions show up here too.",
                    )
                    else -> {
                        val live = items.filter { it.kind != SessionKind.RECENT }
                            .sortedWith(compareByDescending<SessionSummary> { it.pendingUi > 0 }.thenByDescending { it.lastActivity })
                        val recent = items.filter { it.kind == SessionKind.RECENT }.sortedByDescending { it.lastActivity }
                        LazyColumn(
                            Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            if (live.isNotEmpty()) {
                                item(key = "h-live") { SectionHeader("Active") }
                                items(live, key = { it.sid }) { s -> SessionCard(s, tick) { onOpenSession(s.sid) } }
                            }
                            if (recent.isNotEmpty()) {
                                item(key = "h-recent") { SectionHeader("Recent") }
                                items(recent, key = { it.sid }) { s ->
                                    SessionCard(s, tick, busy = openingFile == s.sessionFile) {
                                        val file = s.sessionFile
                                        if (file == null) {
                                            onOpenSession(s.sid)
                                        } else if (openingFile == null) {
                                            openingFile = file
                                            scope.launch {
                                                try {
                                                    onOpenSession(conn.openRecent(file))
                                                } catch (e: Exception) {
                                                    snack.showSnackbar(e.userMessage())
                                                } finally {
                                                    openingFile = null
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp).semantics { contentDescription = "$text sessions" },
    )
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SessionCard(s: SessionSummary, @Suppress("UNUSED_PARAMETER") tick: Long, busy: Boolean = false, onClick: () -> Unit) {
    val kindIcon = when (s.kind) {
        SessionKind.TUI -> Icons.Filled.Terminal
        SessionKind.RECENT -> Icons.Filled.History
        else -> Icons.Filled.Smartphone
    }
    val kindLabel = when (s.kind) {
        SessionKind.TUI -> "Terminal session"
        SessionKind.RECENT -> "Recent session"
        else -> "Managed session"
    }
    val attention = s.pendingUi > 0
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (attention) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
        ),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(kindIcon, kindLabel, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(8.dp))
                Text(
                    s.title.ifBlank { lastSegment(s.cwd) },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (s.kind != SessionKind.RECENT) {
                    Spacer(Modifier.size(8.dp))
                    StatusChip(s.status, pending = s.pendingUi)
                }
            }
            if (attention) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Badge()
                    Spacer(Modifier.size(8.dp))
                    Text(
                        if (s.pendingUi == 1) "1 item needs your answer" else "${s.pendingUi} items need your answer",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                }
            }
            Text(
                shortPath(s.cwd),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                s.model?.let { Meta(it.label) }
                if (s.contextPercent != null) Meta("ctx ${formatPercent(s.contextPercent)}")
                if (s.costUsd != null && s.costUsd > 0) Meta(formatCost(s.costUsd))
                if (s.lastActivity > 0) Meta(timeAgo(s.lastActivity))
                if (busy) Meta("opening…")
            }
        }
    }
}

@Composable
private fun Meta(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
