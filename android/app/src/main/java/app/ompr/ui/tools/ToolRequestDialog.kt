package app.ompr.ui.tools

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import app.ompr.data.PhoneTools
import app.ompr.ui.common.LocalGraph
import kotlinx.coroutines.launch

/**
 * "Allow the agent to …?" for phone tools set to Ask. Shown over whatever screen is open. Denying (or dismissing) never needs
 * authentication; allowing goes through the biometric lock when that is switched on.
 */
@Composable
fun ToolRequestDialog(activity: FragmentActivity) {
    val graph = LocalGraph.current
    val requests by graph.toolRuntime.requests.collectAsState()
    val req = requests.firstOrNull { !it.decision.isCompleted } ?: return
    val scope = rememberCoroutineScope()
    var busy by remember(req.id) { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = { req.decision.complete(false) },
        title = { Text("Allow the agent to ${req.tool.action}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(req.detail)
                Text(
                    "Requested by an agent running on ${req.hostName}. Only allow it if you started that session.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            Button(
                enabled = !busy,
                onClick = {
                    busy = true
                    scope.launch { req.decision.complete(graph.gate.guard(activity, "Allow the agent to ${req.tool.action}")) }
                },
            ) { Text(if (req.tool.id == PhoneTools.CAMERA) "Open camera" else "Allow once") }
        },
        dismissButton = { TextButton(onClick = { req.decision.complete(false) }) { Text("Deny") } },
    )
}
