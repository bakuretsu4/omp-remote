package app.ompr.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.ompr.OmprApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Restarts the keep-connected service after reboot / app update when the user enabled it. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        val graph = (context.applicationContext as OmprApp).graph
        CoroutineScope(Dispatchers.Default).launch {
            try {
                if (graph.settings.isKeepConnected()) ConnectionService.start(context.applicationContext)
            } finally {
                pending.finish()
            }
        }
    }
}
