package app.ompr.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import app.ompr.ui.home.hostColorIndices
import app.ompr.ui.theme.PcPalette

/** The palette slot of [hostId] (stable per PC, see [hostColorIndices]); 0 when the PC is unknown. */
@Composable
fun rememberHostColorIndex(hostId: String): Int {
    val hosts by LocalGraph.current.hosts.hosts.collectAsState()
    return remember(hosts, hostId) { hostColorIndices(hosts.map { it.hostId to it.pairedAt }, PcPalette.size)[hostId] ?: 0 }
}

/** The display name of [hostId], or "PC" when unknown. */
@Composable
fun rememberHostName(hostId: String): String {
    val hosts by LocalGraph.current.hosts.hosts.collectAsState()
    return hosts.firstOrNull { it.hostId == hostId }?.name ?: "PC"
}
