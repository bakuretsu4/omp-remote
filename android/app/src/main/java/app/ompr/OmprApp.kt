package app.ompr

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.ompr.service.ConnectionService
import app.ompr.service.PushTokens
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class OmprApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)

        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                graph.presence.appVisible = true
                graph.scope.launch { graph.gate.onAppStarted() }
            }

            override fun onStop(owner: LifecycleOwner) {
                graph.presence.appVisible = false
                graph.gate.onAppStopped()
            }
        })

        // The "Keep connected" setting drives the foreground service.
        graph.scope.launch {
            graph.awaitReady()
            graph.settings.keepConnected.distinctUntilChanged().collect { on ->
                if (on) ConnectionService.start(this@OmprApp) else ConnectionService.stop(this@OmprApp)
            }
        }
        // Make sure the FCM token is known (no-op without google-services.json).
        graph.scope.launch {
            val t = PushTokens.fetch(this@OmprApp)
            if (t != null) {
                graph.settings.setFcmToken(t)
                graph.connections.onPushTokenChanged()
            }
        }
        // UnifiedPush asks apps to register again from time to time so the distributor still knows them (no-op when off).
        graph.scope.launch {
            graph.awaitReady()
            graph.unifiedPush.refresh()
        }
    }
}
