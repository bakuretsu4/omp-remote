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
import app.ompr.ui.hosts.HostsScreen
import app.ompr.ui.hosts.PairScreen
import app.ompr.ui.newsession.NewSessionScreen
import app.ompr.ui.session.SessionScreen
import app.ompr.ui.settings.HostSettingsScreen
import app.ompr.ui.settings.SettingsScreen
import kotlinx.coroutines.launch
import java.net.URLEncoder

/** Route arguments are encoded here and decoded exactly once by Navigation itself (never decode again). */
private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

object Routes {
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
        val start = if (hosts.size == 1) Routes.dash(hosts[0].hostId) else Routes.HOSTS
        NavHost(nav, startDestination = start) {
            composable(Routes.HOSTS) {
                HostsScreen(
                    onOpen = { nav.navigate(Routes.dash(it)) },
                    onPair = { nav.navigate(Routes.PAIR) },
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                )
            }
            composable(Routes.PAIR) {
                PairScreen(
                    onPaired = { id ->
                        nav.navigate(Routes.dash(id)) { popUpTo(Routes.HOSTS) { inclusive = false } }
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
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                    onHosts = { nav.navigate(Routes.HOSTS) { popUpTo(Routes.HOSTS) { inclusive = true } } },
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
