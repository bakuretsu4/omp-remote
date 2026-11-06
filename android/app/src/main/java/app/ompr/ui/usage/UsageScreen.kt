package app.ompr.ui.usage

import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.OmprShapes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.ompr.R
import app.ompr.data.UsageAccount
import app.ompr.data.UsageLimit
import app.ompr.data.UsageResult
import app.ompr.net.ConnState
import app.ompr.net.usageGet
import app.ompr.ui.common.CenteredProgress
import app.ompr.ui.common.ConnectionBanner
import app.ompr.ui.common.EmptyState
import app.ompr.ui.common.ErrorState
import app.ompr.ui.common.rememberHostConnection
import app.ompr.ui.common.timeAgo
import app.ompr.ui.common.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private sealed interface UsageLoad {
    data object Loading : UsageLoad
    data class Loaded(val result: UsageResult) : UsageLoad
    data class Failed(val message: String) : UsageLoad
}

/** Per-account quota windows of the PC's omp (`usage.get`). Only reachable when the host lists the "usage" feature. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(hostId: String, onBack: () -> Unit) {
    val conn = rememberHostConnection(hostId)
    val connState by conn.state.collectAsState()
    val scope = rememberCoroutineScope()
    var load by remember { mutableStateOf<UsageLoad>(UsageLoad.Loading) }
    var refreshing by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() } }

    val reload: () -> Unit = {
        scope.launch {
            refreshing = true
            try {
                load = UsageLoad.Loaded(conn.usageGet())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                load = UsageLoad.Failed(e.userMessage())
            } finally {
                refreshing = false
                now = System.currentTimeMillis()
            }
        }
    }
    val connected = connState is ConnState.Connected
    LaunchedEffect(connected) { if (connected) reload() }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = { Text(stringResource(R.string.usage_title)) },
                actions = {
                    IconButton(onClick = reload, enabled = connected && !refreshing) { Icon(Icons.Filled.Refresh, stringResource(R.string.usage_refresh)) }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ConnectionBanner(connState, onRetry = { conn.reconnectNow() })
            PullToRefreshBox(isRefreshing = refreshing && load is UsageLoad.Loaded, onRefresh = reload, modifier = Modifier.fillMaxSize()) {
                when (val l = load) {
                    UsageLoad.Loading -> CenteredProgress(label = stringResource(R.string.usage_loading))
                    is UsageLoad.Failed -> ErrorState(l.message, onRetry = reload)
                    is UsageLoad.Loaded ->
                        if (l.result.accounts.isEmpty()) EmptyState(stringResource(R.string.usage_empty_title), stringResource(R.string.usage_empty_body))
                        else UsageList(l.result, now)
                }
            }
        }
    }
}

@Composable
private fun UsageList(result: UsageResult, now: Long) {
    val groups = groupByProvider(result.accounts)
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(Dimens.screen, Dimens.sm, Dimens.screen, Dimens.xl),
        verticalArrangement = Arrangement.spacedBy(Dimens.cardGap),
    ) {
        for (g in groups) {
            item(key = "h-${g.provider}") {
                Text(g.label, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = Dimens.sm))
            }
            items(g.accounts.size, key = { "a-${g.provider}-$it" }) { i -> AccountCard(g.accounts[i], now) }
        }
        item(key = "updated") {
            Text(
                stringResource(R.string.usage_updated, timeAgo(result.generatedAt, now).ifEmpty { "—" }),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Dimens.xs),
            )
        }
    }
}

@Composable
private fun AccountCard(a: UsageAccount, now: Long) {
    Card(Modifier.fillMaxWidth(), shape = OmprShapes.card, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(Dimens.card), verticalArrangement = Arrangement.spacedBy(Dimens.md)) {
            Column {
                Text(accountTitle(a), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                accountSubtitle(a)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (a.limits.isEmpty()) {
                Text(stringResource(R.string.usage_no_limits), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (l in a.limits) LimitRow(l, now)
        }
    }
}

@Composable
private fun severityColor(s: LimitSeverity): Color = when (s) {
    LimitSeverity.OK -> MaterialTheme.colorScheme.primary
    LimitSeverity.WARNING -> MaterialTheme.colorScheme.tertiary
    LimitSeverity.EXHAUSTED -> MaterialTheme.colorScheme.error
    LimitSeverity.UNKNOWN -> MaterialTheme.colorScheme.outline
}

@Composable
private fun LimitRow(l: UsageLimit, now: Long) {
    val sev = l.severity
    val color = severityColor(sev)
    Column(verticalArrangement = Arrangement.spacedBy(Dimens.xs)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(l.label.ifBlank { l.id }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(usedText(l.usedFraction), style = MaterialTheme.typography.bodyMedium, color = color)
        }
        if (l.usedFraction != null) {
            LinearProgressIndicator(
                progress = { barProgress(l.usedFraction) },
                modifier = Modifier.fillMaxWidth(),
                color = color,
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                l.status.replaceFirstChar { it.titlecase() },
                style = MaterialTheme.typography.labelSmall,
                color = color,
            )
            Text(
                resetsInText(l.resetsAt, now) ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
