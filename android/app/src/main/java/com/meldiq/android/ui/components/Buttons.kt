package com.meldiq.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** Primary: the palette's action fill (solid, or its gradient). Glass: outlined secondary. Danger: tinted destructive. */
enum class ButtonTone { Primary, Glass, Danger }

/**
 * The app's button: a pill with centred label (and optional leading icon or progress). The palette's action fill for
 * the main action (solid lime with near-black text on Meldiq), a raised neutral pill for secondary ones, red-tinted for
 * destructive ones. [height] is the minimum: the pill grows with large font sizes instead of clipping its label.
 * [showKnob] is accepted for older call sites; the redesign dropped the arrow knob.
 */
@Composable
fun PillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tone: ButtonTone = ButtonTone.Primary,
    enabled: Boolean = true,
    loading: Boolean = false,
    @Suppress("UNUSED_PARAMETER") showKnob: Boolean = false,
    leadingIcon: ImageVector? = null,
    height: Dp = 52.dp,
) {
    val c = Griip.colors
    val active = enabled && !loading
    val fill: Modifier = when (tone) {
        ButtonTone.Primary -> Modifier.background(Brush.horizontalGradient(listOf(c.actionStart, c.actionEnd)))
        ButtonTone.Danger -> Modifier.background(c.dangerSoft)
        ButtonTone.Glass -> Modifier.background(c.surfaceVariant).border(1.dp, c.border, Shapes.pill)
    }
    val fg = when (tone) {
        ButtonTone.Primary -> c.onAction
        ButtonTone.Danger -> c.danger
        ButtonTone.Glass -> c.textPrimary
    }
    Box(
        modifier
            .heightIn(min = maxOf(height, 44.dp))
            .alpha(if (enabled) 1f else 0.45f)
            .clip(Shapes.pill)
            .then(fill)
            // Always clickable-with-role, so TalkBack says "button, disabled" while it can't be used.
            .pressable(onClick, enabled = active),
        contentAlignment = Alignment.Center,
    ) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            if (loading) {
                CircularProgressIndicator(Modifier.size(18.dp), color = fg, strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
            } else if (leadingIcon != null) {
                Icon(leadingIcon, null, tint = fg, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = Griip.type.button, color = fg, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
    }
}

/** Trailing chevron for navigable rows (no background). */
@Composable
fun ArrowKnob(modifier: Modifier = Modifier, size: Dp = 24.dp, onClick: (() -> Unit)? = null, contentDescription: String? = null) {
    val c = Griip.colors
    Box(
        modifier
            .then(if (onClick != null) Modifier.size(48.dp).clip(CircleShape).pressable(onClick) else Modifier)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = c.textTertiary, modifier = Modifier.size(size))
    }
}

/**
 * Plain icon button with a 48 dp touch target. [size] sets the visible circle (only drawn when a
 * [background] is given) and scales the icon.
 */
@Composable
fun CircleIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Griip.colors.textPrimary,
    background: Color = Color.Transparent,
    size: Dp = 44.dp,
    badge: Boolean = false,
    enabled: Boolean = true,
) {
    val c = Griip.colors
    Box(modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).size(maxOf(size, 48.dp)), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(size)
                .clip(CircleShape)
                .background(background)
                .alpha(if (enabled) 1f else 0.4f)
                .pressable(onClick, enabled = enabled, onClickLabel = contentDescription) // disabled: TalkBack says "disabled"
                .semantics { this.contentDescription = contentDescription },
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = tint, modifier = Modifier.size((size.value * 0.55f).coerceIn(18f, 26f).dp))
        }
        if (badge) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 10.dp).size(9.dp).clip(CircleShape)
                    .background(c.danger).border(1.5.dp, c.background, CircleShape),
            )
        }
    }
}

/**
 * Large round call control (mute, camera, share, end), readable over video. The floating redesign (2026-10-28, after
 * the owner's call reference): charcoal rounds with white glyphs, a light round for a control that is on (or muted), a
 * red hang-up. [showLabel] false keeps the label for TalkBack only (the control bar); incoming calls show it.
 */
@Composable
fun CallControlButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    /** Accept-style green action (incoming call). */
    positive: Boolean = false,
    showLabel: Boolean = true,
    size: Dp = 60.dp,
) {
    val bg = when {
        danger -> CallColors.end
        positive -> Color(0xFF1E9E62)
        active -> CallColors.controlOn
        else -> CallColors.control
    }
    val fg = when {
        danger || positive -> Color.White
        active -> Color(0xFF0B0B0B)
        else -> Color.White
    }
    androidx.compose.foundation.layout.Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(size)
                .clip(CircleShape)
                .background(bg)
                .alpha(if (enabled) 1f else 0.4f)
                .pressable(if (enabled) onClick else null, onClickLabel = label)
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(size * 0.43f))
        }
        if (showLabel) {
            Spacer(Modifier.height(6.dp))
            Text(label, style = Griip.type.caption, color = Color.White.copy(alpha = 0.9f), maxLines = 1)
        }
    }
}

/** The call screen's own colours (always dark, over the palette's call stage): controls, tiles and the bar. */
object CallColors {
    val control = Color.White.copy(alpha = 0.12f)
    val controlOn = Color(0xFFF6F6F3)
    val end = Color(0xFFE5484D)
    val tile = Color.White.copy(alpha = 0.07f)
    val bar = Color.White.copy(alpha = 0.06f)
    val barBorder = Color.White.copy(alpha = 0.08f)
}
