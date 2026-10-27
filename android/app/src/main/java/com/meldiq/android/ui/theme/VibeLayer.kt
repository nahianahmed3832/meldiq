package com.meldiq.android.ui.theme

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.data.model.Vibes

/**
 * The colour theme's tint over everything below it (Settings › Appearance › Colour themes, as Meldiq Web): one diagonal
 * gradient blended softly into the app (soft light on dark palettes, multiply on light ones), never catching a touch.
 * Nothing is drawn without a theme, so the app's own layers stay as they are.
 */
fun Modifier.vibeTint(vibe: String?, custom: List<String>, strength: Int, dark: Boolean): Modifier {
    val colors = Vibes.colors(vibe, custom)?.mapNotNull { LookRules.argb(it)?.let(::Color) }?.takeIf { it.size >= 2 } ?: return this
    val alpha = Vibes.alpha(strength, dark)
    val blend = if (dark) BlendMode.Softlight else BlendMode.Multiply
    return this
        // Blending needs the app drawn into its own layer first, so the tint mixes with what's underneath.
        .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            drawRect(Brush.linearGradient(colors, start = Offset.Zero, end = Offset(size.width, size.height)), alpha = alpha, blendMode = blend)
        }
}
