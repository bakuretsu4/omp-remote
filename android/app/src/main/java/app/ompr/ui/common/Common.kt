package app.ompr.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.LifecycleStartEffect
import app.ompr.AppGraph
import app.ompr.R
import app.ompr.data.ErrorCodes
import app.ompr.data.SessionStatus
import app.ompr.net.ConnState
import app.ompr.net.HostConnection
import app.ompr.net.OfflineHint
import app.ompr.net.WireException
import app.ompr.ui.theme.status

/** The process-wide graph; provided once in MainActivity. */
val LocalGraph = staticCompositionLocalOf<AppGraph> { error("AppGraph not provided") }

/** Optional per-screen snackbar host so deep components can surface errors. */
val LocalSnack = compositionLocalOf<SnackbarHostState?> { null }

/** The hosting activity (needed for BiometricPrompt). */
@Composable
fun rememberFragmentActivity(): FragmentActivity {
    val ctx = LocalContext.current
    var c = ctx
    while (c is android.content.ContextWrapper) {
        if (c is FragmentActivity) return c
        c = c.baseContext
    }
    error("no FragmentActivity")
}

/**
 * The live connection to [hostId], held open while the screen is at least STARTED (so it never keeps the socket
 * up from the background; the foreground service does that when "Keep connected" is on).
 */
@Composable
fun rememberHostConnection(hostId: String): HostConnection {
    val graph = LocalGraph.current
    val conn = remember(hostId) { graph.connections.get(hostId) }
    LifecycleStartEffect(hostId) {
        val hold = conn.acquire()
        onStopOrDispose { hold.close() }
    }
    return conn
}

/** [rememberHostConnection] for several hosts at once (Home, PC list): every connection is held while STARTED. */
@Composable
fun rememberHostConnections(hostIds: List<String>): List<HostConnection> {
    val graph = LocalGraph.current
    val conns = remember(hostIds) { hostIds.map { graph.connections.get(it) } }
    LifecycleStartEffect(hostIds) {
        val holds = conns.map { it.acquire() }
        onStopOrDispose { holds.forEach { it.close() } }
    }
    return conns
}

/** Human message for any failure coming out of the net layer. */
fun Throwable.userMessage(): String = when (this) {
    is WireException -> when (code) {
        ErrorCodes.DISCONNECTED -> "Not connected to the PC"
        ErrorCodes.TIMEOUT -> "The PC took too long to answer"
        ErrorCodes.UNSUPPORTED -> "Not supported for this session"
        ErrorCodes.BUSY -> message.ifBlank { "Busy — try again" }
        ErrorCodes.READONLY -> "This session is read-only"
        ErrorCodes.SESSION_CLOSED -> "The session has ended"
        ErrorCodes.FORBIDDEN_PATH -> "That folder is outside the allowed roots"
        ErrorCodes.NOT_FOUND -> message.ifBlank { "Not found" }
        else -> message.ifBlank { "Request failed ($code)" }
    }
    else -> message ?: javaClass.simpleName
}

// ───────────────────────── status chip ─────────────────────────

@Composable
fun StatusChip(status: String, modifier: Modifier = Modifier, pending: Int = 0) {
    val s = MaterialTheme.status
    val (bg, fg, label) = when {
        pending > 0 || status == SessionStatus.WAITING -> Triple(s.waiting, s.onWaiting, stringResource(R.string.status_waiting))
        status == SessionStatus.WORKING -> Triple(s.working, s.onWorking, stringResource(R.string.status_working))
        status == SessionStatus.OFFLINE -> Triple(s.offline, s.onOffline, stringResource(R.string.status_offline))
        else -> Triple(s.idle, s.onIdle, stringResource(R.string.status_idle))
    }
    Surface(
        color = bg,
        contentColor = fg,
        shape = RoundedCornerShape(50),
        modifier = modifier.semantics { contentDescription = "Status: $label" },
    ) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.size(8.dp).background(fg, CircleShape))
            Text(label, style = MaterialTheme.typography.labelMedium)
        }
    }
}

// ───────────────────────── connection banner ─────────────────────────

/** Shows nothing when connected; otherwise a strip describing connecting / offline / fatal with a retry action. */
@Composable
fun ConnectionBanner(state: ConnState, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    when (state) {
        is ConnState.Connected, ConnState.Idle -> Unit
        is ConnState.Connecting -> Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = modifier.fillMaxWidth()) {
            Column {
                LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Sync, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.conn_connecting), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        is ConnState.Offline -> Surface(color = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer, modifier = modifier.fillMaxWidth()) {
            Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.CloudOff, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(state.reason, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
            }
        }
        is ConnState.Fatal -> Surface(color = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer, modifier = modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.ErrorOutline, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(state.reason, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

// ───────────────────────── generic states ─────────────────────────

@Composable
fun CenteredProgress(modifier: Modifier = Modifier, label: String? = null) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator()
            if (label != null) Text(label, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun EmptyState(title: String, body: String? = null, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            if (body != null) Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            if (action != null) {
                Spacer(Modifier.height(8.dp))
                action()
            }
        }
    }
}

@Composable
fun ErrorState(message: String, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    EmptyState(
        title = stringResource(R.string.something_went_wrong),
        body = message,
        modifier = modifier,
        action = if (onRetry != null) ({ Button(onClick = onRetry) { Text(stringResource(R.string.retry)) } }) else null,
    )
}

