package app.ompr.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.ompr.net.openRecent
import app.ompr.data.SessionKind
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionDot
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.userMessage
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import app.ompr.ui.theme.pcColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.TimeZone

/**
 * The start screen once a PC is paired: sessions of all PCs at once, those that need you first.
 * Connections to every PC are held while the screen is visible.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onOpenSession: (hostId: String, sid: String) -> Unit,
    onNewSession: (hostId: String) -> Unit,
    onHosts: () -> Unit,
    onSettings: () -> Unit,
    onNoHosts: () -> Unit,
) {
    val graph = LocalGraph.current
    val hostList by graph.hosts.hosts.collectAsState()
    // Every PC was removed: back to the pairing onboarding.
    LaunchedEffect(hostList.isEmpty()) { if (hostList.isEmpty()) onNoHosts() }
    val live = rememberLiveHosts(hostList)
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }

    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var showAllRecent by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var pickingPc by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf<String?>(null) }

    // Relative timestamps tick.
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }

    val inputs = live.map { it.input }
    val filter = effectiveFilter(inputs, selected)
    val model = buildHome(inputs, filter, now, TimeZone.getDefault(), showAllRecent)
    val refreshing = live.any { it.input.sessions.refreshing && it.input.sessions.loaded }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                title = { Text("OMP Remote") },
                actions = {
                    IconButton(onClick = { menu = true }, modifier = Modifier.size(Dimens.touch)) { Icon(Icons.Filled.MoreVert, "More") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("PCs") }, leadingIcon = { Icon(Icons.Filled.Computer, null) }, onClick = { menu = false; onHosts() })
                        DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menu = false; onSettings() })
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = {
                    val target = filter ?: inputs.singleOrNull()?.hostId
                    if (target != null) onNewSession(target) else pickingPc = true
                },
                icon = { Icon(Icons.Filled.Add, null) },
                text = { Text("New session") },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (inputs.size > 1) {
                PcFilterRow(inputs, filter, onSelect = { selected = it })
            }
            for (u in model.unreachable) {
                val conn = live.first { it.input.hostId == u.hostId }.conn
                UnreachableBanner(u, onRetry = { conn.reconnectNow() })
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        for (l in live) {
                            l.conn.reconnectNow()
                            launch { runCatching { l.conn.refreshSessions() }.onFailure { snack.showSnackbar("${l.host.name}: ${it.userMessage()}") } }
                        }
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                when (model.empty) {
                    HomeEmpty.LOADING -> CenteredProgress(label = "Loading sessions…")
                    HomeEmpty.UNREACHABLE -> EmptyState(
                        if (inputs.size > 1 && filter == null) "Can't reach any of your PCs" else "Can't reach this PC",
                        "Sessions show up as soon as a PC answers. Check that the bridge (`ompr run`) is running on it and that it is online.",
                        action = { TextButton(onClick = { live.forEach { it.conn.reconnectNow() } }) { Text("Retry now") } },
                    )
                    HomeEmpty.NO_SESSIONS -> EmptyState(
                        "No sessions yet",
                        "Start one with “New session”, or open omp on a PC — running terminal sessions show up here too.",
                    )
                    HomeEmpty.NONE -> {
                        val actions = SectionActions(
                            now = now,
                            showPc = inputs.size > 1 && filter == null,
                            openingKey = opening,
                            onOpen = { s ->
                                val file = s.summary.sessionFile
                                if (s.summary.kind != SessionKind.RECENT || file == null) {
                                    onOpenSession(s.hostId, s.summary.sid)
                                } else if (opening == null) {
                                    opening = s.key
                                    scope.launch {
                                        try {
                                            val conn = live.first { it.input.hostId == s.hostId }.conn
                                            onOpenSession(s.hostId, conn.openRecent(file))
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

    if (pickingPc) {
        ModalBottomSheet(onDismissRequest = { pickingPc = false }) {
            Column(Modifier.navigationBarsPadding().padding(bottom = Dimens.lg)) {
                Text("Start a session on…", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = Dimens.xl, vertical = Dimens.sm))
                for (h in inputs) {
                    PcPickRow(h) { pickingPc = false; onNewSession(h.hostId) }
                }
            }
        }
    }
}

// ───────────────────────── pieces ─────────────────────────

/** "All" plus one chip per PC, each with its colour dot and connection state. */
@Composable
fun PcFilterRow(hosts: List<HostInput>, selected: String?, onSelect: (String?) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Dimens.screen, vertical = Dimens.xs),
        horizontalArrangement = Arrangement.spacedBy(Dimens.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FilterChip(selected = selected == null, onClick = { onSelect(null) }, label = { Text("All") }, modifier = Modifier.heightIn(min = Dimens.touch))
        for (h in hosts) {
            val c = pcColors(h.colorIndex)
            val state = when (h.link) {
                LinkState.CONNECTED -> "connected"
                LinkState.CONNECTING -> "connecting"
                LinkState.UNREACHABLE -> "unreachable"
            }
            FilterChip(
                selected = selected == h.hostId,
                onClick = { onSelect(if (selected == h.hostId) null else h.hostId) },
                label = { Text(h.name, maxLines = 1) },
                leadingIcon = { Box(Modifier.size(10.dp).background(c.dot, CircleShape)) },
                trailingIcon = {
                    when (h.link) {
                        LinkState.CONNECTED -> ConnectionDot(connected = true, connecting = false)
                        LinkState.CONNECTING -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                        LinkState.UNREACHABLE -> Icon(Icons.Filled.CloudOff, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                    }
                },
                modifier = Modifier.heightIn(min = Dimens.touch).semantics { contentDescription = "${h.name}, $state" },
            )
        }
    }
}

@Composable
fun UnreachableBanner(u: UnreachableHost, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = OmprShapes.block,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Dimens.screen, vertical = Dimens.xs).clickable(onClickLabel = "Retry connecting to ${u.name}", onClick = onRetry),
    ) {
        Row(Modifier.heightIn(min = Dimens.touch).padding(horizontal = Dimens.md, vertical = Dimens.sm), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.CloudOff, null, Modifier.size(20.dp))
            Spacer(Modifier.size(Dimens.md))
            Column(Modifier.weight(1f)) {
                Text("${u.name} unreachable, tap to retry", style = MaterialTheme.typography.labelLarge)
                if (!u.reason.isNullOrBlank()) Text(u.reason, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
        }
    }
}

@Composable
private fun PcPickRow(h: HostInput, onClick: () -> Unit) {
    val c = pcColors(h.colorIndex)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = Dimens.xl),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Dimens.md),
    ) {
        Surface(color = c.container, contentColor = c.onContainer, shape = OmprShapes.chip, modifier = Modifier.size(40.dp)) {
            Icon(Icons.Filled.Computer, null, Modifier.padding(Dimens.sm + 2.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(h.name, style = MaterialTheme.typography.titleMedium)
            Text(
                when (h.link) {
                    LinkState.CONNECTED -> "Connected"
                    LinkState.CONNECTING -> "Connecting…"
                    LinkState.UNREACHABLE -> "Unreachable"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
