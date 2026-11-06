package app.ompr.service

import android.content.Context
import app.ompr.data.SettingsStore
import kotlinx.coroutines.flow.first
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Turns UnifiedPush on and off. The distributor app (ntfy, ...) does the actual delivery; the endpoint URL it hands back
 * arrives later in [UnifiedPushService.onNewEndpoint] and is then registered with each PC by the connection manager.
 */
class UnifiedPushController(
    private val context: Context,
    private val settings: SettingsStore,
    /** Re-register (or unregister) with every connected PC after the endpoint changed. */
    private val onChanged: () -> Unit,
) {
    data class Distributor(val packageName: String, val label: String)

    /** Distributor apps installed on this phone. Empty means the user must install one (for example ntfy) first. */
    fun distributors(): List<Distributor> = UnifiedPush.getDistributors(context).map { Distributor(it, labelOf(it)) }

    private fun labelOf(pkg: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    /** Picks [distributor] and registers with it; the endpoint follows asynchronously. */
    suspend fun enable(distributor: String) {
        UnifiedPush.saveDistributor(context, distributor)
        settings.setUnifiedPushError(null)
        settings.setUnifiedPushEnabled(true)
        UnifiedPush.register(context, messageForDistributor = "OMP Remote")
    }

    suspend fun disable() {
        UnifiedPush.unregister(context)
        settings.setUnifiedPushEnabled(false)
        settings.setUnifiedPushEndpoint(null)
        settings.setUnifiedPushError(null)
        onChanged()
    }

    /** Called at app start: registering again keeps the distributor's record of us current (UnifiedPush recommends it). */
    suspend fun refresh() {
        if (!settings.unifiedPushEnabled.first()) return
        runCatching { UnifiedPush.register(context, messageForDistributor = "OMP Remote") }
    }
}
