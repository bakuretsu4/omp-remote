package app.ompr.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcPaletteTest {
    private val anchors = listOf<Float?>(null) + (0 until 360 step 15).map { it.toFloat() }

    @Test
    fun textOnEveryChipIsReadableInBothThemesForAnyAccent() {
        for (dark in listOf(false, true)) for (accent in anchors) for (i in 0 until PcPalette.size) {
            val c = PcPalette.colors(i, dark, accent)
            val ratio = PcPalette.contrast(c.onContainer, c.container)
            assertTrue("slot $i dark=$dark accent=$accent contrast $ratio", ratio >= 4.5)
        }
    }

    @Test
    fun theDotStandsOutFromTheContainerItSitsOn() {
        for (dark in listOf(false, true)) for (i in 0 until PcPalette.size) {
            val c = PcPalette.colors(i, dark, 250f)
            val ratio = PcPalette.contrast(c.dot, c.container)
            assertTrue("slot $i dark=$dark dot contrast $ratio", ratio >= 3.0)
        }
    }

    @Test
    fun slotsAreVisuallyDistinct() {
        for (dark in listOf(false, true)) {
            val dots = (0 until PcPalette.size).map { PcPalette.colors(it, dark).dot }
            assertEquals(PcPalette.size, dots.toSet().size)
        }
        assertNotEquals(PcPalette.colors(0, false).container, PcPalette.colors(0, true).container)
    }

    @Test
    fun indicesWrapAround() {
        assertEquals(PcPalette.colors(1, false), PcPalette.colors(1 + PcPalette.size, false))
        assertEquals(PcPalette.colors(PcPalette.size - 1, true), PcPalette.colors(-1, true))
    }

    @Test
    fun harmonisationMovesAtMostFifteenDegreesTowardTheAccent() {
        assertEquals(115f, PcPalette.harmonize(100f, 250f), 0.001f)
        assertEquals(85f, PcPalette.harmonize(100f, 10f), 0.001f)
        assertEquals(105f, PcPalette.harmonize(100f, 110f), 0.001f)
        // across the 0/360 seam
        assertEquals(5f, PcPalette.harmonize(350f, 20f), 0.001f) // shorter way is +30 -> +15 -> 365 -> 5
        assertEquals(355f, PcPalette.harmonize(10f, 330f), 0.001f)
        assertEquals(100f, PcPalette.harmonize(100f, 100f), 0.001f)
    }

    @Test
    fun hueOfPrimaryColours() {
        assertEquals(0f, PcPalette.hueOf(0xFFFF0000.toInt()), 0.5f)
        assertEquals(120f, PcPalette.hueOf(0xFF00FF00.toInt()), 0.5f)
        assertEquals(240f, PcPalette.hueOf(0xFF0000FF.toInt()), 0.5f)
        assertEquals(0f, PcPalette.hueOf(0xFF808080.toInt()), 0.5f)
    }

    @Test
    fun contrastMatchesWcagReferenceValues() {
        assertEquals(21.0, PcPalette.contrast(0xFF000000.toInt(), 0xFFFFFFFF.toInt()), 0.01)
        assertEquals(1.0, PcPalette.contrast(0xFF777777.toInt(), 0xFF777777.toInt()), 0.0001)
    }

    @Test
    fun hslConversion() {
        assertEquals(0xFFFF0000.toInt(), PcPalette.hsl(0f, 1f, 0.5f))
        assertEquals(0xFF00FF00.toInt(), PcPalette.hsl(120f, 1f, 0.5f))
        assertEquals(0xFFFFFFFF.toInt(), PcPalette.hsl(200f, 0.4f, 1f))
        assertEquals(0xFF000000.toInt(), PcPalette.hsl(200f, 0.4f, 0f))
    }
}
