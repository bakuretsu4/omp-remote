package app.ompr.ui.session.sheets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.ompr.R
import app.ompr.data.HostRecord
import app.ompr.data.SessionKind
import app.ompr.data.SessionView
import app.ompr.net.ConnectedHandoverHost
import app.ompr.net.HandoverResult
import app.ompr.net.HandoverStep
import app.ompr.net.PcHandover
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.theme.Dimens
import app.ompr.ui.common.userMessage
import kotlinx.coroutines.launch

private sealed interface ContinueUi {
    data object Idle : ContinueUi
    data class Confirm(val dest: HostRecord) : ContinueUi
    data class Running(val dest: HostRecord, val step: HandoverStep) : ContinueUi
    data class Failed(val dest: HostRecord, val step: HandoverStep, val message: String) : ContinueUi
    data class NoSync(val dest: HostRecord) : ContinueUi
}

/**
 * "Continue on <other PC>" for the open session: one button per other paired PC, with a confirm dialog, a progress dialog
 * (Checking / Stopping / Syncing / Opening) and an error dialog that can retry the step that failed. The sequencing lives
 * in [PcHandover]; this only drives it and shows its state.
 */
@Composable
fun ContinueOnOtherPc(view: SessionView, hostId: String, sid: String, actions: SessionSheetActions) {
    val graph = LocalGraph.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val conn = rememberHostConnection(hostId)
    val allHosts by graph.hosts.hosts.collectAsState()
    var ui by remember { mutableStateOf<ContinueUi>(ContinueUi.Idle) }
    val others = allHosts.filter { it.hostId != hostId }
    val summary = view.summary
    if (summary == null || others.isEmpty() || summary.kind == SessionKind.RECENT) return
    val sourceName = allHosts.firstOrNull { it.hostId == hostId }?.name ?: context.getString(R.string.continue_this_pc)
    val sessionFile = summary.sessionFile
    // A terminal session cannot be stopped from the phone, and an unsaved session has no file to carry over.
    val blocker = when {
        summary.kind == SessionKind.TUI -> stringResource(R.string.continue_blocked_tui)
        sessionFile == null -> stringResource(R.string.continue_blocked_no_file)
        else -> null
    }

    fun start(dest: HostRecord, from: HandoverStep) {
        val file = sessionFile ?: return
        ui = ContinueUi.Running(dest, from)
        scope.launch {
            val src = ConnectedHandoverHost(conn, sourceName)
            val dst = ConnectedHandoverHost(graph.connections.get(dest.hostId), dest.name)
            try {
                when (val r = PcHandover(src, dst).run(sid, file, from) { step -> ui = ContinueUi.Running(dest, step) }) {
                    is HandoverResult.Opened -> {
                        if (r.sync?.sessionsMoved == 0) actions.toast(context.getString(R.string.continue_nothing_copied, dest.name))
                        ui = ContinueUi.Idle
                        actions.openOnHost(dest.hostId, r.sid)
                    }
                    is HandoverResult.NoPeerSync -> ui = ContinueUi.NoSync(dest)
                    is HandoverResult.Failed -> ui = ContinueUi.Failed(dest, r.step, r.cause.userMessage())
                }
            } finally {
                src.close()
                dst.close()
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Dimens.xs + Dimens.xxs)) {
        for (h in others) {
            OutlinedButton(onClick = { ui = ContinueUi.Confirm(h) }, enabled = blocker == null && ui is ContinueUi.Idle, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.continue_on, h.name))
            }
        }
        blocker?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }

    when (val s = ui) {
        ContinueUi.Idle -> Unit
        is ContinueUi.Confirm -> AlertDialog(
            onDismissRequest = { ui = ContinueUi.Idle },
            title = { Text(stringResource(R.string.continue_confirm_title, s.dest.name)) },
            text = { Text(stringResource(R.string.continue_confirm_body, sourceName, s.dest.name)) },
            confirmButton = { TextButton(onClick = { start(s.dest, HandoverStep.CHECKING) }) { Text(stringResource(R.string.continue_confirm_action)) } },
            dismissButton = { TextButton(onClick = { ui = ContinueUi.Idle }) { Text(stringResource(R.string.cancel)) } },
        )
        is ContinueUi.Running -> AlertDialog(
            // Not dismissable: leaving halfway would strand the session between the PCs.
            onDismissRequest = {},
            title = { Text(stringResource(R.string.continue_confirm_title, s.dest.name)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(Dimens.md))
                    Text(stepLabel(s.step))
                }
            },
            confirmButton = {},
        )
        is ContinueUi.Failed -> AlertDialog(
            onDismissRequest = { ui = ContinueUi.Idle },
            title = { Text(stringResource(R.string.continue_failed_title, s.dest.name)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                    Text(stringResource(R.string.continue_failed_at, stepNoun(s.step)), style = MaterialTheme.typography.labelLarge)
                    Text(s.message)
                    if (s.step > HandoverStep.STOPPING) Text(stringResource(R.string.continue_failed_stopped, sourceName), style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = { TextButton(onClick = { start(s.dest, s.step) }) { Text(stringResource(R.string.retry)) } },
            dismissButton = { TextButton(onClick = { ui = ContinueUi.Idle }) { Text(stringResource(R.string.continue_close)) } },
        )
        is ContinueUi.NoSync -> AlertDialog(
            onDismissRequest = { ui = ContinueUi.Idle },
            title = { Text(stringResource(R.string.continue_nosync_title)) },
            text = { Text(stringResource(R.string.continue_nosync_body, sourceName, s.dest.name)) },
            confirmButton = { TextButton(onClick = { ui = ContinueUi.Idle }) { Text(stringResource(R.string.continue_close)) } },
        )
    }
}

@Composable
private fun stepLabel(step: HandoverStep): String = stringResource(
    when (step) {
        HandoverStep.CHECKING -> R.string.continue_step_checking
        HandoverStep.STOPPING -> R.string.continue_step_stopping
        HandoverStep.SYNCING -> R.string.continue_step_syncing
        HandoverStep.OPENING -> R.string.continue_step_opening
    },
)

@Composable
private fun stepNoun(step: HandoverStep): String = stringResource(
    when (step) {
        HandoverStep.CHECKING -> R.string.continue_noun_checking
        HandoverStep.STOPPING -> R.string.continue_noun_stopping
        HandoverStep.SYNCING -> R.string.continue_noun_syncing
        HandoverStep.OPENING -> R.string.continue_noun_opening
    },
)
