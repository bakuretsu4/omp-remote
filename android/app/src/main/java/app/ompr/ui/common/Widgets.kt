package app.ompr.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ompr.data.SessionStatus
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import app.ompr.ui.theme.pcColors
import app.ompr.ui.theme.status
import kotlinx.coroutines.delay

/** A PC's name in its own colour (dot + name on a tonal pill). */
@Composable
fun PcTag(name: String, colorIndex: Int, modifier: Modifier = Modifier) {
    val c = pcColors(colorIndex)
    Surface(
        color = c.container,
        contentColor = c.onContainer,
        shape = OmprShapes.chip,
        modifier = modifier.semantics { contentDescription = "PC: $name" },
    ) {
        Row(
            Modifier.padding(horizontal = Dimens.sm + 2.dp, vertical = Dimens.xs - 1.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.size(8.dp).background(c.dot, CircleShape))
            Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The status of a session as a glyph: a spinner while it works, a warm ringed dot while it waits for you, a green dot
 * when idle and a hollow ring when offline.
 */
@Composable
fun StatusIndicator(status: String, pending: Int = 0, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    val s = MaterialTheme.status
    val label = when {
        pending > 0 || status == SessionStatus.WAITING -> "Waiting for you"
        status == SessionStatus.WORKING -> "Working"
        status == SessionStatus.OFFLINE -> "Offline"
        else -> "Idle"
    }
    Box(modifier.size(size).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        when {
            pending > 0 || status == SessionStatus.WAITING -> {
                Box(Modifier.size(size).background(s.waiting, CircleShape))
                Box(Modifier.size(size / 2).background(s.onWaiting, CircleShape))
            }
            status == SessionStatus.WORKING -> CircularProgressIndicator(Modifier.size(size - 4.dp), strokeWidth = 2.5.dp, color = s.onWorking)
            status == SessionStatus.OFFLINE -> Box(Modifier.size(size / 2 + 2.dp).border(BorderStroke(2.dp, s.onOffline), CircleShape))
            else -> Box(Modifier.size(size / 2).background(s.onIdle, CircleShape))
        }
    }
}

/** Small coloured connection dot used on PC chips and cards. */
@Composable
fun ConnectionDot(connected: Boolean, connecting: Boolean, modifier: Modifier = Modifier) {
    val color = when {
        connected -> MaterialTheme.status.onIdle
        connecting -> MaterialTheme.colorScheme.outline
        else -> MaterialTheme.colorScheme.error
    }
    val label = when {
        connected -> "Connected"
        connecting -> "Connecting"
        else -> "Unreachable"
    }
    Box(modifier.size(10.dp).background(color, CircleShape).semantics { contentDescription = label })
}

/** Title above a group of rows. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, count: Int? = null, color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary) {
    Row(modifier.padding(top = Dimens.md, bottom = Dimens.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Dimens.sm)) {
        Text(text, style = MaterialTheme.typography.titleSmall, color = color, modifier = Modifier.semantics { contentDescription = "$text sessions" })
        if (count != null) Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Text in a monospace block with a copy button (tool arguments, commands). The copy icon turns into a check for a
 * moment so the action is acknowledged even where no snackbar is visible (bottom sheets).
 */
@Composable
fun MonoBlock(text: String, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE, scrollable: Boolean = false) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = OmprShapes.block, modifier = modifier) {
        Row(Modifier.padding(start = Dimens.md, top = Dimens.xs, bottom = Dimens.xs), verticalAlignment = Alignment.Top) {
            Text(
                text,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, lineHeight = 18.sp),
                maxLines = maxLines,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(top = Dimens.sm + 2.dp).let { if (scrollable) it.horizontalScroll(rememberScrollState()) else it },
            )
            IconButton(onClick = { clipboard.setText(AnnotatedString(text)); copied = true }) {
                Icon(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, if (copied) "Copied" else "Copy", Modifier.size(18.dp))
            }
        }
    }
}
