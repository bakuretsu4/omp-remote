package app.ompr.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.data.Cap
import app.ompr.data.SessionView
import app.ompr.ui.common.AttachmentController
import app.ompr.ui.common.AttachmentLaunchers
import app.ompr.ui.common.AttachmentMenu
import app.ompr.ui.common.AttachmentStrip

enum class SendMode { STEER, FOLLOW_UP }

/**
 * Sticky bottom composer: attachments, steer/queue choice while the agent is busy, a large interrupt button,
 * the text field and send. Controls the session's caps do not allow are not shown.
 */
@Composable
fun Composer(
    view: SessionView,
    draft: String,
    onDraft: (String) -> Unit,
    attachments: AttachmentController,
    launchers: AttachmentLaunchers,
    mode: SendMode,
    onMode: (SendMode) -> Unit,
    sending: Boolean,
    interrupting: Boolean,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
) {
    val canPrompt = view.can(Cap.PROMPT)
    if (!canPrompt || view.closed) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Text(
                when {
                    view.closed -> "This session has ended."
                    else -> "Read-only: this session does not accept messages from the phone."
                },
                Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    val busy = view.busy
    val canSteer = view.can(Cap.STEER)
    val canAbort = view.can(Cap.ABORT)
    val canAttach = view.can(Cap.IMAGES) || view.can(Cap.FILES)
    var menu by remember { mutableStateOf(false) }
    val attachmentItems by attachments.items.collectAsState()
    val uploading = attachmentItems.any { it.state is app.ompr.ui.common.AttachState.Uploading }
    val ready = (draft.isNotBlank() || attachments.refs().isNotEmpty()) && !uploading && !sending

    Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(bottom = 4.dp)) {
            AttachmentStrip(attachments)
            if (busy && canAbort) {
                Button(
                    onClick = onInterrupt,
                    enabled = !interrupting,
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).heightIn(min = 56.dp).testTag("interrupt"),
                ) {
                    if (interrupting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onError)
                    else Icon(Icons.Filled.Stop, null)
                    Spacer(Modifier.size(8.dp))
                    Text(if (interrupting) "Stopping…" else "Interrupt agent", fontSize = 17.sp)
                }
            }
            if (busy && canSteer) {
                Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Send as", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FilterChip(selected = mode == SendMode.STEER, onClick = { onMode(SendMode.STEER) }, label = { Text("Steer now") })
                    FilterChip(selected = mode == SendMode.FOLLOW_UP, onClick = { onMode(SendMode.FOLLOW_UP) }, label = { Text("Queue for after") })
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                if (canAttach) {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.Add, "Attach") }
                        AttachmentMenu(launchers, menu, { menu = false }, allowFiles = view.can(Cap.FILES))
                    }
                }
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraft,
                    placeholder = { Text(if (busy) "Message the running agent…" else "Message the agent…") },
                    modifier = Modifier.weight(1f).testTag("composer"),
                    shape = RoundedCornerShape(24.dp),
                    maxLines = 6,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Default),
                )
                Spacer(Modifier.size(6.dp))
                FilledIconButton(onClick = onSend, enabled = ready, modifier = Modifier.size(48.dp).testTag("send")) {
                    if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
        }
    }
}
