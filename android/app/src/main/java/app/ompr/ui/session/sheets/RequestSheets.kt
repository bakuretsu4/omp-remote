package app.ompr.ui.session.sheets

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.filled.Block
import app.ompr.ui.common.MonoBlock
import app.ompr.ui.common.PcTag
import app.ompr.ui.common.rememberHostColorIndex
import app.ompr.ui.common.rememberHostName
import app.ompr.ui.theme.Dimens
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.data.AskQuestion
import app.ompr.data.UiAnswer
import app.ompr.data.UiRequest
import app.ompr.ui.session.CodeBox

/**
 * Bottom sheet for the oldest pending UI request. Dismissing it (swipe/back) does NOT answer anything: the request
 * stays pending and the screen shows a "waiting for you" bar to reopen it. Nothing is ever auto-approved.
 *
 * [onAnswer] gets the answer and a flag telling whether it authorises the agent to act (needs the biometric gate).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestSheet(
    request: UiRequest,
    hostId: String,
    position: Int,
    total: Int,
    busy: Boolean,
    error: String?,
    onAnswer: (UiAnswer, authorises: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Dimens.xl).padding(bottom = Dimens.xl).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Dimens.lg),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                PcTag(rememberHostName(hostId), rememberHostColorIndex(hostId), Modifier.weight(1f, fill = false))
                if (total > 1) Text("Request $position of $total", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            when (request) {
                is UiRequest.Approval -> ApprovalContent(request, busy, onAnswer)
                is UiRequest.Ask -> AskContent(request, busy, onAnswer)
                is UiRequest.Select -> SelectContent(request, busy, onAnswer)
                is UiRequest.Confirm -> ConfirmContent(request, busy, onAnswer)
                is UiRequest.Input -> TextContent(request.title, request.placeholder, null, request.secret, false, busy, onAnswer)
                is UiRequest.Editor -> TextContent(request.title, null, request.prefill, false, true, busy, onAnswer)
                is UiRequest.Unknown -> {
                    Text("The agent is waiting for an answer this app version cannot show.", style = MaterialTheme.typography.titleMedium)
                    Text("Answer it on the PC, or cancel it here.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { onAnswer(UiAnswer.Cancelled, false) }, enabled = !busy) { Text("Cancel request") }
                }
            }
            if (busy) Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); Spacer(Modifier.size(Dimens.sm)); Text("Sending…") }
            if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// ───────────────────────── approval ─────────────────────────

private fun isDeny(option: String) = option.trim().startsWith("deny", ignoreCase = true)
private fun isSession(option: String) = option.contains("session", ignoreCase = true)

@Composable
private fun ApprovalContent(r: UiRequest.Approval, busy: Boolean, onAnswer: (UiAnswer, Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Security, null, tint = MaterialTheme.colorScheme.tertiary)
        Spacer(Modifier.size(Dimens.md))
        Column {
            Text("Allow tool?", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(r.tool.ifBlank { r.title }, style = MaterialTheme.typography.headlineSmall)
        }
    }
    if (r.detail.isNotBlank()) {
        Column(verticalArrangement = Arrangement.spacedBy(Dimens.xs)) {
            Text("Command / arguments", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // Scrolls inside a bounded height so a long command can still be read in full before approving.
            Box(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
                MonoBlock(r.detail, Modifier.fillMaxWidth(), scrollable = true)
            }
        }
    } else if (r.title.isNotBlank()) {
        Text(r.title, style = MaterialTheme.typography.bodyMedium)
    }
    val options = r.options.ifEmpty { listOf("Approve", "Deny") }
    val approve = options.firstOrNull { !isDeny(it) && !isSession(it) }
    Column(verticalArrangement = Arrangement.spacedBy(Dimens.sm)) {
        for (o in options) {
            val modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)
            when {
                isDeny(o) -> FilledTonalButton(
                    onClick = { onAnswer(UiAnswer.Value(o), false) }, enabled = !busy, modifier = modifier,
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                ) {
                    Icon(Icons.Filled.Block, null, Modifier.size(18.dp))
                    Spacer(Modifier.size(Dimens.sm))
                    Text(o, fontSize = 16.sp)
                }
                o == approve -> Button(onClick = { onAnswer(UiAnswer.Value(o), true) }, enabled = !busy, modifier = modifier) { Text(o, fontSize = 16.sp) }
                else -> FilledTonalButton(onClick = { onAnswer(UiAnswer.Value(o), true) }, enabled = !busy, modifier = modifier) { Text(o, fontSize = 16.sp) }
            }
        }
    }
}

// ───────────────────────── ask ─────────────────────────

@Composable
private fun AskContent(r: UiRequest.Ask, busy: Boolean, onAnswer: (UiAnswer, Boolean) -> Unit) {
    val selected = remember(r.reqId) { mutableStateMapOf<String, Set<String>>() }
    val custom = remember(r.reqId) { mutableStateMapOf<String, String>() }
    fun complete(q: AskQuestion): Boolean = !selected[q.id].isNullOrEmpty() || !custom[q.id].isNullOrBlank()
    Text(if (r.questions.size == 1) "The agent has a question" else "The agent has ${r.questions.size} questions", style = MaterialTheme.typography.headlineSmall)
    for ((qi, q) in r.questions.withIndex()) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!q.header.isNullOrBlank()) Text(q.header, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(q.question, style = MaterialTheme.typography.titleMedium)
            val chosen = selected[q.id].orEmpty()
            q.options.forEachIndexed { oi, o ->
                val isSel = o.label in chosen
                Row(
                    Modifier.fillMaxWidth().selectable(
                        selected = isSel, role = if (q.multi) Role.Checkbox else Role.RadioButton,
                        onClick = {
                            selected[q.id] = if (q.multi) (if (isSel) chosen - o.label else chosen + o.label) else setOf(o.label)
                            if (!q.multi) custom[q.id] = ""
                        },
                    ).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    if (q.multi) Checkbox(isSel, onCheckedChange = null) else RadioButton(isSel, onClick = null)
                    Spacer(Modifier.size(10.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(o.label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f, fill = false))
                            if (q.recommended == oi) {
                                Spacer(Modifier.size(8.dp))
                                Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
                                    Text("Recommended", Modifier.padding(horizontal = 6.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                        if (!o.description.isNullOrBlank()) Text(o.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (isSel && !o.preview.isNullOrBlank()) {
                            Spacer(Modifier.size(6.dp))
                            CodeBox(o.preview, maxHeight = 200)
                        }
                    }
                }
            }
            OutlinedTextField(
                value = custom[q.id].orEmpty(),
                onValueChange = { custom[q.id] = it; if (it.isNotBlank() && !q.multi) selected[q.id] = emptySet() },
                label = { Text("Other (type your own answer)") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 4,
            )
        }
        if (qi < r.questions.lastIndex) HorizontalDivider(Modifier.padding(vertical = 4.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { onAnswer(UiAnswer.Cancelled, false) }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Skip") }
        Button(
            enabled = !busy && r.questions.all { complete(it) },
            onClick = {
                onAnswer(
                    UiAnswer.Answers(
                        r.questions.map { q ->
                            UiAnswer.AskAnswer(
                                q.id,
                                // keep the options in question order
                                q.options.map { it.label }.filter { it in selected[q.id].orEmpty() },
                                custom[q.id]?.trim()?.takeIf { it.isNotEmpty() },
                            )
                        },
                    ),
                    false,
                )
            },
            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
        ) { Text("Send answer") }
    }
}

// ───────────────────────── select / confirm / text ─────────────────────────

@Composable
private fun SelectContent(r: UiRequest.Select, busy: Boolean, onAnswer: (UiAnswer, Boolean) -> Unit) {
    Text(r.title, style = MaterialTheme.typography.headlineSmall)
    Column {
        for (o in r.options) {
            Column(Modifier.fillMaxWidth().clickable(enabled = !busy) { onAnswer(UiAnswer.Value(o.label), false) }.padding(vertical = 12.dp)) {
                Text(o.label, style = MaterialTheme.typography.bodyLarge)
                if (!o.description.isNullOrBlank()) Text(o.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider()
        }
    }
    TextButton(onClick = { onAnswer(UiAnswer.Cancelled, false) }, enabled = !busy) { Text("Cancel") }
}

@Composable
private fun ConfirmContent(r: UiRequest.Confirm, busy: Boolean, onAnswer: (UiAnswer, Boolean) -> Unit) {
    Text(r.title, style = MaterialTheme.typography.headlineSmall)
    if (!r.message.isNullOrBlank()) Text(r.message, style = MaterialTheme.typography.bodyLarge)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { onAnswer(UiAnswer.Confirmed(false), false) }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("No") }
        Button(onClick = { onAnswer(UiAnswer.Confirmed(true), false) }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Yes") }
    }
}

@Composable
private fun TextContent(
    title: String, placeholder: String?, prefill: String?, secret: Boolean, multiline: Boolean, busy: Boolean,
    onAnswer: (UiAnswer, Boolean) -> Unit,
) {
    var text by rememberSaveable(title, prefill) { mutableStateOf(prefill.orEmpty()) }
    Text(title, style = MaterialTheme.typography.headlineSmall)
    OutlinedTextField(
        value = text, onValueChange = { text = it },
        placeholder = placeholder?.let { { Text(it) } },
        modifier = Modifier.fillMaxWidth(),
        minLines = if (multiline) 6 else 1,
        maxLines = if (multiline) 16 else 3,
        textStyle = if (multiline) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { onAnswer(UiAnswer.Cancelled, false) }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Cancel") }
        Button(onClick = { onAnswer(UiAnswer.Value(text), false) }, enabled = !busy, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Submit") }
    }
}
