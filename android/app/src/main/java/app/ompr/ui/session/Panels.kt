package app.ompr.ui.session

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Reply
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.Cap
import app.ompr.data.SessionView
import app.ompr.data.SubagentInfo
import app.ompr.ui.common.formatCost
import app.ompr.ui.common.formatPercent
import app.ompr.ui.common.formatTokens
import java.util.Locale
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import app.ompr.ui.newsession.approvalLabel
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes

/**
 * model · thinking · approvals · context % · cost · tokens/s as compact chips in one scrolling line. Tapping a chip
 * calls [onOpen] (the session settings sheet, where the model, thinking level and approval mode are changed).
 */
@Composable
fun StatusBar(view: SessionView, onOpen: (() -> Unit)? = null) {
    val st = view.state
    val sum = view.summary
    val model = st.model ?: sum?.model
    val thinking = (st.thinkingLevel ?: sum?.thinkingLevel)?.takeIf { it.isNotEmpty() && it != "off" }
    val approval = st.approvalMode ?: sum?.approvalMode
    val ctx = st.contextUsage?.percent ?: sum?.contextPercent
    val cost = (st.costUsd ?: sum?.costUsd)?.takeIf { it > 0 }
    val tps = st.tokensPerSecond?.takeIf { it > 0 && view.busy }
    val tokens = st.contextUsage?.tokens?.takeIf { it > 0 }
    val fast = st.fastMode == true
    if (model == null && thinking == null && approval == null && ctx == null && cost == null && tps == null && tokens == null && !fast) return
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Dimens.lg, vertical = Dimens.xs),
            horizontalArrangement = Arrangement.spacedBy(Dimens.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            model?.let { InfoChip(it.label, Icons.Filled.AutoAwesome, "Model ${it.label}", onOpen) }
            thinking?.let { InfoChip("Think $it", Icons.Filled.Psychology, "Thinking level $it", onOpen) }
            if (fast) InfoChip("Fast", Icons.Filled.Bolt, "Fast mode on", onOpen)
            approval?.let { InfoChip(approvalLabel(it), Icons.Filled.Security, "Approval mode ${approvalLabel(it)}", onOpen) }
            ctx?.let {
                val (bg, fg) = when {
                    it >= 85 -> scheme.errorContainer to scheme.onErrorContainer
                    it >= 70 -> scheme.tertiaryContainer to scheme.onTertiaryContainer
                    else -> scheme.surfaceContainerHigh to scheme.onSurface
                }
                InfoChip("Context ${formatPercent(it)}", Icons.Filled.DataUsage, "Context ${formatPercent(it)} used", onOpen, bg, fg)
            }
            cost?.let { InfoChip(formatCost(it), null, "Cost ${formatCost(it)}", onOpen) }
            tps?.let { InfoChip(String.format(Locale.US, "%.0f tok/s", it), Icons.Filled.Speed, "${it.toInt()} tokens per second", null) }
            tokens?.let { InfoChip("${formatTokens(it)} tok", null, "${formatTokens(it)} tokens in context", null) }
        }
        if (ctx != null && ctx >= 70) {
            LinearProgressIndicator(
                progress = { (ctx / 100.0).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
                color = if (ctx >= 85) scheme.error else scheme.primary,
            )
        }
    }
}

/** A small pill on a surface container; a tappable chip when [onClick] is set, otherwise a plain label. */
@Composable
private fun InfoChip(
    label: String,
    icon: ImageVector?,
    description: String,
    onClick: (() -> Unit)?,
    container: Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    content: Color = MaterialTheme.colorScheme.onSurface,
) {
    if (onClick != null) {
        AssistChip(
            onClick = onClick,
            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = icon?.let { i -> { Icon(i, null, Modifier.size(AssistChipDefaults.IconSize)) } },
            shape = OmprShapes.chip,
            colors = AssistChipDefaults.assistChipColors(containerColor = container, labelColor = content, leadingIconContentColor = content),
            border = null,
            modifier = Modifier.widthIn(max = 240.dp).semantics { contentDescription = "$description. Opens session settings" },
        )
    } else {
        Surface(color = container, contentColor = content, shape = OmprShapes.chip, modifier = Modifier.semantics { contentDescription = description }) {
            Row(
                Modifier.heightIn(min = 32.dp).padding(horizontal = Dimens.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Dimens.xs + Dimens.xxs),
            ) {
                if (icon != null) Icon(icon, null, Modifier.size(AssistChipDefaults.IconSize))
                Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }
}

/** Collapsible goal + todo list. Hidden when there is neither. */
@Composable
fun TodoGoalPanel(view: SessionView) {
    val phases = view.todos.filter { it.tasks.isNotEmpty() }
    val goal = view.goal
    if (phases.isEmpty() && goal == null) return
    var open by rememberSaveable { mutableStateOf(false) }
    val tasks = phases.flatMap { it.tasks }
    val done = tasks.count { it.status == "completed" }
    val current = tasks.firstOrNull { it.status == "in_progress" }
    Surface(color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = Dimens.lg, vertical = Dimens.sm)) {
            Row(Modifier.fillMaxWidth().heightIn(min = Dimens.touch).clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Flag, null, Modifier.size(18.dp))
                Spacer(Modifier.size(Dimens.sm))
                Column(Modifier.weight(1f)) {
                    Text(
                        goal?.objective ?: current?.content ?: "Tasks",
                        style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    if (tasks.isNotEmpty()) Text("$done of ${tasks.size} tasks done", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Hide tasks" else "Show tasks")
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(top = Dimens.sm), verticalArrangement = Arrangement.spacedBy(Dimens.sm - Dimens.xxs)) {
                    if (goal != null) {
                        Text("Goal (${goal.status}): ${goal.objective}", style = MaterialTheme.typography.bodyMedium)
                        if (goal.tokenBudget != null) {
                            val used = goal.tokensUsed ?: 0
                            Text("${formatTokens(used)} / ${formatTokens(goal.tokenBudget)} tokens", style = MaterialTheme.typography.labelSmall)
                            LinearProgressIndicator(progress = { (used.toFloat() / goal.tokenBudget).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                        }
                    }
                    for (p in phases) {
                        if (p.name.isNotBlank()) Text(p.name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        for (t in p.tasks) {
                            Row(verticalAlignment = Alignment.Top) {
                                val (icon, desc) = when (t.status) {
                                    "completed" -> Icons.Filled.CheckCircle to "done"
                                    "in_progress" -> Icons.Filled.PlayCircle to "in progress"
                                    "abandoned" -> Icons.Filled.Cancel to "abandoned"
                                    else -> Icons.Filled.RadioButtonUnchecked to "pending"
                                }
                                Icon(icon, desc, Modifier.size(18.dp), tint = if (t.status == "completed") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.size(Dimens.sm))
                                Column {
                                    Text(t.content, style = MaterialTheme.typography.bodySmall)
                                    if (!t.blocker.isNullOrBlank()) Text("Blocked: ${t.blocker}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Running subagents with cancel / steer. Hidden when there are none besides the main agent. */
@Composable
fun SubagentPanel(view: SessionView, onCancel: (SubagentInfo) -> Unit, onSteer: (SubagentInfo, String) -> Unit) {
    val subs = view.subagents.filter { it.kind == "sub" }
    if (subs.isEmpty()) return
    var open by rememberSaveable { mutableStateOf(false) }
    var steerTarget by remember { mutableStateOf<SubagentInfo?>(null) }
    val active = subs.count { it.status == "running" || it.status == "pending" }
    val canAct = view.can(Cap.SUBAGENTS)
    Surface(color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.35f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = Dimens.lg, vertical = Dimens.sm)) {
            Row(Modifier.fillMaxWidth().heightIn(min = Dimens.touch).clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SmartToy, null, Modifier.size(18.dp))
                Spacer(Modifier.size(Dimens.sm))
                Text("Subagents · $active running of ${subs.size}", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Hide subagents" else "Show subagents")
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(top = Dimens.sm - Dimens.xxs), verticalArrangement = Arrangement.spacedBy(Dimens.sm)) {
                    for (s in subs) {
                        val live = s.status == "running" || s.status == "pending" || s.status == "idle"
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("${s.name} · ${s.status}", style = MaterialTheme.typography.bodyMedium)
                                val sub = s.currentTool?.let { t -> "using $t" } ?: s.lastIntent ?: s.task
                                if (!sub.isNullOrBlank()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            if (canAct && live) {
                                IconButton(onClick = { steerTarget = s }) { Icon(Icons.Filled.Reply, "Send a message to ${s.name}") }
                                IconButton(onClick = { onCancel(s) }) { Icon(Icons.Filled.Close, "Cancel ${s.name}") }
                            }
                        }
                    }
                }
            }
        }
    }
    steerTarget?.let { s ->
        var text by remember(s.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { steerTarget = null },
            title = { Text("Message to ${s.name}") },
            text = { OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 6) },
            confirmButton = { TextButton(enabled = text.isNotBlank(), onClick = { steerTarget = null; onSteer(s, text.trim()) }) { Text("Send") } },
            dismissButton = { TextButton(onClick = { steerTarget = null }) { Text("Cancel") } },
        )
    }
}

/** Messages waiting to be sent to the agent, with remove (and promote for follow-ups). */
@Composable
fun QueueChips(view: SessionView, onRemove: (String, String) -> Unit, onPromote: (String) -> Unit) {
    val q = view.queue
    if (q.steering.isEmpty() && q.followUp.isEmpty()) return
    val canQueue = view.can(Cap.QUEUE)
    LazyRow(Modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Dimens.md, vertical = Dimens.xs), horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
        items(q.steering.map { "steering" to it } + q.followUp.map { "followUp" to it }) { (kind, msg) ->
            InputChip(
                selected = false,
                onClick = { if (canQueue && kind == "followUp") onPromote(msg) },
                label = { Text(msg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = 2.dp)) },
                leadingIcon = {
                    Icon(if (kind == "steering") Icons.Filled.ArrowUpward else Icons.Filled.Reply, if (kind == "steering") "Steering message" else "Queued follow-up", Modifier.size(16.dp))
                },
                trailingIcon = if (canQueue) {
                    { IconButton(onClick = { onRemove(msg, kind) }, modifier = Modifier.size(20.dp)) { Icon(Icons.Filled.Close, "Remove queued message", Modifier.size(14.dp)) } }
                } else null,
                modifier = Modifier.semantics { contentDescription = (if (kind == "steering") "Steering: " else "Queued: ") + msg },
            )
        }
    }
}
