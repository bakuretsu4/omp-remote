package app.ompr.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import app.ompr.data.AttentionItem
import app.ompr.data.HostRecord
import app.ompr.net.HostConnection
import app.ompr.net.attentionList
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.rememberHostConnections
import app.ompr.ui.theme.PcPalette
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.collectLatest

/** A paired PC with its live connection. */
class LiveHost(val host: HostRecord, val conn: HostConnection, val input: HostInput)

/**
 * Connects to every paired PC while the caller is STARTED and releases the connections when it leaves composition, and
 * returns what is known about each one (link state, session list, unresolved approvals/questions).
 */
@Composable
fun rememberLiveHosts(hosts: List<HostRecord>): List<LiveHost> {
    val conns = rememberHostConnections(hosts.map { it.hostId })
    val colors = remember(hosts) { hostColorIndices(hosts.map { it.hostId to it.pairedAt }, PcPalette.size) }
    return hosts.mapIndexed { i, h ->
        key(h.hostId) {
            val conn = conns[i]
            val state by conn.state.collectAsState()
            val list by conn.sessions.collectAsState()
            val attention = rememberAttention(conn)
            LiveHost(h, conn, HostInput(h.hostId, h.name, colors[h.hostId] ?: 0, linkStateOf(state), list, attention, reasonOf(state)))
        }
    }
}

/**
 * Unresolved approvals and questions of one PC: a snapshot after every connect and whenever the session list changes
 * (so a missed event heals itself), plus live attention events in between.
 */
@Composable
fun rememberAttention(conn: HostConnection): List<AttentionItem> {
    var items by remember(conn) { mutableStateOf(emptyList<AttentionItem>()) }
    LaunchedEffect(conn) {
        val shape = conn.sessions.map { l -> l.items.map { Triple(it.sid, it.status, it.pendingUi) } }.distinctUntilChanged()
        combine(conn.connectCount, shape) { _, _ -> }.collectLatest {
            if (conn.isConnected) runCatching { items = actionableAttention(conn.attentionList()) }
        }
    }
    LaunchedEffect(conn) { conn.hostEvents.collect { ev -> items = applyAttentionEvent(items, ev) } }
    return items
}
