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
import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import app.ompr.tools.ToolUiHost
import app.ompr.ui.tools.ToolRequestDialog
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Where an incoming intent wants to go. Consumed once by [OmprNav]. */
sealed interface Deeplink {
    data class Session(val hostId: String, val sid: String) : Deeplink
    data class Pair(val link: String, val autoConfirm: Boolean) : Deeplink
}

class MainActivity : FragmentActivity() {
    private val deeplink = mutableStateOf<Deeplink?>(null)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // ── UI-bound phone tools (permissions, camera). Only one request is ever in flight (PhoneToolHandler serialises them).
    private var permissionResult: CompletableDeferred<Map<String, Boolean>>? = null
    private val permissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { permissionResult?.complete(it) }

    private var photoFile: File? = null
    private var photoFacing: String? = null
    private var photoResult: CompletableDeferred<File?>? = null
    private val photoLauncher = registerForActivityResult(
        object : ActivityResultContracts.TakePicture() {
            override fun createIntent(context: Context, input: Uri): Intent = super.createIntent(context, input).apply {
                // Only a hint: camera apps are free to ignore it.
                when (photoFacing) {
                    "front" -> {
                        putExtra("android.intent.extras.CAMERA_FACING", 1)
                        putExtra("android.intent.extra.USE_FRONT_CAMERA", true)
                    }
                    "back" -> putExtra("android.intent.extras.CAMERA_FACING", 0)
                }
            }
        },
    ) { ok ->
        if (!ok) photoFile?.delete()
        photoResult?.complete(if (ok) photoFile else null)
    }

    private val toolHost = object : ToolUiHost {
        override val activity: androidx.fragment.app.FragmentActivity get() = this@MainActivity

        override suspend fun ensurePermissions(vararg permissions: String): Map<String, Boolean> {
            fun granted(p: String) = ContextCompat.checkSelfPermission(this@MainActivity, p) == PackageManager.PERMISSION_GRANTED
            val missing = permissions.filterNot(::granted)
            if (missing.isEmpty()) return permissions.associateWith { true }
            val result = CompletableDeferred<Map<String, Boolean>>()
            permissionResult = result
            withContext(Dispatchers.Main) { permissionsLauncher.launch(missing.toTypedArray()) }
            val answers = result.await()
            return permissions.associateWith { answers[it] ?: granted(it) }
        }

        override suspend fun takePhoto(facing: String?): File? {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            // Sweep photos left behind by calls that timed out while the camera was open.
            dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 3_600_000 }?.forEach { it.delete() }
            val file = File(dir, "agent_${System.currentTimeMillis()}.jpg")
            photoFile = file
            photoFacing = facing
            val result = CompletableDeferred<File?>()
            photoResult = result
            val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
            withContext(Dispatchers.Main) { photoLauncher.launch(uri) }
            return result.await()
        }
    }

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
                    ToolRequestDialog(activity = this@MainActivity)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        (application as OmprApp).graph.toolRuntime.host.value = toolHost
    }

    override fun onStop() {
        (application as OmprApp).graph.toolRuntime.host.compareAndSet(toolHost, null)
        super.onStop()
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
