package app.ompr.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import app.ompr.OmprApp
import app.ompr.R
import app.ompr.net.ConnState
import app.ompr.net.Hold
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/**
 * "Keep connected": a foreground service (type remoteMessaging) that holds the encrypted connection to every paired
 * host so attention events turn into notifications while the app is in the background.
 */
class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val holds = HashMap<String, Hold>()
    private var watcher: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val graph = (application as OmprApp).graph
        val n = graph.notifier.foregroundNotification(getString(R.string.fgs_starting))
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
        watcher = scope.launch {
            graph.awaitReady()
            graph.hosts.hosts.collect { hosts -> syncHolds(graph, hosts.map { it.hostId }) }
        }
        scope.launch {
            graph.awaitReady()
            graph.hosts.hosts.flatMapLatest { hosts ->
                if (hosts.isEmpty()) flowOf(getString(R.string.fgs_no_hosts)) else {
                    val flows = hosts.map { h -> graph.connections.get(h.hostId).state }
                    combine(flows) { states ->
                        val parts = hosts.mapIndexed { i, h ->
                            val st = states[i]
                            when (st) {
                                is ConnState.Connected -> getString(R.string.fgs_connected_to, h.name)
                                is ConnState.Fatal -> getString(R.string.fgs_problem, h.name)
                                is ConnState.Offline -> getString(R.string.fgs_reconnecting, h.name)
                                else -> getString(R.string.fgs_connecting, h.name)
                            }
                        }
                        parts.joinToString(" · ")
                    }
                }
            }.collect { text -> graph.notifier.updateForeground(text) }
        }
    }

    private fun syncHolds(graph: app.ompr.AppGraph, ids: List<String>) {
        synchronized(holds) {
            for (id in ids) if (id !in holds) holds[id] = graph.connections.get(id).acquire()
            val gone = holds.keys.filter { it !in ids }
            for (id in gone) holds.remove(id)?.close()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val graph = (application as OmprApp).graph
            scope.launch {
                graph.settings.setKeepConnected(false)
                stopSelf()
            }
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        synchronized(holds) {
            holds.values.forEach { it.close() }
            holds.clear()
        }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 7001
        const val ACTION_STOP = "app.ompr.action.STOP_SERVICE"

        /** Starts the service; never throws (background-start restrictions are swallowed). */
        fun start(context: Context): Boolean = try {
            ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
            true
        } catch (e: Exception) {
            false
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ConnectionService::class.java))
        }
    }
}
