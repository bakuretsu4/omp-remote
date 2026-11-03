package app.ompr.ui.hosts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.unit.dp
import app.ompr.data.HostRecord
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.timeAgo
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(onOpen: (String) -> Unit, onPair: () -> Unit, onSettings: () -> Unit) {
    val graph = LocalGraph.current
    val hosts by graph.hosts.hosts.collectAsState()
    var removing by remember { mutableStateOf<HostRecord?>(null) }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("OMP Remote") },
                actions = { IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, "Settings") } },
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
                contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(hosts, key = { it.hostId }) { h ->
                    Card(Modifier.fillMaxWidth().clickable { onOpen(h.hostId) }, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Computer, null, Modifier.size(32.dp))
                            Spacer(Modifier.size(16.dp))
                            Column(Modifier.weight(1f)) {
                                Text(h.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    "Paired ${timeAgo(h.pairedAt)} · ${h.relays.size} relay${if (h.relays.size == 1) "" else "s"}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            IconButton(onClick = { removing = h }) { Icon(Icons.Filled.Delete, "Remove ${h.name}") }
                        }
                    }
                }
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
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
}
