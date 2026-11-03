package app.ompr

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.ompr.ui.OmprNav
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.theme.OmprTheme

/** Where an incoming intent wants to go. Consumed once by [OmprNav]. */
sealed interface Deeplink {
    data class Session(val hostId: String, val sid: String) : Deeplink
    data class Pair(val link: String, val autoConfirm: Boolean) : Deeplink
}

class MainActivity : FragmentActivity() {
    private val deeplink = mutableStateOf<Deeplink?>(null)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as OmprApp).graph
        // Secure until the stored setting says otherwise (default ON) so the very first frame is never capturable.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        lifecycleScope.launch {
            graph.settings.hideInRecents.collect { hide ->
                if (hide) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
        handleIntent(intent)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            CompositionLocalProvider(LocalGraph provides graph) {
                OmprTheme {
                    val dl by deeplink
                    OmprNav(deeplink = dl, onDeeplinkConsumed = { deeplink.value = null })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when {
            intent.action == ACTION_OPEN_SESSION -> {
                val h = intent.getStringExtra(EXTRA_HOST_ID)
                val s = intent.getStringExtra(EXTRA_SID)
                if (h != null && s != null) deeplink.value = Deeplink.Session(h, s)
            }
            intent.action == Intent.ACTION_VIEW && intent.data?.scheme == "ompr" && intent.data?.host == "pair" ->
                deeplink.value = Deeplink.Pair(intent.dataString.orEmpty(), autoConfirm = false)
            // Debug builds only: lets automated tests inject a pairing link without scanning a QR code. It still shows the
            // confirmation screen unless `--ez autoconfirm true` is passed.
            BuildConfig.DEBUG && intent.action == ACTION_DEBUG_PAIR ->
                intent.getStringExtra("link")?.let { deeplink.value = Deeplink.Pair(it, intent.getBooleanExtra("autoconfirm", false)) }
        }
    }

    companion object {
        const val ACTION_OPEN_SESSION = "app.ompr.action.OPEN_SESSION"
        const val ACTION_DEBUG_PAIR = "app.ompr.action.PAIR"
        const val EXTRA_HOST_ID = "hostId"
        const val EXTRA_SID = "sid"
    }
}
