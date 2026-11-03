package app.ompr.ui.hosts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairDeniedTest {
    @Test
    fun busyReasonWarnsAboutCompromisedLink() {
        val (msg, compromised) = describeDenied("busy")
        assertTrue(compromised)
        assertTrue(msg.contains("another device", ignoreCase = true))
        assertTrue(msg.contains("compromised"))
    }

    @Test
    fun otherReasonsAreShownVerbatim() {
        val (msg, compromised) = describeDenied("declined on the PC")
        assertEquals("declined on the PC", msg)
        assertFalse(compromised)
    }
}
