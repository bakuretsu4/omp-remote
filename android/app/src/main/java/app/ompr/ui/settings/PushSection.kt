package app.ompr.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.ompr.service.UnifiedPushController
import app.ompr.ui.common.LocalGraph
import kotlinx.coroutines.launch
import java.net.URI

/** What the settings screen tells the user about UnifiedPush; pure so it can be unit-tested. */
fun unifiedPushStatus(enabled: Boolean, endpoint: String?, error: String?): String = when {
    !enabled -> "Get notified while the app is closed, without Google. Needs a UnifiedPush app such as ntfy on this phone. " +
        "The wake-up carries no session data: it only tells the app to look."
    error != null -> "The push app could not register: " + when (error) {
        "NETWORK" -> "no network. It will try again."
        "ACTION_REQUIRED" -> "open the push app and finish its setup, then turn this off and on."
        "VAPID_REQUIRED" -> "it needs an extra key this app does not send."
        else -> "internal error in the push app."
    }
    endpoint == null -> "Waiting for the push app to answer\u2026"
    else -> "On. Your PCs wake this phone through ${hostOf(endpoint)}."
}

private fun hostOf(endpoint: String): String = runCatching { URI(endpoint).host }.getOrNull() ?: "your push server"

/** Settings block for wake-ups through a UnifiedPush distributor (ntfy and others). */
@Composable
fun UnifiedPushSection() {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val on by graph.settings.unifiedPushEnabled.collectAsState(false)
    val endpoint by graph.settings.unifiedPushEndpoint.collectAsState(null)
    val error by graph.settings.unifiedPushError.collectAsState(null)
    var choices by remember { mutableStateOf<List<UnifiedPushController.Distributor>?>(null) }
    var noneInstalled by remember { mutableStateOf(false) }

    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text("Wake-ups without Google (UnifiedPush)", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(4.dp))
        Text(unifiedPushStatus(on, endpoint, error), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        if (on) {
            OutlinedButton(onClick = { scope.launch { graph.unifiedPush.disable() } }) { Text("Turn off") }
        } else {
            Button(onClick = {
                val found = graph.unifiedPush.distributors()
                when {
                    found.isEmpty() -> noneInstalled = true
                    found.size == 1 -> scope.launch { graph.unifiedPush.enable(found[0].packageName) }
                    else -> choices = found
                }
            }) { Text("Set up") }
        }
    }

    if (noneInstalled) {
        AlertDialog(
            onDismissRequest = { noneInstalled = false },
            title = { Text("No push app found") },
            text = { Text("Install ntfy (Google Play, F-Droid or ntfy.sh/app), open it once, then come back and tap Set up again.") },
            confirmButton = { TextButton(onClick = { noneInstalled = false }) { Text("OK") } },
        )
    }
    choices?.let { list ->
        AlertDialog(
            onDismissRequest = { choices = null },
            title = { Text("Choose a push app") },
            text = {
                Column {
                    for (d in list) {
                        TextButton(onClick = {
                            choices = null
                            scope.launch { graph.unifiedPush.enable(d.packageName) }
                        }) { Text(d.label) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { choices = null }) { Text("Cancel") } },
        )
    }
}
