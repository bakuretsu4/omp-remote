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

import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.graphics.Color
import app.ompr.ui.theme.Dimens

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
    val scheme = MaterialTheme.colorScheme
    if (!canPrompt || view.closed) {
        Surface(color = scheme.surfaceContainerHigh, shape = ComposerShape, modifier = Modifier.fillMaxWidth()) {
            Text(
                when {
                    view.closed -> "This session has ended."
                    else -> "Read-only: this session does not accept messages from the phone."
                },
                Modifier.padding(Dimens.lg), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant,
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

    Surface(color = scheme.surfaceContainerHigh, shape = ComposerShape, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(top = Dimens.sm, bottom = Dimens.xs)) {
            AttachmentStrip(attachments)
            if (busy && canAbort) {
                Button(
                    onClick = onInterrupt,
                    enabled = !interrupting,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = scheme.errorContainer, contentColor = scheme.onErrorContainer,
                        disabledContainerColor = scheme.errorContainer.copy(alpha = 0.5f), disabledContentColor = scheme.onErrorContainer.copy(alpha = 0.6f),
                    ),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Dimens.md, vertical = Dimens.xs).heightIn(min = Dimens.touch).testTag("interrupt"),
                ) {
                    if (interrupting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = scheme.onErrorContainer)
                    else Icon(Icons.Filled.Stop, null)
                    Spacer(Modifier.size(Dimens.sm))
                    Text(if (interrupting) "Stopping…" else "Interrupt agent", style = MaterialTheme.typography.titleSmall)
                }
            }
            if (busy && canSteer) {
                Row(Modifier.padding(horizontal = Dimens.md), horizontalArrangement = Arrangement.spacedBy(Dimens.sm), verticalAlignment = Alignment.CenterVertically) {
                    Text("Send as", style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
                    FilterChip(selected = mode == SendMode.STEER, onClick = { onMode(SendMode.STEER) }, label = { Text("Steer now") })
                    FilterChip(selected = mode == SendMode.FOLLOW_UP, onClick = { onMode(SendMode.FOLLOW_UP) }, label = { Text("Queue for after") })
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = Dimens.sm, vertical = Dimens.xs), verticalAlignment = Alignment.Bottom) {
                if (canAttach) {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.Add, "Attach") }
                        AttachmentMenu(launchers, menu, { menu = false }, allowFiles = view.can(Cap.FILES))
                    }
                }
                TextField(
                    value = draft,
                    onValueChange = onDraft,
                    placeholder = { Text(if (busy) "Message the running agent…" else "Message the agent…") },
                    modifier = Modifier.weight(1f).heightIn(min = Dimens.touch).testTag("composer"),
                    shape = FieldShape,
                    maxLines = 6,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = scheme.surfaceContainerLowest,
                        unfocusedContainerColor = scheme.surfaceContainerLowest,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        errorIndicatorColor = Color.Transparent,
                    ),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Default),
                )
                Spacer(Modifier.size(Dimens.sm - Dimens.xxs))
                FilledIconButton(
                    onClick = onSend,
                    enabled = ready,
                    colors = IconButtonDefaults.filledIconButtonColors(
                        disabledContainerColor = scheme.onSurface.copy(alpha = 0.10f),
                        disabledContentColor = scheme.onSurface.copy(alpha = 0.38f),
                    ),
                    modifier = Modifier.size(Dimens.touch).testTag("send"),
                ) {
                    if (sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = scheme.onPrimary)
                    else Icon(Icons.AutoMirrored.Filled.Send, if (busy && mode == SendMode.STEER && canSteer) "Send as steering message" else "Send")
                }
            }
        }
    }
}

private val ComposerShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
private val FieldShape = RoundedCornerShape(24.dp)
