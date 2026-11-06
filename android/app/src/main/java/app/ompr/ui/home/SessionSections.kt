package app.ompr.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.ompr.ui.common.SectionLabel
import app.ompr.ui.theme.Dimens
import app.ompr.ui.theme.status

/** What a section list needs from its screen. */
class SectionActions(
    val now: Long,
    val showPc: Boolean,
    val openingKey: String?,
    val onOpen: (HomeSession) -> Unit,
    val onShowMore: () -> Unit,
)

/** Needs you / Running / Open / Recent (Today, Yesterday, Earlier) as lazy list items. Shared by Home and the PC screen. */
fun LazyListScope.sessionSections(model: HomeModel, a: SectionActions) {
    section("needs", "Needs you", model.needsYou, a, warm = true)
    section("running", "Running", model.running, a)
    section("open", "Open", model.open, a)
    if (model.recent.isNotEmpty()) {
        item(key = "h-recent") { SectionLabel("Recent") }
        for (g in model.recent) {
            item(key = "h-recent-${g.day}") {
                Text(g.day.label(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Dimens.xs))
            }
            items(g.items, key = { "r:" + it.key }) { s -> card(s, a) }
        }
        if (model.recentHidden > 0) {
            item(key = "recent-more") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TextButton(onClick = a.onShowMore) { Text("Show ${model.recentHidden} more") }
                }
            }
        }
    }
}

private fun LazyListScope.section(id: String, title: String, list: List<HomeSession>, a: SectionActions, warm: Boolean = false) {
    if (list.isEmpty()) return
    item(key = "h-$id") {
        SectionLabel(title, count = list.size, color = if (warm) MaterialTheme.status.onWaiting else MaterialTheme.colorScheme.primary)
    }
    items(list, key = { "$id:" + it.key }) { s -> card(s, a) }
}

@androidx.compose.runtime.Composable
private fun card(s: HomeSession, a: SectionActions) {
    SessionCard(s, a.now, a.showPc, busy = a.openingKey == s.key, onClick = { a.onOpen(s) })
}
