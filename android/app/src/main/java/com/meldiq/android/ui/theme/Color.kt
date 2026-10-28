package com.meldiq.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Colour tokens (docs/DESIGN_SYSTEM.md).
 *
 * Since 2026-10-19 every palette comes from one of the three Meldiq presets ([MeldiqPalettes]: Aurora, Sunset,
 * Meadow), each in light and dark. Older token names are kept so every screen follows: `glass*` are solid surfaces,
 * `canvas*` the flat app background, `hero*` the soft header gradient, `action*` the filled-button colour.
 * Contrast of every pair that carries text is unit-tested (`MeldiqPalettesTest`).
 */
@Immutable
data class GriipColors(
    val isDark: Boolean,
    val primary: Color,
    val primaryBright: Color,
    val primaryDeep: Color,
    val primarySoft: Color,
    val onPrimary: Color,
    val lavender: Color,
    val lavenderSoft: Color,
    val peach: Color,
    val peachSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
    val warning: Color,
    val warningSoft: Color,
    val success: Color,
    val successSoft: Color,
    val canvasTop: Color,
    val canvasMid: Color,
    val canvasBottom: Color,
    val glass: Color,
    val glassStrong: Color,
    val glassBorder: Color,
    val hairline: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val shadow: Color,
    val scrim: Color,
    val bubbleIncoming: Color,
    val callStage: Color,
    /** Filled buttons, send and selected states; they carry [onAction] text and icons. */
    val actionStart: Color,
    val actionEnd: Color,
    /** The soft header gradient behind the workspace name and search (left → right). */
    val heroStart: Color,
    val heroMid: Color,
    val heroEnd: Color,
    /** App background behind lists and screens. */
    val background: Color,
    /** Cards, sheets, bars and incoming messages. */
    val surface: Color,
    /** Search fields, inputs, chips and pressed rows. */
    val surfaceVariant: Color,
    /** 1 dp borders and dividers. */
    val border: Color,
    val onAction: Color,
    val bubbleOutgoing: Color,
    val onBubbleOutgoing: Color,
    val bubbleOutgoingMeta: Color,
    /** Read-receipt ticks on outgoing messages. */
    val readReceipt: Color,
    /** Selected bottom-navigation pill. */
    val navIndicator: Color,
    /** Boundary of inputs and other controls that must stand out from their fill (3:1 where it carries meaning). */
    val outline: Color,
    /** The accent gradient (start → end): highlights, accent text and accent fills carrying [onAccent]. */
    val accentStart: Color,
    val accentEnd: Color,
    val onAccent: Color,
    /** Search field and chips drawn on the header gradient (translucent white). */
    val headerField: Color,
    /** Unread counters and notification dots; they carry [onBadge] digits. */
    val badge: Color,
    val onBadge: Color,
    /** Mentions of you (pink on Meldiq, as Meldiq Web's --mention-badge); they carry [onMention]. Other presets use [badge]. */
    val mention: Color = badge,
    val onMention: Color = onBadge,
)

val LightColors: GriipColors get() = MeldiqPalettes.colors(MeldiqPalettes.DEFAULT, dark = false)
val DarkColors: GriipColors get() = MeldiqPalettes.colors(MeldiqPalettes.DEFAULT, dark = true)

val LocalGriipColors = staticCompositionLocalOf { MeldiqPalettes.colors(MeldiqPalettes.DEFAULT, dark = false) }

/**
 * Avatar colours: muted solid tones (pairs kept for older call sites; both entries are the same colour).
 * White initials meet 4.5:1 on every entry.
 */
private val AvatarTones = listOf(
    Color(0xFF2B7A6B), // teal
    Color(0xFF5363AE), // indigo
    Color(0xFFA35F1E), // amber
    Color(0xFF3A7F4E), // green
    Color(0xFF2E70A1), // blue
    Color(0xFFAA4A6C), // rose
    Color(0xFF7652A8), // violet
    Color(0xFF52666F), // slate
)
val AvatarGradients = AvatarTones.map { it to it }
