package app.ompr.ui.hosts

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import app.ompr.net.PairPhase
import app.ompr.net.PairingDeniedException
import app.ompr.net.PairingLink
import app.ompr.net.RelayException
import app.ompr.ui.common.LocalGraph
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private sealed interface PairUi {
    data object Idle : PairUi

    /** A link was scanned / pasted / opened. Nothing has been sent yet; the user must confirm. */
    data class Confirm(val link: PairingLink) : PairUi

    data class Working(val phase: PairPhase, val host: String) : PairUi
    data class Failed(val message: String, val compromised: Boolean = false) : PairUi
}

/** Turns a bridge `pair-no` reason into what the user should read. */
internal fun describeDenied(reason: String): Pair<String, Boolean> {
    val busy = reason.contains("busy", ignoreCase = true) || reason.contains("another", ignoreCase = true)
    return if (busy) {
        "Another device is pairing right now ($reason). If you didn't expect that, treat this pairing link as compromised: " +
            "cancel it on the PC and run `ompr pair` again." to true
    } else reason to false
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(onPaired: (hostId: String) -> Unit, onBack: () -> Unit) {
    val graph = LocalGraph.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var ui by remember { mutableStateOf<PairUi>(PairUi.Idle) }
    var text by rememberSaveable { mutableStateOf("") }
    var job by remember { mutableStateOf<Job?>(null) }
    var cameraGranted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var scanning by rememberSaveable { mutableStateOf(true) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraGranted = it }

    fun start(link: PairingLink) {
        if (job?.isActive == true) return
        ui = PairUi.Working(PairPhase.Connecting, link.name)
        job = scope.launch {
            try {
                val rec = graph.pairing.pair(link, graph.connections.deviceLabel()) { phase -> ui = PairUi.Working(phase, link.name) }
                onPaired(rec.hostId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: PairingDeniedException) {
                val (msg, compromised) = describeDenied(e.reason)
                ui = PairUi.Failed(msg, compromised)
            } catch (e: RelayException) {
                ui = PairUi.Failed(
                    if (e.bridgeOffline) "The PC is not connected to the relay. Is `ompr run` running?" else "Could not reach the relay: ${e.message}",
                )
            } catch (e: Exception) {
                ui = PairUi.Failed(e.message ?: "Pairing failed")
            }
        }
    }

    /** Scan / paste / deep link all end up here: parse, then ASK. Only the Pair button (or the debug flag) starts pairing. */
    fun offer(raw: String, autoConfirm: Boolean = false) {
        if (job?.isActive == true || ui is PairUi.Confirm) return
        val link = try {
            PairingLink.parse(raw)
        } catch (e: PairingLink.Companion.ParseException) {
            ui = PairUi.Failed(e.message ?: "Invalid link")
            return
        }
        if (graph.hosts.get(link.hostId) != null) {
            ui = PairUi.Failed("This PC is already paired.")
            return
        }
        if (autoConfirm) start(link) else ui = PairUi.Confirm(link)
    }

    val inbox by graph.pairInbox.collectAsState()
    LaunchedEffect(inbox) {
        val i = inbox ?: return@LaunchedEffect
        graph.pairInbox.value = null
        scanning = false
        text = ""
        offer(i.link, i.autoConfirm)
    }
    LaunchedEffect(scanning, cameraGranted) {
        if (scanning && !cameraGranted) permission.launch(Manifest.permission.CAMERA)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair a PC") },
                navigationIcon = { IconButton(onClick = { job?.cancel(); onBack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            val current = ui
            when (current) {
                is PairUi.Confirm -> ConfirmCard(current.link, onPair = { start(current.link) }, onCancel = { ui = PairUi.Idle })
                is PairUi.Working -> WorkingCard(current, onCancel = { job?.cancel(); ui = PairUi.Idle })
                else -> {
                    Text(
                        "On your PC run `ompr pair` and scan the QR code it shows, or paste the ompr:// link.",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    if (scanning && cameraGranted) {
                        Box(Modifier.fillMaxWidth().height(300.dp).clip(RoundedCornerShape(20.dp))) {
                            QrScanner(onResult = { raw -> offer(raw) }, modifier = Modifier.fillMaxSize())
                        }
                    } else if (scanning) {
                        Text("Camera permission is needed to scan the QR code. You can paste the link instead.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedButton(onClick = { permission.launch(Manifest.permission.CAMERA) }) { Text("Allow camera") }
                    } else {
                        OutlinedButton(onClick = { scanning = true }) {
                            Icon(Icons.Filled.QrCodeScanner, null)
                            Spacer(Modifier.size(8.dp))
                            Text("Scan QR code")
                        }
                    }

                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it; if (ui is PairUi.Failed) ui = PairUi.Idle },
                        label = { Text("Pairing link") },
                        placeholder = { Text("ompr://pair?…") },
                        modifier = Modifier.fillMaxWidth().testTag("pair_link"),
                        minLines = 2,
                        maxLines = 5,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Done),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(onClick = {
                            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            val clip = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()
                            if (!clip.isNullOrBlank()) text = clip
                        }) {
                            Icon(Icons.Filled.ContentPaste, null)
                            Spacer(Modifier.size(8.dp))
                            Text("Paste")
                        }
                        Button(onClick = { offer(text) }, enabled = text.isNotBlank(), modifier = Modifier.testTag("pair_go")) { Text("Continue") }
                    }
                }
            }

            (ui as? PairUi.Failed)?.let {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Text(it.message, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodyMedium)
                }
            }

            if (current is PairUi.Idle || current is PairUi.Failed) {
                Text(
                    "Pairing links are valid for 10 minutes and work once. Everything between this phone and your PC is end-to-end encrypted; the relay only forwards bytes it cannot read.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** "Pair with <name>?" with the relay hosts spelled out and any cleartext relay called out. */
@Composable
private fun ConfirmCard(link: PairingLink, onPair: () -> Unit, onCancel: () -> Unit) {
    val hosts = link.relayHosts
    val anyClear = hosts.any { it.cleartext }
    Column(Modifier.testTag("pair_confirm"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Pair with “${link.name}”?", style = MaterialTheme.typography.headlineSmall)
        Text(
            "This lets this phone monitor and control coding agents on that PC, including running commands. Only continue if you started this on your own PC just now.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Connects through", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                for (h in hosts) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (h.cleartext) Icons.Filled.LockOpen else Icons.Filled.VerifiedUser, if (h.cleartext) "unencrypted transport" else "TLS", Modifier.size(18.dp))
                        Spacer(Modifier.size(8.dp))
                        Text(h.host, style = MaterialTheme.typography.bodyLarge, fontFamily = FontFamily.Monospace)
                        if (h.cleartext) Text("  ws:// (no TLS)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                    }
                }
                if (anyClear) {
                    Text(
                        "A ws:// relay has no transport encryption. Traffic is still end-to-end encrypted, but only use it on a network you trust (your LAN).",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f).height(52.dp).testTag("pair_cancel")) { Text("Cancel") }
            Button(onClick = onPair, modifier = Modifier.weight(1f).height(52.dp).testTag("pair_go")) { Text("Pair") }
        }
    }
}

@Composable
private fun WorkingCard(w: PairUi.Working, onCancel: () -> Unit) {
    when (val p = w.phase) {
        PairPhase.Connecting -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            CircularProgressIndicator(Modifier.size(32.dp))
            Text("Connecting to ${w.host}…", style = MaterialTheme.typography.titleMedium)
        }
        is PairPhase.WaitingConfirm -> Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
            modifier = Modifier.fillMaxWidth().testTag("pair_sas"),
        ) {
            Column(Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Check this code on your PC", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onTertiaryContainer)
                Text(
                    p.sas,
                    fontSize = 48.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    modifier = Modifier.semantics { contentDescription = "Pairing code ${p.sas.replace(" ", ", ")}" },
                )
                Text(
                    "It must match the code the PC shows. If the codes differ, or the PC shows none, tap Cancel — someone else may be using your pairing link.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text("Waiting for confirmation on the PC…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onTertiaryContainer)
                }
            }
        }
    }
    OutlinedButton(onClick = onCancel) { Text("Cancel") }
}
