package app.ompr.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.data.SessionKind
import app.ompr.ui.common.PcTag
import app.ompr.ui.common.StatusIndicator
import app.ompr.ui.common.formatCost
import app.ompr.ui.common.formatPercent
import app.ompr.ui.common.lastSegment
import app.ompr.ui.common.shortPath
import app.ompr.ui.common.timeAgo
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import app.ompr.ui.theme.status

/**
 * One session row, shared by Home and the per-PC screen: status glyph, title (2 lines), what it waits for, project folder
 * and short path, PC tag, relative time. [now] only drives recomposition of the relative time.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionCard(
    item: HomeSession,
    now: Long,
    showPc: Boolean,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
    onClick: () -> Unit,
) {
    val s = item.summary
    val needs = item.bucket == Bucket.NEEDS_YOU
    val st = MaterialTheme.status
    val container = if (needs) st.waiting else MaterialTheme.colorScheme.surfaceContainer
    val onContainer = if (needs) st.onWaiting else MaterialTheme.colorScheme.onSurface
    val muted = if (needs) st.onWaiting.copy(alpha = 0.78f) else MaterialTheme.colorScheme.onSurfaceVariant
    val title = s.title.ifBlank { lastSegment(s.cwd) }
    val project = lastSegment(s.cwd)
    val time = if (busy) "opening…" else timeAgo(s.lastActivity, now)
    Surface(
        onClick = onClick,
        color = container,
        contentColor = onContainer,
        shape = OmprShapes.card,
        modifier = modifier.fillMaxWidth().heightIn(min = Dimens.touch).semantics(mergeDescendants = true) {
            contentDescription = buildString {
                append(title)
                if (showPc) append(", on ${item.hostName}")
                if (item.ask != null) append(", ${item.ask}")
            }
        },
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            if (needs) Box(Modifier.width(4.dp).fillMaxHeight().background(st.onWaiting))
            Row(Modifier.padding(Dimens.card), horizontalArrangement = Arrangement.spacedBy(Dimens.md)) {
                StatusIndicator(s.status, s.pendingUi, Modifier.padding(top = 1.dp), size = 22.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Dimens.xs)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (item.ask != null) {
                        Text(
                            item.ask + if (item.moreAsks > 0) "  (+${item.moreAsks} more)" else "",
                            style = MaterialTheme.typography.labelLarge,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(Dimens.xs + 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(project, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (s.cwd.isNotBlank() && shortPath(s.cwd) != project) {
                            Text(shortPath(s.cwd), style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Dimens.sm), verticalArrangement = Arrangement.spacedBy(Dimens.xs)) {
                        if (showPc) PcTag(item.hostName, item.colorIndex)
                        if (time.isNotEmpty()) Meta(time, muted)
                        if (s.kind == SessionKind.TUI) Meta("terminal", muted)
                        if (s.kind != SessionKind.RECENT) {
                            s.model?.let { Meta(it.label, muted) }
                            if (s.contextPercent != null) Meta("ctx ${formatPercent(s.contextPercent)}", muted)
                            if (s.costUsd != null && s.costUsd > 0) Meta(formatCost(s.costUsd), muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Meta(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}
