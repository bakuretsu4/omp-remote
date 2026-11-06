package app.ompr.ui.dashboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Badge
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.R
import app.ompr.data.Features
import app.ompr.data.SessionKind
import app.ompr.data.supports
import app.ompr.net.ConnState
import app.ompr.net.openRecent
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.rememberHostColorIndex
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.userMessage
import app.ompr.ui.home.HomeEmpty
import app.ompr.ui.home.HostInput
import app.ompr.ui.home.SectionActions
import app.ompr.ui.home.buildHome
import app.ompr.ui.home.linkStateOf
import app.ompr.ui.home.reasonOf
import app.ompr.ui.home.rememberAttention
import app.ompr.ui.home.sessionSections
import app.ompr.ui.theme.Dimens
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.TimeZone

/**
 * One PC: its sessions (same cards and sections as Home) plus entries for usage and the PC's settings.
 * Reached from the PC list; the back arrow returns to Home.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    hostId: String,
    onOpenSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onHostSettings: () -> Unit,
    onHome: () -> Unit,
    onUsage: () -> Unit,
) {
    val graph = LocalGraph.current
    val conn = rememberHostConnection(hostId)
    val hosts by graph.hosts.hosts.collectAsState()
    val host = hosts.firstOrNull { it.hostId == hostId }
    val state by conn.state.collectAsState()
    val info by conn.info.collectAsState()
    val list by conn.sessions.collectAsState()
    val attention = rememberAttention(conn)
    val colorIndex = rememberHostColorIndex(hostId)
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var showAllRecent by rememberSaveable { mutableStateOf(false) }
    var opening by remember { mutableStateOf<String?>(null) }

    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }

    val input = HostInput(hostId, host?.name ?: "PC", colorIndex, linkStateOf(state), list, attention, reasonOf(state))
    val model = buildHome(listOf(input), null, now, TimeZone.getDefault(), showAllRecent)
    val pendingTotal = list.items.sumOf { it.pendingUi }
    val canUsage = info.supports(Features.USAGE)

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onHome, modifier = Modifier.size(Dimens.touch)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to Home") }
                },
                title = {
                    Column {
                        Text(host?.name ?: "PC", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val sub = when (val s = state) {
                            is ConnState.Connected -> if (s.lan) "Connected · LAN" else "Connected · relay"
                            is ConnState.Connecting -> "Connecting…"
                            is ConnState.Offline -> "Unreachable"
                            is ConnState.Fatal -> "Problem"
                            ConnState.Idle -> ""
                        }
                        if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                actions = {
                    if (pendingTotal > 0) Badge(Modifier.padding(end = Dimens.xs)) { Text("$pendingTotal") }
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
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Dimens.screen, vertical = Dimens.xs),
                horizontalArrangement = Arrangement.spacedBy(Dimens.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (canUsage) {
                    AssistChip(onClick = onUsage, label = { Text(stringResource(R.string.usage_menu)) }, leadingIcon = { Icon(Icons.Filled.BarChart, null, Modifier.size(18.dp)) })
                }
                AssistChip(onClick = onHostSettings, label = { Text("PC settings") }, leadingIcon = { Icon(Icons.Filled.Settings, null, Modifier.size(18.dp)) })
            }
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
                when (model.empty) {
                    HomeEmpty.LOADING -> CenteredProgress(label = "Loading sessions…")
                    HomeEmpty.UNREACHABLE -> EmptyState("Not connected", "Sessions appear here as soon as this PC is reachable. Check that the bridge (`ompr run`) is running on it.")
                    HomeEmpty.NO_SESSIONS -> EmptyState("No sessions yet", "Start one with “New session”, or open omp on this PC — running terminal sessions show up here too.")
                    HomeEmpty.NONE -> {
                        val actions = SectionActions(
                            now = now,
                            showPc = false,
                            openingKey = opening,
                            onOpen = { s ->
                                val file = s.summary.sessionFile
                                if (s.summary.kind != SessionKind.RECENT || file == null) {
                                    onOpenSession(s.summary.sid)
                                } else if (opening == null) {
                                    opening = s.key
                                    scope.launch {
                                        try {
                                            onOpenSession(conn.openRecent(file))
                                        } catch (e: Exception) {
                                            snack.showSnackbar(e.userMessage())
                                        } finally {
                                            opening = null
                                        }
                                    }
                                }
                            },
                            onShowMore = { showAllRecent = true },
                        )
                        LazyColumn(
                            Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(Dimens.screen, Dimens.xs, Dimens.screen, Dimens.fabClearance),
                            verticalArrangement = Arrangement.spacedBy(Dimens.cardGap),
                        ) { sessionSections(model, actions) }
                    }
                }
            }
        }
    }
}
