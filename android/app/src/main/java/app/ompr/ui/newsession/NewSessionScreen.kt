package app.ompr.ui.newsession

import androidx.compose.foundation.layout.width
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import app.ompr.ui.common.PcTag
import app.ompr.ui.common.rememberHostColorIndex
import app.ompr.ui.common.rememberHostName
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.ApprovalModes
import app.ompr.data.CreateSessionArgs
import app.ompr.data.FsEntry
import app.ompr.data.GoalSpec
import app.ompr.data.ModelEntry
import app.ompr.data.ModelId
import app.ompr.data.RefAttachment
import app.ompr.data.ThinkingLevels
import app.ompr.net.createSession
import app.ompr.net.fsList
import app.ompr.net.fsRoots
import app.ompr.net.listModels
import app.ompr.ui.common.AttachmentController
import app.ompr.ui.common.AttachmentMenu
import app.ompr.ui.common.AttachmentStrip
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.ErrorState
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.lastSegment
import app.ompr.ui.common.rememberAttachmentLaunchers
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.userMessage
import kotlinx.coroutines.launch

private sealed interface Browse {
    data object Loading : Browse
    data class Ok(val path: String?, val dirs: List<FsEntry>, val roots: List<String>) : Browse
    data class Err(val message: String) : Browse
}

private val STEP_LABELS = listOf("Folder", "Options")

/** "Step 2 of 2 — Options" with a progress bar, so the user always knows how far along the wizard is. */
@Composable
private fun StepHeader(step: Int, labels: List<String>) {
    val total = labels.size
    val index = step.coerceIn(0, total - 1)
    Column(Modifier.fillMaxWidth().padding(horizontal = Dimens.lg, vertical = Dimens.sm)) {
        Text(
            "Step ${index + 1} of $total \u2014 ${labels[index]}",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.size(Dimens.xs + Dimens.xxs))
        LinearProgressIndicator(
            progress = { (index + 1).toFloat() / total },
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Step ${index + 1} of $total" },
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
        )
    }
}

/** What "Start session" will create, in one card. */
@Composable
private fun SessionSummary(
    hostId: String,
    folder: String,
    model: String,
    thinking: String,
    approval: String,
    prompt: String,
    attachmentCount: Int,
    goal: String,
    hostTools: Boolean,
) {
    Surface(shape = OmprShapes.card, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Dimens.card), verticalArrangement = Arrangement.spacedBy(Dimens.sm)) {
            Text("Ready to start", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            SummaryRow("PC") { PcTag(rememberHostName(hostId), rememberHostColorIndex(hostId)) }
            SummaryRow("Folder") { Text(folder.ifEmpty { "\u2014" }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            SummaryRow("Model") { Text(model, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            SummaryRow("Thinking") { Text(thinking, style = MaterialTheme.typography.bodyMedium) }
            SummaryRow("Approvals") { Text(approval, style = MaterialTheme.typography.bodyMedium) }
            SummaryRow("Phone tools") { Text(if (hostTools) "Agent may use my phone" else "Off", style = MaterialTheme.typography.bodyMedium) }
            if (prompt.isNotEmpty()) SummaryRow("First message") { Text(prompt, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            if (attachmentCount > 0) SummaryRow("Images") { Text("$attachmentCount attached", style = MaterialTheme.typography.bodyMedium) }
            if (goal.isNotEmpty()) SummaryRow("Goal") { Text(goal, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
private fun SummaryRow(label: String, value: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(96.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f)) { value() }
    }
}

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun NewSessionScreen(hostId: String, onBack: () -> Unit, onCreated: (String) -> Unit) {
    val graph = LocalGraph.current
    val conn = rememberHostConnection(hostId)
    val state by conn.state.collectAsState()
    val activity = app.ompr.ui.common.rememberFragmentActivity()
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }

    var step by rememberSaveable { mutableStateOf(0) }
    var cwd by rememberSaveable { mutableStateOf<String?>(null) }
    var model by remember { mutableStateOf<ModelEntry?>(null) }
    var thinking by rememberSaveable { mutableStateOf<String?>(null) }
    var approval by rememberSaveable { mutableStateOf<String?>(null) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var goal by rememberSaveable { mutableStateOf("") }
    var hostTools by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    val hostInfo by conn.info.collectAsState()
    val allowedModes = ApprovalModes.allowedBy(hostInfo)
    val defaultApproval by graph.settings.defaultApprovalMode.collectAsState(ApprovalModes.ALWAYS_ASK)
    // A stored default the PC forbids (for example yolo) falls back to the strictest mode it allows.
    val approvalMode = ApprovalModes.orStrictest(approval ?: defaultApproval, hostInfo)

    val attachments = remember(conn) { AttachmentController(graph.app, graph.scope, conn, null) }
    val launchers = rememberAttachmentLaunchers(attachments)
    var attachMenu by remember { mutableStateOf(false) }

    var browse by remember { mutableStateOf<Browse>(Browse.Loading) }
    var models by remember { mutableStateOf<List<ModelEntry>>(emptyList()) }
    var modelsError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }

    fun load(path: String?) {
        browse = Browse.Loading
        scope.launch {
            browse = try {
                if (path == null) {
                    val roots = conn.fsRoots()
                    if (roots.size == 1) {
                        val r = conn.fsList(roots[0])
                        Browse.Ok(r.path, r.entries.filter { it.dir }.sortedBy { it.name.lowercase() }, roots)
                    } else Browse.Ok(null, emptyList(), roots)
                } else {
                    val r = conn.fsList(path)
                    Browse.Ok(r.path, r.entries.filter { it.dir }.sortedBy { it.name.lowercase() }, conn.fsRoots())
                }
            } catch (e: Exception) {
                Browse.Err(e.userMessage())
            }
        }
    }

    LaunchedEffect(reload) { load(null) }
    LaunchedEffect(reload, step) {
        if (step == 1 && models.isEmpty()) {
            try {
                models = conn.listModels()
                modelsError = null
            } catch (e: Exception) {
                modelsError = e.userMessage()
            }
        }
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                title = { Text(if (step == 0) "Choose a folder" else "New session") },
                navigationIcon = {
                    IconButton(onClick = { if (step == 1) step = 0 else onBack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
            )
        },
        bottomBar = {
            if (step == 0) {
                Column {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().padding(Dimens.md), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Selected", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(cwd ?: "—", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Button(enabled = cwd != null, onClick = { step = 1 }) { Text("Next") }
                    }
                }
            } else {
                Column {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth().padding(Dimens.md), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                        if (creating) CircularProgressIndicator(Modifier.size(24.dp).padding(end = Dimens.sm), strokeWidth = 2.dp)
                        Button(
                            enabled = !creating && !attachments.items.collectAsState().value.any { it.state is app.ompr.ui.common.AttachState.Uploading },
                            onClick = {
                                val dir = cwd ?: return@Button
                                creating = true
                                scope.launch {
                                    try {
                                        if (ApprovalModes.skipsPrompts(approvalMode) && !graph.gate.guard(activity, "Start a session with ${approvalLabel(approvalMode)}")) {
                                            creating = false
                                            snack.showSnackbar("Authentication is required to start without approvals")
                                            return@launch
                                        }
                                        val sid = conn.createSession(
                                            CreateSessionArgs(
                                                cwd = dir,
                                                model = model?.let { ModelId(it.provider, it.id) },
                                                thinkingLevel = thinking,
                                                approvalMode = approvalMode,
                                                prompt = prompt.trim().ifEmpty { null },
                                                attachments = attachments.refs().map { RefAttachment(it) }.ifEmpty { null },
                                                goal = goal.trim().takeIf { it.isNotEmpty() }?.let { GoalSpec(it) },
                                                hostTools = if (hostTools) true else null,
                                            ),
                                        )
                                        onCreated(sid)
                                    } catch (e: Exception) {
                                        creating = false
                                        snack.showSnackbar(e.userMessage())
                                    }
                                }
                            },
                        ) { Text("Start session") }
                    }
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(state, onRetry = { conn.reconnectNow(); reload++ })
            StepHeader(step = step, labels = STEP_LABELS)
            if (step == 0) {
                when (val b = browse) {
                    Browse.Loading -> CenteredProgress()
                    is Browse.Err -> ErrorState(b.message, onRetry = { reload++ })
                    is Browse.Ok -> DirectoryList(b, cwd, onSelect = { cwd = it }, onOpen = { load(it) }, onUp = { p ->
                        val parent = p.trimEnd('/').substringBeforeLast('/', "")
                        if (b.roots.any { it == p.trimEnd('/') || it == p }) load(null) else load(parent.ifEmpty { "/" })
                    })
                }
            } else {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Dimens.lg),
                    verticalArrangement = Arrangement.spacedBy(Dimens.lg),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Folder, null)
                        Spacer(Modifier.size(Dimens.sm))
                        Column(Modifier.weight(1f)) {
                            Text(lastSegment(cwd.orEmpty()), style = MaterialTheme.typography.titleMedium)
                            Text(cwd.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { step = 0 }) { Text("Change") }
                    }

                    ModelPicker(models, modelsError, model, onPick = { model = it; if (thinking != null && it.thinkingLevels?.contains(thinking) == false) thinking = null })

                    val levels = model?.thinkingLevels ?: ThinkingLevels.all
                    Column(verticalArrangement = Arrangement.spacedBy(Dimens.xs + Dimens.xxs)) {
                        Text("Thinking", style = MaterialTheme.typography.labelLarge)
                        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                            FilterChip(selected = thinking == null, onClick = { thinking = null }, label = { Text("Default") })
                            for (l in levels) FilterChip(selected = thinking == l, onClick = { thinking = l }, label = { Text(l) })
                        }
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(Dimens.xs + Dimens.xxs)) {
                        Text("Approvals", style = MaterialTheme.typography.labelLarge)
                        for (m in allowedModes) {
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = approvalMode == m, role = Role.RadioButton, onClick = { approval = m }).padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = approvalMode == m, onClick = null)
                                Spacer(Modifier.size(Dimens.md))
                                Column {
                                    Text(approvalLabel(m), style = MaterialTheme.typography.bodyLarge)
                                    Text(approvalHint(m), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        if (approvalMode == ApprovalModes.YOLO) {
                            Text("Yolo runs every tool without asking. You will not see approval prompts.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                    }

                    OutlinedTextField(
                        value = prompt, onValueChange = { prompt = it },
                        label = { Text("First message (optional)") },
                        modifier = Modifier.fillMaxWidth(), minLines = 3, maxLines = 8,
                    )
                    Box {
                        OutlinedButton(onClick = { attachMenu = true }) {
                            Icon(Icons.Filled.AddPhotoAlternate, null)
                            Spacer(Modifier.size(Dimens.sm))
                            Text("Attach image")
                        }
                        AttachmentMenu(launchers, attachMenu, { attachMenu = false }, allowFiles = false)
                    }
                    AttachmentStrip(attachments)

                    OutlinedTextField(
                        value = goal, onValueChange = { goal = it },
                        label = { Text("Goal (optional)") },
                        supportingText = { Text("The agent keeps working until this objective is met.") },
                        modifier = Modifier.fillMaxWidth(), maxLines = 4,
                    )

                    Row(
                        Modifier.fillMaxWidth().toggleable(value = hostTools, role = Role.Switch, onValueChange = { hostTools = it }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("Let the agent use my phone", style = MaterialTheme.typography.bodyLarge)
                            Text("Location, clipboard, notifications, camera — each tool also needs its own on-device switch.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = hostTools, onCheckedChange = null)
                    }

                    SessionSummary(
                        hostId = hostId,
                        folder = cwd.orEmpty(),
                        model = model?.let { "${it.label} · ${it.provider}" } ?: "Default model",
                        thinking = thinking ?: "Default",
                        approval = approvalLabel(approvalMode),
                        prompt = prompt.trim(),
                        attachmentCount = attachments.items.collectAsState().value.size,
                        goal = goal.trim(),
                        hostTools = hostTools,
                    )
                }
            }
        }
    }
}

@Composable
private fun DirectoryList(b: Browse.Ok, selected: String?, onSelect: (String) -> Unit, onOpen: (String) -> Unit, onUp: (String) -> Unit) {
    if (b.path == null) {
        // Several roots: pick one first.
        LazyColumn(Modifier.fillMaxSize()) {
            item { Text("Allowed folders on the PC", Modifier.padding(16.dp), style = MaterialTheme.typography.labelLarge) }
            items(b.roots, key = { it }) { r ->
                ListItem(
                    headlineContent = { Text(r) },
                    leadingContent = { Icon(Icons.Filled.Folder, null) },
                    modifier = Modifier.clickable { onOpen(r); onSelect(r) },
                )
            }
        }
        return
    }
    val path = b.path
    LaunchedEffect(path) { onSelect(path) }
    LazyColumn(Modifier.fillMaxSize()) {
        item(key = "cur") {
            ListItem(
                headlineContent = { Text(path, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                supportingContent = { Text("Current folder — tap Next to use it") },
                leadingContent = { Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary) },
            )
            HorizontalDivider()
        }
        if (path.trimEnd('/') !in b.roots.map { it.trimEnd('/') }) item(key = "up") {
            ListItem(
                headlineContent = { Text("..") },
                leadingContent = { Icon(Icons.Filled.ArrowUpward, "Parent folder") },
                modifier = Modifier.clickable { onUp(path) },
            )
        }
        if (b.dirs.isEmpty()) item(key = "empty") { Text("No subfolders", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(b.dirs, key = { it.path }) { d ->
            ListItem(
                headlineContent = { Text(d.name) },
                leadingContent = { Icon(Icons.Filled.Folder, null) },
                modifier = Modifier.clickable { onOpen(d.path) },
            )
        }
    }
}

@Composable
private fun ModelPicker(models: List<ModelEntry>, error: String?, selected: ModelEntry?, onPick: (ModelEntry) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Model", style = MaterialTheme.typography.labelLarge)
        OutlinedButton(onClick = { open = true }, enabled = models.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
            Text(selected?.let { "${it.label} · ${it.provider}" } ?: if (models.isEmpty() && error == null) "Loading…" else "Default model", maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (error != null) Text("Could not load models: $error", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    if (open) ModelPickerDialog(models, selected, onPick = { open = false; onPick(it) }, onDismiss = { open = false })
}

fun approvalLabel(m: String) = when (m) {
    ApprovalModes.ALWAYS_ASK -> "Always ask"
    ApprovalModes.ALWAYS_ASK_CACHED -> "Ask, remember per session"
    ApprovalModes.WRITE -> "Ask for writes only"
    ApprovalModes.YOLO -> "Yolo (never ask)"
    else -> m
}

fun approvalHint(m: String) = when (m) {
    ApprovalModes.ALWAYS_ASK -> "Every tool call needs your approval."
    ApprovalModes.ALWAYS_ASK_CACHED -> "Ask once per tool, then allow it for the session."
    ApprovalModes.WRITE -> "Reads run freely; edits and commands ask."
    ApprovalModes.YOLO -> "Everything runs immediately."
    else -> ""
}

/** Searchable model list. Entries that share a display name are told apart by their id. */
@Composable
fun ModelPickerDialog(models: List<ModelEntry>, selected: ModelEntry?, onPick: (ModelEntry) -> Unit, onDismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val q = query.trim().lowercase()
    val shown = remember(models, q) {
        models.filter { q.isEmpty() || it.label.lowercase().contains(q) || it.id.lowercase().contains(q) || it.provider.lowercase().contains(q) }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose a model") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, singleLine = true, label = { Text("Search") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.weight(1f, fill = false).padding(top = 8.dp)) {
                    items(shown, key = { it.provider + "/" + it.id }) { m ->
                        val isSel = selected?.id == m.id && selected.provider == m.provider
                        ListItem(
                            headlineContent = { Text(m.label) },
                            supportingContent = { Text(m.provider + " · " + m.id, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingContent = { if (isSel) Icon(Icons.Filled.Check, "Selected") },
                            modifier = Modifier.clickable { onPick(m) },
                        )
                    }
                    if (shown.isEmpty()) item { Text("No match", Modifier.padding(16.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
