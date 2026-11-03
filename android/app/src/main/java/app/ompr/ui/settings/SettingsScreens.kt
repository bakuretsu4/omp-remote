package app.ompr.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.ompr.BuildConfig
import app.ompr.data.ApprovalModes
import app.ompr.data.AttentionKinds
import app.ompr.data.DeviceEntry
import app.ompr.net.ConnState
import app.ompr.net.RelayUrls
import app.ompr.net.devicesList
import app.ompr.net.devicesRevoke
import app.ompr.service.PushTokens
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.rememberFragmentActivity
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.timeAgo
import app.ompr.ui.common.userMessage
import app.ompr.ui.newsession.approvalHint
import app.ompr.ui.newsession.approvalLabel
import kotlinx.coroutines.launch

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 16.dp, top = 20.dp, bottom = 4.dp, end = 16.dp))
}

@Composable
private fun SwitchRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.size(12.dp))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onHostSettings: (String) -> Unit) {
    val graph = LocalGraph.current
    val settings = graph.settings
    val activity = rememberFragmentActivity()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    val keep by settings.keepConnected.collectAsState(false)
    val bio by settings.biometricLock.collectAsState(false)
    val defaultApproval by settings.defaultApprovalMode.collectAsState(ApprovalModes.ALWAYS_ASK)
    val hosts by graph.hosts.hosts.collectAsState()
    var approvalDialog by remember { mutableStateOf(false) }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = { TopAppBar(title = { Text("Settings") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            SectionTitle("Connection")
            SwitchRow(
                "Keep connected", "Stay connected to your PCs in the background and notify you about approvals, questions and finished work. Shows a persistent low-priority notification.",
                keep,
            ) { v -> scope.launch { settings.setKeepConnected(v) } }

            SectionTitle("Security")
            SwitchRow(
                "Biometric lock", "Require fingerprint, face or screen lock to open the app and before approving anything.",
                bio,
            ) { v ->
                scope.launch {
                    if (!graph.gate.isAvailable(activity)) {
                        snack.showSnackbar("Set up a screen lock or biometrics in Android settings first")
                        return@launch
                    }
                    // Turning it on (or off) needs a successful authentication so a borrowed unlocked phone can't disable it.
                    if (graph.gate.authenticate(activity, if (v) "Enable biometric lock" else "Disable biometric lock")) settings.setBiometricLock(v)
                }
            }

            val hide by settings.hideInRecents.collectAsState(true)
            SwitchRow(
                "Hide content in recents", "Blank the app in the recent-apps switcher and block screenshots, so approvals and commands are not captured.",
                hide,
            ) { v -> scope.launch { settings.setHideInRecents(v) } }

            SectionTitle("Notifications")
            for (kind in AttentionKinds.all) {
                val on by settings.notifyEnabled(kind).collectAsState(true)
                SwitchRow(
                    when (kind) {
                        AttentionKinds.APPROVAL -> "Approval needed"
                        AttentionKinds.QUESTION -> "Questions"
                        AttentionKinds.DONE -> "Finished"
                        AttentionKinds.ERROR -> "Errors"
                        else -> "Usage limits"
                    },
                    null, on,
                ) { v -> scope.launch { settings.setNotifyEnabled(kind, v) } }
            }

            SectionTitle("New sessions")
            ListItem(
                headlineContent = { Text("Default approval mode") },
                supportingContent = { Text("${approvalLabel(defaultApproval)} — ${approvalHint(defaultApproval)}") },
                modifier = Modifier.clickable { approvalDialog = true },
            )

            SectionTitle("PCs")
            if (hosts.isEmpty()) Text("No PC paired yet.", Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            for (h in hosts) {
                ListItem(
                    headlineContent = { Text(h.name) },
                    supportingContent = { Text("Relays, paired devices") },
                    leadingContent = { Icon(Icons.Filled.Computer, null) },
                    modifier = Modifier.clickable { onHostSettings(h.hostId) },
                )
            }

            SectionTitle("Push")
            val pushAvail = PushTokens.available(graph.app)
            Text(
                if (pushAvail) "Push wake-ups are enabled in this build."
                else "Push wake-ups are not enabled in this build (no google-services.json). Notifications arrive while the app is connected; turn on “Keep connected” for background delivery.",
                Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionTitle("About")
            ListItem(headlineContent = { Text("OMP Remote") }, supportingContent = { Text("Version ${BuildConfig.VERSION_NAME} · protocol 1") })
            Text(
                "All traffic between this phone and your PC is end-to-end encrypted (P-256 ECDH, AES-256-GCM). The relay is blind.",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(32.dp))
        }
    }

    if (approvalDialog) {
        AlertDialog(
            onDismissRequest = { approvalDialog = false },
            title = { Text("Default approval mode") },
            text = {
                Column {
                    for (m in ApprovalModes.all) {
                        Row(Modifier.fillMaxWidth().clickable { scope.launch { settings.setDefaultApprovalMode(m) }; approvalDialog = false }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.material3.RadioButton(selected = defaultApproval == m, onClick = null)
                            Spacer(Modifier.size(12.dp))
                            Column { Text(approvalLabel(m)); Text(approvalHint(m), style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { approvalDialog = false }) { Text("Close") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostSettingsScreen(hostId: String, onBack: () -> Unit) {
    val graph = LocalGraph.current
    val conn = rememberHostConnection(hostId)
    val hosts by graph.hosts.hosts.collectAsState()
    val host = hosts.firstOrNull { it.hostId == hostId }
    val state by conn.state.collectAsState()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var devices by remember { mutableStateOf<List<DeviceEntry>?>(null) }
    var devicesError by remember { mutableStateOf<String?>(null) }
    var revoking by remember { mutableStateOf<DeviceEntry?>(null) }
    var relayEdit by remember { mutableStateOf<Int?>(null) } // index, or -1 = add
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(state is ConnState.Connected, reload) {
        if (state is ConnState.Connected) {
            try {
                devices = conn.devicesList().sortedByDescending { it.current }
                devicesError = null
            } catch (e: Exception) {
                devicesError = e.userMessage()
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = { TopAppBar(title = { Text(host?.name ?: "PC") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state, onRetry = { conn.reconnectNow() })
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                SectionTitle("Relays (tried in this order)")
                val relays = host?.relays.orEmpty()
                relays.forEachIndexed { i, url ->
                    ListItem(
                        headlineContent = { Text(url) },
                        supportingContent = { Text(if (RelayUrls.isLan(url)) "LAN / private address" else "Internet relay") },
                        trailingContent = {
                            IconButton(
                                enabled = relays.size > 1,
                                onClick = { scope.launch { graph.hosts.update(hostId, relays = relays.filterIndexed { j, _ -> j != i }); conn.reconnectNow() } },
                            ) { Icon(Icons.Filled.Delete, "Remove relay $url") }
                        },
                        modifier = Modifier.clickable { relayEdit = i },
                    )
                }
                TextButton(onClick = { relayEdit = -1 }, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Icon(Icons.Filled.Add, null); Spacer(Modifier.size(8.dp)); Text("Add relay")
                }
                state.let { s -> if (s is ConnState.Connected) Text("Connected via ${s.relay}", Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }

                SectionTitle("Paired devices")
                when {
                    devices != null -> for (d in devices!!) {
                        ListItem(
                            headlineContent = { Text(d.label.ifBlank { d.did }) },
                            supportingContent = { Text(if (d.current) "This phone" else "Last seen ${timeAgo(d.lastSeen).ifEmpty { "never" }}") },
                            leadingContent = { Icon(Icons.Filled.Smartphone, null) },
                            trailingContent = {
                                if (!d.current) IconButton(onClick = { revoking = d }) { Icon(Icons.Filled.Delete, "Revoke ${d.label}") }
                            },
                        )
                    }
                    devicesError != null -> Text(devicesError!!, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
                    state is ConnState.Connected -> CircularProgressIndicator(Modifier.padding(16.dp))
                    else -> Text("Connect to see paired devices.", Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    "Revoking a device cuts its access immediately. To revoke this phone, run `ompr revoke` on the PC.",
                    Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                host?.let { h ->
                    SectionTitle("Host")
                    ListItem(headlineContent = { Text("Host id") }, supportingContent = { Text(h.hostId) })
                    conn.info.collectAsState().value?.let { info ->
                        ListItem(headlineContent = { Text("Bridge") }, supportingContent = { Text("v${info.bridgeVersion} · ${info.platform} · omp ${info.ompVersion ?: "not found"}") })
                    }
                }
            }
        }
    }

    revoking?.let { d ->
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text("Revoke ${d.label.ifBlank { d.did }}?") },
            text = { Text("That device can no longer connect to this PC. It has to be paired again.") },
            confirmButton = {
                TextButton(onClick = {
                    revoking = null
                    scope.launch {
                        try {
                            conn.devicesRevoke(d.did)
                            reload++
                        } catch (e: Exception) {
                            snack.showSnackbar(e.userMessage())
                        }
                    }
                }) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { revoking = null }) { Text("Cancel") } },
        )
    }

    relayEdit?.let { idx ->
        val current = host?.relays.orEmpty()
        var value by remember(idx) { mutableStateOf(if (idx >= 0) current[idx] else "wss://") }
        val error = RelayUrls.validate(value)
        AlertDialog(
            onDismissRequest = { relayEdit = null },
            title = { Text(if (idx >= 0) "Edit relay" else "Add relay") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = value, onValueChange = { value = it }, singleLine = true, label = { Text("Relay URL") }, isError = error != null && value.length > 6, modifier = Modifier.fillMaxWidth())
                    if (error != null && value.length > 6) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    else Text("ws://10.0.2.2:7466 for the emulator, wss://… for internet relays.", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(enabled = error == null, onClick = {
                    val v = value.trim()
                    val next = if (idx >= 0) current.toMutableList().also { it[idx] = v } else current + v
                    relayEdit = null
                    scope.launch { graph.hosts.update(hostId, relays = next.distinct()); conn.reconnectNow() }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { relayEdit = null }) { Text("Cancel") } },
        )
    }
}
