package app.ompr.ui.hosts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.unit.dp
import app.ompr.data.HostRecord
import app.ompr.data.SessionKind
import app.ompr.ui.common.ConnectionDot
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.timeAgo
import app.ompr.ui.home.LinkState
import app.ompr.ui.home.LiveHost
import app.ompr.ui.home.rememberLiveHosts
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import app.ompr.ui.theme.pcColors
import kotlinx.coroutines.launch

/** The paired PCs with live state. [onBack] is null when this is the first screen (nothing paired yet). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(onOpen: (String) -> Unit, onPair: () -> Unit, onSettings: () -> Unit, onBack: (() -> Unit)? = null) {
    val graph = LocalGraph.current
    val hosts by graph.hosts.hosts.collectAsState()
    val live = rememberLiveHosts(hosts)
    var removing by remember { mutableStateOf<HostRecord?>(null) }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack, modifier = Modifier.size(Dimens.touch)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                title = { Text(if (hosts.isEmpty()) "OMP Remote" else "PCs") },
                actions = { IconButton(onClick = onSettings, modifier = Modifier.size(Dimens.touch)) { Icon(Icons.Filled.Settings, "Settings") } },
            )
        },
        floatingActionButton = {
            if (hosts.isNotEmpty()) ExtendedFloatingActionButton(onClick = onPair, icon = { Icon(Icons.Filled.Add, null) }, text = { Text("Pair a PC") })
        },
    ) { pad ->
        if (hosts.isEmpty()) {
            EmptyState(
                title = "Control your coding agents from here",
                body = "Pair this phone with the PC where omp runs. On the PC: install the bridge, run `ompr init`, then `ompr pair` and scan the QR code.",
                modifier = Modifier.padding(pad),
                action = { Button(onClick = onPair) { Text("Pair a PC") } },
            )
        } else {
            LazyColumn(
                Modifier.padding(pad).fillMaxSize(),
                contentPadding = PaddingValues(Dimens.screen, Dimens.xs, Dimens.screen, Dimens.fabClearance),
                verticalArrangement = Arrangement.spacedBy(Dimens.md),
            ) {
                items(live, key = { it.host.hostId }) { l -> HostCard(l, onOpen = { onOpen(l.host.hostId) }, onRemove = { removing = l.host }) }
            }
        }
    }

    removing?.let { h ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${h.name}?") },
            text = { Text("This phone forgets the PC. To also cut its access on the PC side, run `ompr revoke` there (or revoke it from another paired device).") },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    scope.launch {
                        graph.hosts.remove(h.hostId)
                        graph.connections.forget(h.hostId)
                    }
                }, colors = androidx.compose.material3.ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun HostCard(l: LiveHost, onOpen: () -> Unit, onRemove: () -> Unit) {
    val graph = LocalGraph.current
    val h = l.host
    val input = l.input
    val colors = pcColors(input.colorIndex)
    val lastConnected by graph.settings.lastConnected(h.hostId).collectAsState(initial = 0L)
    val link = input.link
    val stateText = when (link) {
        LinkState.CONNECTED -> "Connected"
        LinkState.CONNECTING -> "Connecting…"
        LinkState.UNREACHABLE -> "Unreachable"
    }
    val open = input.sessions.items.count { it.kind != SessionKind.RECENT }
    val detail = buildList {
        if (input.sessions.loaded && link != LinkState.UNREACHABLE) add(if (open == 1) "1 open session" else "$open open sessions")
        if (link != LinkState.CONNECTED) {
            add(if (lastConnected > 0) "last connected ${timeAgo(lastConnected)}" else "never connected")
        }
    }.joinToString(" · ")
    Card(
        onClick = onOpen,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${h.name}, ${stateText.trimEnd('…')}" },
        shape = OmprShapes.card,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Row(Modifier.padding(start = Dimens.lg, top = Dimens.md, bottom = Dimens.md, end = Dimens.xs), verticalAlignment = Alignment.CenterVertically) {
            Surface(color = colors.container, contentColor = colors.onContainer, shape = OmprShapes.chip, modifier = Modifier.size(44.dp)) {
                Icon(Icons.Filled.Computer, null, Modifier.padding(11.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = Dimens.lg), verticalArrangement = Arrangement.spacedBy(Dimens.xxs)) {
                Text(h.name, style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.sm - 2.dp)) {
                    ConnectionDot(connected = link == LinkState.CONNECTED, connecting = link == LinkState.CONNECTING)
                    Text(stateText, style = MaterialTheme.typography.labelLarge)
                }
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "Paired ${timeAgo(h.pairedAt)} · ${h.relays.size} relay${if (h.relays.size == 1) "" else "s"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(Dimens.touch)) { Icon(Icons.Filled.Delete, "Remove ${h.name}") }
        }
    }
}
