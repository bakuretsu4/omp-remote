package app.ompr.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
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
    primary = Color(0xFF3D5AFE),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE1FF),
    onPrimaryContainer = Color(0xFF001258),
    secondary = Color(0xFF5B5D72),
    secondaryContainer = Color(0xFFE0E0F9),
    tertiary = Color(0xFF00696B),
    tertiaryContainer = Color(0xFFA0F0F2),
    background = Color(0xFFFBF8FF),
    surface = Color(0xFFFBF8FF),
    surfaceVariant = Color(0xFFE3E1EC),
    errorContainer = Color(0xFFFFDAD6),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFB8C3FF),
    onPrimary = Color(0xFF00218C),
    primaryContainer = Color(0xFF2B3FAD),
    onPrimaryContainer = Color(0xFFDDE1FF),
    secondary = Color(0xFFC3C4DD),
    secondaryContainer = Color(0xFF434559),
    tertiary = Color(0xFF84D3D5),
    tertiaryContainer = Color(0xFF004F51),
    background = Color(0xFF121318),
    surface = Color(0xFF121318),
    surfaceVariant = Color(0xFF45464F),
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

@Composable
fun OmprTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val scheme: ColorScheme = when {
        Build.VERSION.SDK_INT >= 31 -> if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        darkTheme -> DarkScheme
        else -> LightScheme
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalStatusColors provides if (darkTheme) DarkStatus else LightStatus) {
        MaterialTheme(
            colorScheme = scheme,
            shapes = Shapes(medium = RoundedCornerShape(14.dp), large = RoundedCornerShape(20.dp)),
            content = content,
        )
    }
}
