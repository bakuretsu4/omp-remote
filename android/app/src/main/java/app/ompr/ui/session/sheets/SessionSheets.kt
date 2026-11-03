package app.ompr.ui.session.sheets

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.ApprovalModes
import app.ompr.data.Cap
import app.ompr.data.ModelEntry
import app.ompr.data.SessionKind
import app.ompr.data.SessionView
import app.ompr.data.ThinkingLevels
import app.ompr.net.SessionHandle
import app.ompr.net.listModels
import app.ompr.ui.common.userMessage
import app.ompr.ui.newsession.approvalHint
import app.ompr.ui.newsession.approvalLabel
import kotlinx.coroutines.launch

/** What the sheet wants the screen to do beyond calling the handle (navigation). */
interface SessionSheetActions {
    fun switchSession(sid: String)
    fun leave()
    fun toast(msg: String)
}

/**
 * Overflow sheet. Every control is gated on the session's `caps` (docs/PROTOCOL.md §6.1): nothing is shown that the
 * bridge did not advertise for this session.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SessionSettingsSheet(view: SessionView, handle: SessionHandle, actions: SessionSheetActions, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val graph = app.ompr.ui.common.LocalGraph.current
    val activity = app.ompr.ui.common.rememberFragmentActivity()
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<ModelEntry>>(emptyList()) }
    var modelMenu by remember { mutableStateOf(false) }
    var goalDialog by remember { mutableStateOf(false) }
    var renameDialog by remember { mutableStateOf(false) }
    var confirmStop by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (view.can(Cap.MODEL)) runCatching { models = handle.conn.listModels(handle.sid) }
    }

    fun run(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            try {
                block()
            } catch (e: Exception) {
                actions.toast(e.userMessage())
            } finally {
                busy = false
            }
        }
    }

    val st = view.state
    val sum = view.summary
    val model = st.model ?: sum?.model
    val thinking = st.thinkingLevel ?: sum?.thinkingLevel
    val approval = st.approvalMode ?: sum?.approvalMode

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Session", style = MaterialTheme.typography.titleLarge)

            if (view.can(Cap.MODEL)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Model", style = MaterialTheme.typography.labelLarge)
                    OutlinedButton(onClick = { modelMenu = true }, enabled = !busy && models.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
                        Text(model?.label ?: "Default", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            if (view.can(Cap.THINKING)) {
                val levels = models.firstOrNull { it.id == model?.id && it.provider == model.provider }?.thinkingLevels ?: ThinkingLevels.all
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Thinking", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (l in levels) FilterChip(selected = thinking == l, enabled = !busy, onClick = { run { handle.setThinking(l) } }, label = { Text(l) })
                    }
                }
            }

            if (view.can(Cap.FAST)) {
                Row(
                    Modifier.fillMaxWidth().toggleable(value = st.fastMode == true, enabled = !busy, role = Role.Switch, onValueChange = { v -> run { handle.setFastMode(v) } }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Fast mode", style = MaterialTheme.typography.bodyLarge)
                        Text("Lower latency where the provider supports it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = st.fastMode == true, onCheckedChange = null)
                }
            }

            if (view.can(Cap.APPROVAL_MODE)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Approvals", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (m in ApprovalModes.all) FilterChip(selected = approval == m, enabled = !busy, onClick = {
                            run {
                                if (ApprovalModes.isWeaker(approval, m) && !graph.gate.guard(activity, "Allow ${approvalLabel(m)}")) {
                                    actions.toast("Authentication is required to loosen approvals")
                                    return@run
                                }
                                handle.setApprovalMode(m)
                            }
                        }, label = { Text(approvalLabel(m)) })
                    }
                    approval?.let { Text(approvalHint(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }

            if (view.can(Cap.GOAL)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Goal", style = MaterialTheme.typography.labelLarge)
                    val g = view.goal
                    if (g == null) {
                        OutlinedButton(onClick = { goalDialog = true }, enabled = !busy) { Text("Set a goal…") }
                    } else {
                        Text(g.objective, style = MaterialTheme.typography.bodyMedium)
                        Text("Status: ${g.status}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (g.status.contains("pause", true)) OutlinedButton(onClick = { run { handle.goal("resume") } }, enabled = !busy) { Text("Resume") }
                            else OutlinedButton(onClick = { run { handle.goal("pause") } }, enabled = !busy) { Text("Pause") }
                            OutlinedButton(onClick = { run { handle.goal("drop") } }, enabled = !busy) { Text("Drop") }
                        }
                    }
                }
            }

            HorizontalDivider()

            if (view.can(Cap.COMPACT)) {
                OutlinedButton(onClick = { run { handle.compact(); actions.toast("Compacting context…"); onDismiss() } }, enabled = !busy && !view.compacting, modifier = Modifier.fillMaxWidth()) {
                    Text(if (view.compacting) "Compacting…" else "Compact context")
                }
            }
            if (view.can(Cap.FORK)) {
                OutlinedButton(onClick = { run { val sid = handle.fork(); onDismiss(); actions.switchSession(sid) } }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Fork into a new session") }
            }
            if (sum?.kind == SessionKind.MANAGED) {
                OutlinedButton(onClick = { renameDialog = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Rename") }
                OutlinedButton(onClick = { confirmStop = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Stop session…") }
            }
            if (sum?.kind == SessionKind.TUI) {
                OutlinedButton(
                    onClick = { run { val sid = handle.handover(); onDismiss(); actions.switchSession(sid) } },
                    enabled = !busy, modifier = Modifier.fillMaxWidth(),
                ) { Text("Take over from the terminal") }
                Text("Works once the terminal has released the session.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            sum?.let {
                Text("Folder: ${it.cwd}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

    if (modelMenu) app.ompr.ui.newsession.ModelPickerDialog(
        models, models.firstOrNull { it.id == model?.id && it.provider == model.provider },
        onPick = { modelMenu = false; run { handle.setModel(it.provider, it.id) } }, onDismiss = { modelMenu = false },
    )
    if (goalDialog) {
        var objective by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { goalDialog = false },
            title = { Text("Set a goal") },
            text = { OutlinedTextField(objective, { objective = it }, label = { Text("Objective") }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 6) },
            confirmButton = { TextButton(enabled = objective.isNotBlank(), onClick = { goalDialog = false; run { handle.goal("create", objective.trim()) } }) { Text("Set") } },
            dismissButton = { TextButton(onClick = { goalDialog = false }) { Text("Cancel") } },
        )
    }
    if (renameDialog) {
        var name by remember { mutableStateOf(view.title) }
        AlertDialog(
            onDismissRequest = { renameDialog = false },
            title = { Text("Rename session") },
            text = { OutlinedTextField(name, { name = it }, singleLine = true, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { renameDialog = false; run { handle.rename(name.trim()) } }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { renameDialog = false }) { Text("Cancel") } },
        )
    }
    if (confirmStop) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text("Stop this session?") },
            text = { Text("The agent process on the PC is terminated. You can reopen the session from “Recent”.") },
            confirmButton = { TextButton(onClick = { confirmStop = false; run { handle.stop(); onDismiss(); actions.leave() } }) { Text("Stop") } },
            dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Cancel") } },
        )
    }
}
