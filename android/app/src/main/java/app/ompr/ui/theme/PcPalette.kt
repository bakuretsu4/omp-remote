package app.ompr.ui.theme

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Colours of one PC tag, as ARGB ints (plain Kotlin so the palette can be unit-tested). */
data class PcColors(val dot: Int, val container: Int, val onContainer: Int)

/**
 * A small palette of PC identity colours. Every colour is generated from a hue with fixed lightness per theme, so text on
 * the container is always readable (>= 4.5:1), and each hue is nudged up to 15 degrees toward the scheme's accent hue
 * (the same idea as Material's colour harmonisation) so the tags sit well beside wallpaper-derived colours.
 */
object PcPalette {
    private val hues = floatArrayOf(215f, 25f, 150f, 285f, 180f, 340f, 48f, 95f)
    val size: Int get() = hues.size

    fun colors(index: Int, dark: Boolean, accentHue: Float? = null): PcColors {
        val base = hues[Math.floorMod(index, hues.size)]
        val h = if (accentHue == null) base else harmonize(base, accentHue)
        return if (dark) {
            PcColors(dot = hsl(h, 0.70f, 0.66f), container = hsl(h, 0.32f, 0.24f), onContainer = hsl(h, 0.75f, 0.90f))
        } else {
            PcColors(dot = hsl(h, 0.70f, 0.30f), container = hsl(h, 0.60f, 0.88f), onContainer = hsl(h, 0.70f, 0.16f))
        }
    }

    /** Rotates [hue] toward [anchor] by half the distance, at most 15 degrees. */
    fun harmonize(hue: Float, anchor: Float): Float {
        var diff = (anchor - hue) % 360f
        if (diff > 180f) diff -= 360f
        if (diff < -180f) diff += 360f
        val rot = min(abs(diff) * 0.5f, 15f) * (if (diff < 0) -1f else 1f)
        return ((hue + rot) % 360f + 360f) % 360f
    }

    /** Hue (0..360) of an ARGB colour; 0 for greys. */
    fun hueOf(argb: Int): Float {
        val r = ((argb shr 16) and 0xFF) / 255f
        val g = ((argb shr 8) and 0xFF) / 255f
        val b = (argb and 0xFF) / 255f
        val mx = max(r, max(g, b))
        val mn = min(r, min(g, b))
        val d = mx - mn
        if (d == 0f) return 0f
        val h = when (mx) {
            r -> ((g - b) / d) % 6f
            g -> (b - r) / d + 2f
            else -> (r - g) / d + 4f
        } * 60f
        return (h + 360f) % 360f
    }

    /** WCAG contrast ratio between two opaque ARGB colours. */
    fun contrast(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun luminance(argb: Int): Double {
        fun lin(c: Int): Double {
            val s = c / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * lin((argb shr 16) and 0xFF) + 0.7152 * lin((argb shr 8) and 0xFF) + 0.0722 * lin(argb and 0xFF)
    }

    /** HSL (h in degrees, s and l in 0..1) to opaque ARGB. */
    fun hsl(h: Float, s: Float, l: Float): Int {
        val c = (1f - abs(2f * l - 1f)) * s
        val x = c * (1f - abs((h / 60f) % 2f - 1f))
        val m = l - c / 2f
        val (r, g, b) = when {
            h < 60f -> Triple(c, x, 0f)
            h < 120f -> Triple(x, c, 0f)
            h < 180f -> Triple(0f, c, x)
            h < 240f -> Triple(0f, x, c)
            h < 300f -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }
        fun ch(v: Float) = Math.round((v + m) * 255f).coerceIn(0, 255)
        return (0xFF shl 24) or (ch(r) shl 16) or (ch(g) shl 8) or ch(b)
    }
}
