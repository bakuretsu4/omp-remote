package app.ompr

import android.app.Application
import app.ompr.crypto.KeystoreSecretBox
import app.ompr.crypto.SecretBox
import app.ompr.data.HostRepository
import app.ompr.data.SettingsStore
import app.ompr.net.ConnectionManager
import app.ompr.net.DisabledHostToolHandler
import app.ompr.net.Http
import app.ompr.net.HostToolHandler
import app.ompr.net.Pairing
import app.ompr.security.BiometricGate
import app.ompr.service.Notifier
import app.ompr.service.Presence
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A pairing link handed to the pairing screen by a deep link / debug intent. Never auto-starts unless [autoConfirm]. */
class PairInbox(val link: String, val autoConfirm: Boolean)

/** Manual dependency graph (no DI framework). One instance per process, owned by [OmprApp]. */
class AppGraph(val app: Application, hostTools: HostToolHandler = DisabledHostToolHandler) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val secretBox: SecretBox = KeystoreSecretBox()
    val settings = SettingsStore(app)
    val hosts = HostRepository(app, secretBox)
    val presence = Presence()
    val notifier = Notifier(app, settings, presence)
    val connections = ConnectionManager(app, hosts, settings, notifier, scope, Http.client, hostTools)
    val pairing = Pairing(Http.client, hosts)
    val gate = BiometricGate(settings)

    /** Set by MainActivity, consumed by PairScreen (kept out of the nav route so it is never URL re-encoded). */
    val pairInbox = kotlinx.coroutines.flow.MutableStateFlow<PairInbox?>(null)

    private val ready = CompletableDeferred<Unit>()

    init {
        scope.launch {
            try {
                hosts.load()
                gate.initialise()
            } finally {
                ready.complete(Unit)
            }
        }
    }

    /** Suspends until paired hosts are loaded from disk. */
    suspend fun awaitReady() = ready.await()

    val isReady: Boolean get() = ready.isCompleted
}
