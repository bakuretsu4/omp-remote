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

/** model · thinking · context % · cost · tokens/s */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StatusBar(view: SessionView) {
    val st = view.state
    val sum = view.summary
    val model = st.model ?: sum?.model
    val thinking = st.thinkingLevel ?: sum?.thinkingLevel
    val ctx = st.contextUsage?.percent ?: sum?.contextPercent
    val cost = st.costUsd ?: sum?.costUsd
    val tps = st.tokensPerSecond
    val parts = buildList {
        model?.let { add(it.label) }
        if (!thinking.isNullOrEmpty() && thinking != "off") add("think $thinking")
        if (st.fastMode == true) add("fast")
        ctx?.let { add("ctx ${formatPercent(it)}") }
        if (cost != null && cost > 0) add(formatCost(cost))
        if (tps != null && tps > 0 && view.busy) add(String.format(Locale.US, "%.0f tok/s", tps))
        st.contextUsage?.tokens?.let { if (it > 0) add("${formatTokens(it)} tok") }
    }
    if (parts.isEmpty()) return
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), modifier = Modifier.fillMaxWidth()) {
        Column {
            FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 6.dp).semantics { contentDescription = "Session status: " + parts.joinToString(", ") }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (p in parts) Text(p, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (ctx != null && ctx >= 70) {
                LinearProgressIndicator(
                    progress = { (ctx / 100.0).toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                    color = if (ctx >= 85) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
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
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Flag, null, Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
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
                Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
                                Spacer(Modifier.size(8.dp))
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
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SmartToy, null, Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text("Subagents · $active running of ${subs.size}", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, if (open) "Hide subagents" else "Show subagents")
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
    LazyRow(Modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
