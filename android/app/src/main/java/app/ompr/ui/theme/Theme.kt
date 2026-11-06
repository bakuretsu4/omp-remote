package app.ompr.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape

private val LightScheme = lightColorScheme(
    primary = Color(0xFF4355B9), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFDEE0FF), onPrimaryContainer = Color(0xFF00105C),
    secondary = Color(0xFF5A5D72), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFDFE1F9), onSecondaryContainer = Color(0xFF171B2C),
    tertiary = Color(0xFF76546E), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFFFD7F2), onTertiaryContainer = Color(0xFF2D1228),
    error = Color(0xFFBA1A1A), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFEFBFF), onBackground = Color(0xFF1B1B1F),
    surface = Color(0xFFFEFBFF), onSurface = Color(0xFF1B1B1F),
    surfaceVariant = Color(0xFFE3E1EC), onSurfaceVariant = Color(0xFF46464F),
    outline = Color(0xFF777680), outlineVariant = Color(0xFFC7C5D0),
    inverseSurface = Color(0xFF303034), inverseOnSurface = Color(0xFFF2F0F4), inversePrimary = Color(0xFFBAC3FF),
    surfaceTint = Color(0xFF4355B9),
    surfaceDim = Color(0xFFDCD9DE), surfaceBright = Color(0xFFFEFBFF),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFF6F2F7),
    surfaceContainer = Color(0xFFF0EDF1), surfaceContainerHigh = Color(0xFFEAE7EC), surfaceContainerHighest = Color(0xFFE4E1E6),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFBAC3FF), onPrimary = Color(0xFF08218A),
    primaryContainer = Color(0xFF293CA0), onPrimaryContainer = Color(0xFFDEE0FF),
    secondary = Color(0xFFC2C5DD), onSecondary = Color(0xFF2B3042),
    secondaryContainer = Color(0xFF424659), onSecondaryContainer = Color(0xFFDFE1F9),
    tertiary = Color(0xFFE6BAD7), onTertiary = Color(0xFF44263D),
    tertiaryContainer = Color(0xFF5D3C55), onTertiaryContainer = Color(0xFFFFD7F2),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF121316), onBackground = Color(0xFFE4E1E6),
    surface = Color(0xFF121316), onSurface = Color(0xFFE4E1E6),
    surfaceVariant = Color(0xFF46464F), onSurfaceVariant = Color(0xFFC7C5D0),
    outline = Color(0xFF91909A), outlineVariant = Color(0xFF46464F),
    inverseSurface = Color(0xFFE4E1E6), inverseOnSurface = Color(0xFF303034), inversePrimary = Color(0xFF4355B9),
    surfaceTint = Color(0xFFBAC3FF),
    surfaceDim = Color(0xFF121316), surfaceBright = Color(0xFF38393C),
    surfaceContainerLowest = Color(0xFF0D0E11), surfaceContainerLow = Color(0xFF1B1B1F),
    surfaceContainer = Color(0xFF1F1F23), surfaceContainerHigh = Color(0xFF292A2D), surfaceContainerHighest = Color(0xFF343438),
)

/** Semantic colours for session status, tuned for both themes. */
@Immutable
class StatusColors(
    val working: Color,
    val waiting: Color,
    val idle: Color,
    val offline: Color,
    val onWorking: Color,
    val onWaiting: Color,
    val onIdle: Color,
    val onOffline: Color,
)

private val LightStatus = StatusColors(
    working = Color(0xFFD6E3FF), waiting = Color(0xFFFFE0B2), idle = Color(0xFFCFF0D4), offline = Color(0xFFE0E0E0),
    onWorking = Color(0xFF0B3A8F), onWaiting = Color(0xFF7A3E00), onIdle = Color(0xFF14532D), onOffline = Color(0xFF424242),
)
private val DarkStatus = StatusColors(
    working = Color(0xFF1F3A6E), waiting = Color(0xFF6B3A00), idle = Color(0xFF1B4D2B), offline = Color(0xFF3A3A3A),
    onWorking = Color(0xFFD6E3FF), onWaiting = Color(0xFFFFDDB3), onIdle = Color(0xFFBCEFC8), onOffline = Color(0xFFD0D0D0),
)

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

/** Convenience accessor: `MaterialTheme.status.working`. */
val MaterialTheme.status: StatusColors
    @Composable get() = LocalStatusColors.current

private val Base = Typography()

/** Slightly firmer titles and tighter labels than the Material defaults; sizes stay on the Material scale. */
private val OmprTypography = Typography(
    titleLarge = Base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = Base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = Base.titleSmall.copy(fontWeight = FontWeight.SemiBold),
    labelLarge = Base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    bodyMedium = Base.bodyMedium.copy(lineHeight = 21.sp),
)

private val OmprMaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/**
 * [dynamicColor] follows the wallpaper (Material You) on Android 12+. With it off, or below Android 12, the fixed
 * palettes above are used.
 */
@Composable
fun OmprTheme(darkTheme: Boolean = isSystemInDarkTheme(), dynamicColor: Boolean = true, content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val scheme: ColorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= 31 -> if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        darkTheme -> DarkScheme
        else -> LightScheme
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalStatusColors provides if (darkTheme) DarkStatus else LightStatus) {
        MaterialTheme(
            colorScheme = scheme,
            typography = OmprTypography,
            shapes = OmprMaterialShapes,
            content = content,
        )
    }
}

/** The colours of PC tag [index] in the current theme, harmonised with the scheme's primary. */
@Composable
fun pcColors(index: Int): PcColorsUi {
    val scheme = MaterialTheme.colorScheme
    val dark = scheme.background.luminance() < 0.5f
    val hue = PcPalette.hueOf(scheme.primary.toArgb())
    val c = androidx.compose.runtime.remember(index, dark, hue) { PcPalette.colors(index, dark, hue) }
    return androidx.compose.runtime.remember(c) { PcColorsUi(Color(c.dot), Color(c.container), Color(c.onContainer)) }
}

@Immutable
class PcColorsUi(val dot: Color, val container: Color, val onContainer: Color)
