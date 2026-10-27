package com.meldiq.android.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.meldiq.android.ui.theme.AvatarGradients
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

fun initialsOf(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> (parts[0].take(1) + parts.last().take(1)).uppercase()
    }
}

/** Circle avatar: white initials on a deterministic solid colour; optional presence dot. [ring] is kept for older call sites. */
@Composable
fun Avatar(
    name: String,
    colorIndex: Int,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    online: Boolean? = null,
    @Suppress("UNUSED_PARAMETER") ring: Boolean = true,
    /** Batch B6b: "idle" or "dnd" colours the online dot (amber, red). */
    presence: String? = null,
) {
    val c = Griip.colors
    val (a, _) = AvatarGradients[((colorIndex % AvatarGradients.size) + AvatarGradients.size) % AvatarGradients.size]
    Box(modifier.size(size).semantics(mergeDescendants = true) { contentDescription = "$name avatar" }) {
        Box(Modifier.size(size).clip(CircleShape).background(a), contentAlignment = Alignment.Center) {
            Text(
                initialsOf(name),
                color = Color.White,
                style = Griip.type.titleSmall.copy(fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.SemiBold),
                maxLines = 1,
            )
        }
        if (online == true) PresenceDot(size, presence, Modifier.align(Alignment.BottomEnd))
    }
}

/** The dot on an avatar of someone who appears online: green, amber while idle, red on do not disturb (batch B6b). */
@Composable
fun PresenceDot(avatarSize: Dp, presence: String?, modifier: Modifier = Modifier) {
    val c = Griip.colors
    val dot = (avatarSize.value * 0.26f).coerceIn(10f, 14f).dp
    val (color, label) = when (presence) {
        com.meldiq.android.data.model.PresenceRules.IDLE -> c.warning to androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b6b_idle)
        com.meldiq.android.data.model.PresenceRules.DND -> c.danger to androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b6b_dnd)
        else -> c.success to androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b5_online)
    }
    Box(modifier.size(dot).clip(CircleShape).background(color).border(2.dp, c.surface, CircleShape).semantics { contentDescription = label })
}

/** Rounded-square mark for orgs, branches and teams (people are circles; places are squares). */
@Composable
fun MarkTile(label: String, colorIndex: Int, modifier: Modifier = Modifier, size: Dp = 48.dp) {
    val (a, _) = AvatarGradients[((colorIndex % AvatarGradients.size) + AvatarGradients.size) % AvatarGradients.size]
    Box(modifier.size(size).clip(Shapes.iconTile).background(a), contentAlignment = Alignment.Center) {
        Text(initialsOf(label), color = Color.White, style = Griip.type.titleSmall.copy(fontSize = (size.value * 0.34f).sp, fontWeight = FontWeight.SemiBold))
    }
}

/** Tinted rounded tile holding a line icon (channels, groups, settings rows). */
@Composable
fun IconTile(icon: ImageVector, tint: Color, background: Color, modifier: Modifier = Modifier, size: Dp = 44.dp) {
    Box(modifier.size(size).clip(Shapes.iconTile).background(background), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** Section label above a list or settings group. */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val c = Griip.colors
    Row(modifier.fillMaxWidth().padding(horizontal = Space.gutter), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = Griip.type.section, color = c.textSecondary, modifier = Modifier.weight(1f).semantics { heading() })
        if (action != null && onAction != null) {
            Text(
                action,
                style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold),
                color = c.primary,
                modifier = Modifier.clip(Shapes.pill).pressable(onAction).padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier, muted: Boolean = false) {
    if (count <= 0) return
    val c = Griip.colors
    Box(
        modifier.height(20.dp).clip(Shapes.pill).background(if (muted) c.textTertiary else c.primary).padding(horizontal = 6.dp)
            .semantics { contentDescription = "$count unread" },
        contentAlignment = Alignment.Center,
    ) { Text(if (count > 99) "99+" else "$count", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = if (muted) c.surface else c.onPrimary) }
}

@Composable
fun TagPill(text: String, color: Color, background: Color, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Row(
        modifier.clip(Shapes.pill).background(background).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = color, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(text, style = Griip.type.caption, color = color, maxLines = 1)
    }
}

@Composable
fun RoleBadge(role: String?, modifier: Modifier = Modifier) {
    if (role == null) return
    val c = Griip.colors
    val (fg, bg) = when (role.uppercase()) {
        "OWNER" -> c.peach to c.peachSoft
        "ADMIN" -> c.lavender to c.lavenderSoft
        "MANAGER", "LEAD" -> c.primaryDeep to c.primarySoft
        "GUEST" -> c.warning to c.warningSoft
        else -> c.textSecondary to c.surfaceVariant
    }
    val label = when (role.uppercase()) {
        "MANAGER" -> "Branch manager"
        "LEAD" -> "Team lead"
        else -> role.lowercase().replaceFirstChar { it.uppercase() }
    }
    TagPill(label, fg, bg, modifier)
}

@Composable
fun SlimProgress(progress: Float, modifier: Modifier = Modifier, color: Color = Griip.colors.primary) {
    val c = Griip.colors
    val p by animateFloatAsState(progress.coerceIn(0f, 1f), tween(400), label = "bar")
    Box(modifier.fillMaxWidth().height(4.dp).clip(Shapes.pill).background(c.surfaceVariant)) {
        Box(Modifier.fillMaxWidth(p).height(4.dp).clip(Shapes.pill).background(color))
    }
}

/** Compact stat: value over label, no container of its own (it sits inside a card). */
@Composable
fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    val c = Griip.colors
    Column(modifier.clip(Shapes.small).background(c.surfaceVariant).padding(vertical = 10.dp, horizontal = 8.dp).semantics(mergeDescendants = true) {}) {
        Text(value, style = Griip.type.title, color = c.textPrimary, maxLines = 1, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
        Text(label, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
    }
}

/**
 * A flat list row: leading visual, title, subtitle, optional meta line, trailing slot. Tappable rows get a
 * ripple; [selected] tints the row. (Historical name: it used to be a floating card.)
 */
@Composable
fun ListCard(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    meta: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    selected: Boolean = false,
    /** Replaces the plain [subtitle] text, e.g. with an icon and a coloured status line. */
    subtitleContent: (@Composable () -> Unit)? = null,
) {
    val c = Griip.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(Shapes.tile)
            .background(if (selected) c.primarySoft else Color.Transparent)
            .pressable(onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.titleSmall, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitleContent != null) {
                Spacer(Modifier.height(1.dp))
                subtitleContent()
            } else if (subtitle != null) {
                Spacer(Modifier.height(1.dp))
                Text(subtitle, style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (meta != null) {
                Spacer(Modifier.height(6.dp))
                meta()
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width(10.dp))
            trailing()
        }
    }
}

/** Settings/menu row: a monochrome glyph, label (+subtitle), chevron/switch/value ([tint] only for danger or warning rows). */
@Composable
fun MenuRow(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    tint: Color = Griip.colors.primary,
    @Suppress("UNUSED_PARAMETER") tintBg: Color = Griip.colors.primarySoft,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = { Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = Griip.colors.textTertiary) },
) {
    val c = Griip.colors
    // 2026-10-28 (as Meldiq Web's settings lists): a plain monochrome glyph instead of a coloured tile; only a
    // destructive or warning row keeps its colour.
    val glyph = when (tint) {
        c.danger, c.warning -> tint
        else -> c.textSecondary
    }
    Row(
        modifier.fillMaxWidth().heightIn(min = 52.dp).clip(Shapes.small).pressable(onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = glyph, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.bodyMedium.copy(fontSize = 15.sp), color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = Griip.type.caption, color = c.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

/** A settings row's current value before its chevron ("Dark · Graphite", "On"), for [MenuRow]'s trailing slot. */
@Composable
fun ValueChevron(value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(value, style = Griip.type.caption, color = Griip.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 140.dp))
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = Griip.colors.textTertiary)
    }
}

enum class BannerKind { Info, Warning, Error, Success }

@Composable
fun StatusBanner(text: String, kind: BannerKind, modifier: Modifier = Modifier, icon: ImageVector? = null, action: String? = null, onAction: (() -> Unit)? = null) {
    val c = Griip.colors
    val (fg, bg) = when (kind) {
        BannerKind.Info -> c.primaryDeep to c.primarySoft
        BannerKind.Warning -> c.warning to c.warningSoft
        BannerKind.Error -> c.danger to c.dangerSoft
        BannerKind.Success -> c.success to c.successSoft
    }
    Row(
        modifier.fillMaxWidth().clip(Shapes.tile).background(bg).padding(horizontal = 14.dp, vertical = 10.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
        }
        Text(text, style = Griip.type.label, color = if (kind == BannerKind.Info) c.textPrimary else fg, modifier = Modifier.weight(1f))
        if (action != null && onAction != null) {
            Text(action, style = Griip.type.label.copy(fontWeight = FontWeight.Bold), color = fg, modifier = Modifier.clip(Shapes.pill).pressable(onAction).padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

/** Empty/error state: icon in a soft circle, title, hint, optional action. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    tint: Color = Griip.colors.primary,
) {
    val c = Griip.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(c.primarySoft), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(32.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(title, style = Griip.type.title, color = c.textPrimary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(message, style = Griip.type.bodySmall, color = c.textSecondary, textAlign = TextAlign.Center)
        if (action != null && onAction != null) {
            Spacer(Modifier.height(20.dp))
            PillButton(action, onAction)
        }
    }
}

/** Loading placeholder: a softly pulsing block. */
@Composable
fun ShimmerBlock(modifier: Modifier = Modifier, shape: androidx.compose.ui.graphics.Shape = Shapes.card) {
    val c = Griip.colors
    val t = rememberInfiniteTransition(label = "shimmer")
    val a by t.animateFloat(0.55f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse), label = "a")
    Box(modifier.clip(shape).background(c.surfaceVariant.copy(alpha = a)))
}

@Composable
fun ShimmerList(count: Int = 5, modifier: Modifier = Modifier) {
    Column(modifier.padding(horizontal = Space.gutter).semantics { contentDescription = "Loading" }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(count) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ShimmerBlock(Modifier.size(48.dp), CircleShape)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    ShimmerBlock(Modifier.fillMaxWidth(0.55f).height(14.dp), Shapes.small)
                    Spacer(Modifier.height(8.dp))
                    ShimmerBlock(Modifier.fillMaxWidth(0.85f).height(12.dp), Shapes.small)
                }
            }
        }
    }
}

@Composable
fun PageDots(count: Int, selected: Int, modifier: Modifier = Modifier) {
    val c = Griip.colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(count) { i ->
            Box(Modifier.height(6.dp).width(if (i == selected) 18.dp else 6.dp).clip(Shapes.pill).background(if (i == selected) c.primary else c.textTertiary.copy(alpha = 0.4f)))
        }
    }
}
