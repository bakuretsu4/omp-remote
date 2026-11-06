package app.ompr.ui.settings

import android.os.Build
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
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
import app.ompr.data.PhoneToolSpec
import app.ompr.data.PhoneTools
import app.ompr.data.ToolMode
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

private val RowMinHeight = 56.dp

/** A titled block of rows on a tonal card. [description] sits between the title and the card. */
@Composable
private fun SettingsSection(title: String, description: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Dimens.screen)) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = Dimens.sm, top = Dimens.xl, bottom = Dimens.sm).semantics { heading() },
        )
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Dimens.sm, end = Dimens.sm, bottom = Dimens.sm),
            )
        }
        Surface(shape = OmprShapes.card, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
            Column(content = content)
        }
    }
}

@Composable
private fun rowColors() = ListItemDefaults.colors(containerColor = Color.Transparent)

@Composable
private fun RowIcon(icon: ImageVector) {
    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String?,
    checked: Boolean,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onChange: (Boolean) -> Unit,
) {
    val alpha = if (enabled) 1f else 0.5f
    Row(
        modifier.fillMaxWidth().heightIn(min = RowMinHeight)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = Dimens.lg, vertical = Dimens.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Box(Modifier.alpha(alpha)) { RowIcon(icon) }
            Spacer(Modifier.size(Dimens.lg))
        }
        Column(Modifier.weight(1f).alpha(alpha)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.size(Dimens.md))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

private fun toolIcon(cap: String): ImageVector = when (cap) {
    "location" -> Icons.Filled.LocationOn
    "clipboard" -> Icons.Filled.ContentPaste
    "notify" -> Icons.Filled.Notifications
    "camera" -> Icons.Filled.PhotoCamera
    else -> Icons.Filled.Smartphone
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolModeRow(spec: PhoneToolSpec, mode: ToolMode, onChange: (ToolMode) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = RowMinHeight).padding(horizontal = Dimens.lg, vertical = Dimens.md)) {
        RowIcon(toolIcon(spec.cap))
        Spacer(Modifier.size(Dimens.lg))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Dimens.xs + Dimens.xxs)) {
            Text(spec.title, style = MaterialTheme.typography.bodyLarge)
            Text(spec.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                for (m in spec.allowedModes) {
                    androidx.compose.material3.FilterChip(
                        selected = mode == m,
                        onClick = { onChange(m) },
                        label = {
                            Text(
                                when (m) {
                                    ToolMode.OFF -> "Off"
                                    ToolMode.ASK -> "Ask each time"
                                    ToolMode.ALLOW -> "Always allow"
                                },
                            )
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun RowDivider() {
    HorizontalDivider(Modifier.padding(horizontal = Dimens.lg), color = MaterialTheme.colorScheme.outlineVariant)
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
    val dynamic by settings.dynamicColor.collectAsState(initial = true)
    val defaultApproval by settings.defaultApprovalMode.collectAsState(ApprovalModes.ALWAYS_ASK)
    val hosts by graph.hosts.hosts.collectAsState()
    var approvalDialog by remember { mutableStateOf(false) }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = { TopAppBar(title = { Text("Settings") }, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            SettingsSection("Appearance") {
                val dynamicSupported = Build.VERSION.SDK_INT >= 31
                SwitchRow(
                    "Dynamic colour (Material You)",
                    if (dynamicSupported) "Use your wallpaper colours on Android 12+. Off uses the built-in palette."
                    else "Needs Android 12 or newer. This phone uses the built-in palette.",
                    dynamicSupported && dynamic,
                    icon = Icons.Filled.Palette,
                    enabled = dynamicSupported,
                    modifier = Modifier.testTag("dynamic_colour_switch"),
                ) { v -> scope.launch { settings.setDynamicColor(v) } }
            }

            SettingsSection("Connection") {
                SwitchRow(
                    "Keep connected", "Stay connected to your PCs in the background and notify you about approvals, questions and finished work. Shows a persistent low-priority notification.",
                    keep, icon = Icons.Filled.Sync,
                ) { v -> scope.launch { settings.setKeepConnected(v) } }
            }

            SettingsSection("Security") {
                SwitchRow(
                    "Biometric lock", "Require fingerprint, face or screen lock to open the app and before approving anything.",
                    bio, icon = Icons.Filled.Fingerprint,
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

                RowDivider()
                val hide by settings.hideInRecents.collectAsState(true)
                SwitchRow(
                    "Hide content in recents", "Blank the app in the recent-apps switcher and block screenshots, so approvals and commands are not captured.",
                    hide, icon = Icons.Filled.VisibilityOff,
                ) { v -> scope.launch { settings.setHideInRecents(v) } }
            }

            SettingsSection("Notifications") {
                AttentionKinds.all.forEachIndexed { i, kind ->
                    if (i > 0) RowDivider()
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
                        icon = when (kind) {
                            AttentionKinds.APPROVAL -> Icons.Filled.Security
                            AttentionKinds.QUESTION -> Icons.Filled.QuestionAnswer
                            AttentionKinds.DONE -> Icons.Filled.CheckCircle
                            AttentionKinds.ERROR -> Icons.Filled.Error
                            else -> Icons.Filled.Speed
                        },
                    ) { v -> scope.launch { settings.setNotifyEnabled(kind, v) } }
                }
            }

            SettingsSection(
                "Phone tools",
                description = "Let an agent use your phone. Every tool is off until you choose, and only sessions you start with “Let the agent use my phone” can call them. " +
                    "“Ask each time” confirms every call. Clipboard reading, location and the camera work only while this app is open; if the agent asks while it is closed you get a notification to tap.",
            ) {
                PhoneTools.all.forEachIndexed { i, spec ->
                    if (i > 0) RowDivider()
                    val mode by settings.hostToolMode(spec.id).collectAsState(ToolMode.OFF)
                    ToolModeRow(spec, mode) { m ->
                        scope.launch {
                            // Making a tool permanent needs the same authentication as the biometric lock, so a borrowed phone cannot grant it.
                            if (m == ToolMode.ALLOW && !graph.gate.guard(activity, "Always allow ${spec.title}")) return@launch
                            settings.setHostToolMode(spec.id, m)
                        }
                    }
                }
            }

            SettingsSection("New sessions") {
                ListItem(
                    headlineContent = { Text("Default approval mode") },
                    supportingContent = { Text("${approvalLabel(defaultApproval)} — ${approvalHint(defaultApproval)}") },
                    leadingContent = { RowIcon(Icons.Filled.Tune) },
                    colors = rowColors(),
                    modifier = Modifier.heightIn(min = RowMinHeight).clickable { approvalDialog = true },
                )
            }

            SettingsSection("PCs") {
                if (hosts.isEmpty()) {
                    ListItem(
                        headlineContent = { Text("No PC paired yet") },
                        supportingContent = { Text("Pair a PC from the home screen to manage its relays and devices here.") },
                        leadingContent = { RowIcon(Icons.Filled.Computer) },
                        colors = rowColors(),
                    )
                }
                hosts.forEachIndexed { i, h ->
                    if (i > 0) RowDivider()
                    ListItem(
                        headlineContent = { Text(h.name) },
                        supportingContent = { Text("Relays, paired devices") },
                        leadingContent = { RowIcon(Icons.Filled.Computer) },
                        colors = rowColors(),
                        modifier = Modifier.heightIn(min = RowMinHeight).clickable { onHostSettings(h.hostId) },
                    )
                }
            }

            SettingsSection("Push wake-ups") {
                val pushAvail = PushTokens.available(graph.app)
                ListItem(
                    headlineContent = { Text(if (pushAvail) "Google push (FCM) is on" else "Google push (FCM) is off in this build") },
                    supportingContent = {
                        Text(
                            if (pushAvail) "Wake-ups arrive through Google's push service."
                            else "This build has no Google push (no google-services.json). Use the option below instead, or turn on “Keep connected” for background delivery.",
                        )
                    },
                    leadingContent = { RowIcon(Icons.Filled.CloudQueue) },
                    colors = rowColors(),
                )
                RowDivider()
                UnifiedPushSection()
            }

            SettingsSection("About") {
                ListItem(
                    headlineContent = { Text("OMP Remote") },
                    supportingContent = { Text("Version ${BuildConfig.VERSION_NAME} · protocol 1") },
                    leadingContent = { RowIcon(Icons.Filled.Info) },
                    colors = rowColors(),
                )
                RowDivider()
                ListItem(
                    headlineContent = { Text("End-to-end encrypted") },
                    supportingContent = { Text("All traffic between this phone and your PC is end-to-end encrypted (P-256 ECDH, AES-256-GCM). The relay is blind.") },
                    leadingContent = { RowIcon(Icons.Filled.Lock) },
                    colors = rowColors(),
                )
            }
            Spacer(Modifier.size(Dimens.xxl))
        }
    }

    if (approvalDialog) {
        AlertDialog(
            onDismissRequest = { approvalDialog = false },
            title = { Text("Default approval mode") },
            text = {
                Column {
                    for (m in ApprovalModes.all) {
                        Row(Modifier.fillMaxWidth().heightIn(min = Dimens.touch).clickable { scope.launch { settings.setDefaultApprovalMode(m) }; approvalDialog = false }.padding(vertical = Dimens.sm), verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.material3.RadioButton(selected = defaultApproval == m, onClick = null)
                            Spacer(Modifier.size(Dimens.md))
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
                SettingsSection("Relays (tried in this order)") {
                    val relays = host?.relays.orEmpty()
                    relays.forEachIndexed { i, url ->
                        if (i > 0) RowDivider()
                        ListItem(
                            headlineContent = { Text(url) },
                            supportingContent = { Text(if (RelayUrls.isLan(url)) "LAN / private address" else "Internet relay") },
                            leadingContent = { RowIcon(if (RelayUrls.isLan(url)) Icons.Filled.Wifi else Icons.Filled.Cloud) },
                            trailingContent = {
                                IconButton(
                                    enabled = relays.size > 1,
                                    onClick = { scope.launch { graph.hosts.update(hostId, relays = relays.filterIndexed { j, _ -> j != i }); conn.reconnectNow() } },
                                ) { Icon(Icons.Filled.Delete, "Remove relay $url") }
                            },
                            colors = rowColors(),
                            modifier = Modifier.heightIn(min = RowMinHeight).clickable { relayEdit = i },
                        )
                    }
                    TextButton(onClick = { relayEdit = -1 }, modifier = Modifier.padding(horizontal = Dimens.sm).heightIn(min = Dimens.touch)) {
                        Icon(Icons.Filled.Add, null); Spacer(Modifier.size(Dimens.sm)); Text("Add relay")
                    }
                    state.let { s -> if (s is ConnState.Connected) Text("Connected via ${s.relay}", Modifier.padding(horizontal = Dimens.lg, vertical = Dimens.sm), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }

                SettingsSection("Paired devices") {
                    when {
                        devices != null && devices!!.isEmpty() -> Text("No paired devices.", Modifier.padding(Dimens.lg), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        devices != null -> devices!!.forEachIndexed { i, d ->
                            if (i > 0) RowDivider()
                            ListItem(
                                headlineContent = { Text(d.label.ifBlank { d.did }) },
                                supportingContent = { Text(if (d.current) "This phone" else "Last seen ${timeAgo(d.lastSeen).ifEmpty { "never" }}") },
                                leadingContent = { RowIcon(Icons.Filled.Smartphone) },
                                trailingContent = {
                                    if (!d.current) IconButton(onClick = { revoking = d }) { Icon(Icons.Filled.Delete, "Revoke ${d.label.ifBlank { d.did }}") }
                                },
                                colors = rowColors(),
                                modifier = Modifier.heightIn(min = RowMinHeight),
                            )
                        }
                        devicesError != null -> Text(devicesError!!, Modifier.padding(Dimens.lg), color = MaterialTheme.colorScheme.error)
                        state is ConnState.Connected -> Row(Modifier.padding(Dimens.lg), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.size(Dimens.md))
                            Text("Loading devices\u2026", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        else -> Text("Connect to see paired devices.", Modifier.padding(Dimens.lg), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(
                        "Revoking a device cuts its access immediately. To revoke this phone, run `ompr revoke` on the PC.",
                        Modifier.padding(Dimens.lg), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                host?.let { h ->
                    SettingsSection("Host") {
                        ListItem(headlineContent = { Text("Host id") }, supportingContent = { Text(h.hostId) }, leadingContent = { RowIcon(Icons.Filled.Computer) }, colors = rowColors())
                        conn.info.collectAsState().value?.let { info ->
                            RowDivider()
                            ListItem(
                                headlineContent = { Text("Bridge") },
                                supportingContent = { Text("v${info.bridgeVersion} · ${info.platform} · omp ${info.ompVersion ?: "not found"}") },
                                leadingContent = { RowIcon(Icons.Filled.Info) },
                                colors = rowColors(),
                            )
                        }
                    }
                    Spacer(Modifier.size(Dimens.xxl))
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
