package app.ompr.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** The spacing scale. Screens use these instead of ad-hoc numbers so the rhythm stays consistent. */
object Dimens {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp

    /** Horizontal gutter of list screens. */
    val screen = lg

    /** Inner padding of cards. */
    val card = md + xxs

    /** Gap between stacked cards. */
    val cardGap = 10.dp

    /** Bottom padding of lists so the FAB never covers the last row. */
    val fabClearance = 96.dp

    /** Minimum touch target (Material accessibility guideline). */
    val touch = 48.dp
}

/** Shapes beyond the Material slots, so cards, chips and blocks share one vocabulary. */
object OmprShapes {
    val card = RoundedCornerShape(16.dp)
    val block = RoundedCornerShape(12.dp)
    val bubble = RoundedCornerShape(18.dp)
    val chip = CircleShape
}
