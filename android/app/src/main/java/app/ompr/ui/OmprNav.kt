package app.ompr.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.ompr.Deeplink
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.LocalGraph
import app.ompr.ui.common.rememberFragmentActivity
import app.ompr.ui.dashboard.DashboardScreen
import app.ompr.ui.home.HomeScreen
import app.ompr.ui.hosts.HostsScreen
import app.ompr.ui.hosts.PairScreen
import app.ompr.ui.newsession.NewSessionScreen
import app.ompr.ui.session.SessionScreen
import app.ompr.ui.settings.HostSettingsScreen
import app.ompr.ui.settings.SettingsScreen
import app.ompr.ui.files.ChangesScreen
import app.ompr.ui.files.FilesScreen
import app.ompr.ui.usage.UsageScreen
import kotlinx.coroutines.launch
import java.net.URLEncoder

/** Route arguments are encoded here and decoded exactly once by Navigation itself (never decode again). */
private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

object Routes {
    const val HOME = "home"
    const val HOSTS = "hosts"
    const val PAIR = "pair"
    const val DASH = "dash/{hostId}"
    fun dash(h: String) = "dash/${enc(h)}"
    const val SESSION = "session/{hostId}/{sid}"
    fun session(h: String, sid: String) = "session/${enc(h)}/${enc(sid)}"
    const val NEW = "new/{hostId}"
    fun new(h: String) = "new/${enc(h)}"
    const val SETTINGS = "settings"
    const val HOST_SETTINGS = "hostsettings/{hostId}"
    fun hostSettings(h: String) = "hostsettings/${enc(h)}"
    const val USAGE = "usage/{hostId}"
    fun usage(h: String) = "usage/${enc(h)}"
    const val FILES = "files/{hostId}/{path}"
    /** Paths may contain spaces: `URLEncoder` writes them as `+`, so use `%20`, which decodes to a space unambiguously. */
    fun files(h: String, path: String) = "files/${enc(h)}/${enc(path).replace("+", "%20")}"
    const val CHANGES = "changes/{hostId}/{path}"
    fun changes(h: String, path: String) = "changes/${enc(h)}/${enc(path).replace("+", "%20")}"
}

@Composable
fun OmprNav(deeplink: Deeplink?, onDeeplinkConsumed: () -> Unit) {
    val graph = LocalGraph.current
    val unlocked by graph.gate.unlocked.collectAsState()
    val hosts by graph.hosts.hosts.collectAsState()
    val activity = rememberFragmentActivity()
    val scope = rememberCoroutineScope()
    val ready by androidx.compose.runtime.produceState(graph.isReady) {
        graph.awaitReady()
        value = true
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (!ready) {
            CenteredProgress()
            return@Surface
        }
        if (!unlocked) {
            LockScreen(onUnlock = { scope.launch { graph.gate.unlock(activity) } })
            return@Surface
        }
        val nav = rememberNavController()
        // Home as soon as a PC is paired; zero PCs keeps the pairing onboarding.
        val start = androidx.compose.runtime.remember { if (hosts.isEmpty()) Routes.HOSTS else Routes.HOME }
        NavHost(nav, startDestination = start) {
            composable(Routes.HOME) {
                HomeScreen(
                    onOpenSession = { h, sid -> nav.navigate(Routes.session(h, sid)) },
                    onNewSession = { h -> nav.navigate(Routes.new(h)) },
                    onHosts = { nav.navigate(Routes.HOSTS) },
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                    onNoHosts = { nav.navigate(Routes.HOSTS) { popUpTo(Routes.HOME) { inclusive = true } } },
                )
            }
            composable(Routes.HOSTS) {
                HostsScreen(
                    onOpen = { nav.navigate(Routes.dash(it)) },
                    onPair = { nav.navigate(Routes.PAIR) },
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                    onBack = if (nav.previousBackStackEntry != null) ({ nav.popBackStack() }) else null,
                )
            }
            composable(Routes.PAIR) {
                PairScreen(
                    onPaired = {
                        // Back to Home (where the new PC's sessions appear); when Home is not on the stack yet (first pairing), replace the PC list with it.
                        if (nav.currentBackStack.value.any { e -> e.destination.route == Routes.HOME }) nav.popBackStack(Routes.HOME, inclusive = false)
                        else nav.navigate(Routes.HOME) { popUpTo(Routes.HOSTS) { inclusive = true } }
                    },
                    onBack = { nav.popBackStack() },
                )
            }
            composable(Routes.DASH, arguments = listOf(navArgument("hostId") { type = NavType.StringType })) { e ->
                val id = e.arguments!!.getString("hostId")!!
                DashboardScreen(
                    hostId = id,
                    onOpenSession = { sid -> nav.navigate(Routes.session(id, sid)) },
                    onNewSession = { nav.navigate(Routes.new(id)) },
                    onHostSettings = { nav.navigate(Routes.hostSettings(id)) },
                    onHome = { if (!nav.popBackStack(Routes.HOME, inclusive = false)) nav.navigate(Routes.HOME) { popUpTo(Routes.HOSTS) { inclusive = true } } },
                    onUsage = { nav.navigate(Routes.usage(id)) },
                )
            }
            composable(
                Routes.SESSION,
                arguments = listOf(
                    navArgument("hostId") { type = NavType.StringType },
                    navArgument("sid") { type = NavType.StringType },
                ),
            ) { e ->
                val h = e.arguments!!.getString("hostId")!!
                val sid = e.arguments!!.getString("sid")!!
                SessionScreen(
                    hostId = h,
                    sid = sid,
                    onBack = { nav.popBackStack() },
                    onSwitchSession = { newSid -> nav.navigate(Routes.session(h, newSid)) { popUpTo(Routes.session(h, sid)) { inclusive = true } } },
                    onOpenOnHost = { otherHost, otherSid -> nav.navigate(Routes.session(otherHost, otherSid)) { popUpTo(Routes.session(h, sid)) { inclusive = true } } },
                    onOpenFiles = { cwd -> nav.navigate(Routes.files(h, cwd)) },
                    onOpenChanges = { cwd -> nav.navigate(Routes.changes(h, cwd)) },
                )
            }
            composable(Routes.NEW, arguments = listOf(navArgument("hostId") { type = NavType.StringType })) { e ->
                val id = e.arguments!!.getString("hostId")!!
                NewSessionScreen(
                    hostId = id,
                    onBack = { nav.popBackStack() },
                    onCreated = { sid -> nav.navigate(Routes.session(id, sid)) { popUpTo(Routes.new(id)) { inclusive = true } } },
                )
            }
            composable(Routes.SETTINGS) { SettingsScreen(onBack = { nav.popBackStack() }, onHostSettings = { nav.navigate(Routes.hostSettings(it)) }) }
            composable(Routes.HOST_SETTINGS, arguments = listOf(navArgument("hostId") { type = NavType.StringType })) { e ->
                HostSettingsScreen(hostId = e.arguments!!.getString("hostId")!!, onBack = { nav.popBackStack() })
            }
            composable(Routes.USAGE, arguments = listOf(navArgument("hostId") { type = NavType.StringType })) { e ->
                UsageScreen(hostId = e.arguments!!.getString("hostId")!!, onBack = { nav.popBackStack() })
            }
            composable(
                Routes.FILES,
                arguments = listOf(navArgument("hostId") { type = NavType.StringType }, navArgument("path") { type = NavType.StringType }),
            ) { e ->
                FilesScreen(hostId = e.arguments!!.getString("hostId")!!, startPath = e.arguments!!.getString("path")!!, onBack = { nav.popBackStack() })
            }
            composable(
                Routes.CHANGES,
                arguments = listOf(navArgument("hostId") { type = NavType.StringType }, navArgument("path") { type = NavType.StringType }),
            ) { e ->
                ChangesScreen(hostId = e.arguments!!.getString("hostId")!!, path = e.arguments!!.getString("path")!!, onBack = { nav.popBackStack() })
            }
        }
        LaunchedEffect(deeplink) {
            when (val d = deeplink) {
                is Deeplink.Session -> {
                    if (graph.hosts.get(d.hostId) != null) nav.navigate(Routes.session(d.hostId, d.sid)) { launchSingleTop = true }
                    onDeeplinkConsumed()
                }
                is Deeplink.Pair -> {
                    graph.pairInbox.value = app.ompr.PairInbox(d.link, d.autoConfirm)
                    nav.navigate(Routes.PAIR) { launchSingleTop = true }
                    onDeeplinkConsumed()
                }
                null -> Unit
            }
        }
    }
}

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Filled.Lock, null, Modifier.padding(bottom = 16.dp))
        Text("OMP Remote is locked", style = MaterialTheme.typography.titleLarge)
        Text(
            "Authenticate to control your sessions.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 8.dp),
        )
        Button(onClick = onUnlock) { Text("Unlock") }
    }
}
