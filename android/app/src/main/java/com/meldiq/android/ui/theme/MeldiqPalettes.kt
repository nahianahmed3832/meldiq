package com.meldiq.android.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * The Meldiq palettes (2026-10-19, from the owner's three-theme reference and the logo; docs/DESIGN_SYSTEM.md):
 *
 * - **Meldiq** (default since 2026-10-28, as Meldiq Web's community-first palette): deep navy surfaces, the logo's
 *   cyan, blue and violet for selection and actions, pink only for mentions, white for unread.
 * - **Graphite** (default from round 6 to 2026-10-28): the professional workspace look for long working days. Dark mode is
 *   charcoal canvas, slate bars and cards, inset inputs, flat (no gradient) header and one restrained indigo accent
 *   taken from the logo's ribbon. Light mode is the same design in neutral greys.
 * - **Aurora**: lavender → sky header, indigo actions and a violet accent, like the logo's ribbon. Dark mode
 *   sits on the logo's own navy.
 * - **Sunset**: peach → pink header with magenta actions.
 * - **Meadow**: mint header with green actions.
 *
 * A preset changes the whole palette (header, actions, badges, tinted neutrals), never single screens. Contrast is
 * unit-tested for every preset in both modes (`MeldiqPalettesTest`): text 4.5:1 or better on every surface it sits on,
 * outlines 3:1.
 */
object MeldiqPalettes {
    const val DEFAULT = "meldiq"

    data class Preset(val id: String, val label: String, val light: GriipColors, val dark: GriipColors)

    /** The colours one preset contributes in one mode; the rest is shared ([shared]). */
    private data class Tones(
        val background: Long, val surface: Long, val surfaceVariant: Long, val border: Long, val outline: Long,
        val textPrimary: Long, val textSecondary: Long, val textTertiary: Long,
        val primary: Long, val primaryBright: Long, val primaryDeep: Long, val primarySoft: Long, val onPrimary: Long,
        val action: Long, val onAction: Long, val accentStart: Long, val accentEnd: Long, val onAccent: Long,
        val headerStart: Long, val headerMid: Long, val headerEnd: Long, val badge: Long, val onBadge: Long,
        val bubbleOutgoing: Long, val onBubbleOutgoing: Long, val bubbleOutgoingMeta: Long, val navIndicator: Long,
        /** Search field and chips on the header; null keeps the translucent white used on gradient headers. */
        val headerField: Long? = null,
    )

    private fun shared(t: Tones, dark: Boolean): GriipColors {
        val c = { v: Long -> Color(v) }
        return GriipColors(
            isDark = dark,
            primary = c(t.primary), primaryBright = c(t.primaryBright), primaryDeep = c(t.primaryDeep),
            primarySoft = c(t.primarySoft), onPrimary = c(t.onPrimary),
            lavender = if (dark) Color(0xFFB9B4F0) else Color(0xFF5B50B5),
            lavenderSoft = if (dark) Color(0xFF282752) else Color(0xFFEDEBFA),
            peach = if (dark) Color(0xFFF5B58A) else Color(0xFFA04F1C),
            peachSoft = if (dark) Color(0xFF3A2B22) else Color(0xFFF9ECE1),
            danger = if (dark) Color(0xFFFF8A80) else Color(0xFFC42B2B),
            dangerSoft = if (dark) Color(0xFF3E1F1D) else Color(0xFFFBE6E4),
            warning = if (dark) Color(0xFFF2C26B) else Color(0xFF8A5A00),
            warningSoft = if (dark) Color(0xFF3A2F1A) else Color(0xFFFBF0DA),
            success = if (dark) Color(0xFF6EDAA4) else Color(0xFF13784A),
            successSoft = if (dark) Color(0xFF16352A) else Color(0xFFE0F2E8),
            canvasTop = c(t.background), canvasMid = c(t.background), canvasBottom = c(t.background),
            glass = c(t.surface), glassStrong = c(t.surfaceVariant), glassBorder = c(t.border),
            hairline = if (dark) Color.White.copy(alpha = 0.08f) else Color(t.textPrimary).copy(alpha = 0.08f),
            textPrimary = c(t.textPrimary), textSecondary = c(t.textSecondary), textTertiary = c(t.textTertiary),
            shadow = if (dark) Color.Black.copy(alpha = 0.32f) else Color(0xFF1A1C3A).copy(alpha = 0.07f),
            scrim = Color.Black.copy(alpha = if (dark) 0.6f else 0.42f),
            bubbleIncoming = c(t.surface),
            callStage = Color(0xFF070B1F),
            actionStart = c(t.action), actionEnd = c(t.action),
            heroStart = c(t.headerStart), heroMid = c(t.headerMid), heroEnd = c(t.headerEnd),
            background = c(t.background), surface = c(t.surface), surfaceVariant = c(t.surfaceVariant), border = c(t.border),
            onAction = c(t.onAction),
            bubbleOutgoing = c(t.bubbleOutgoing), onBubbleOutgoing = c(t.onBubbleOutgoing), bubbleOutgoingMeta = c(t.bubbleOutgoingMeta),
            readReceipt = if (dark) Color(0xFF7CC0FF) else Color(0xFF2563D9),
            navIndicator = c(t.navIndicator),
            outline = c(t.outline),
            accentStart = c(t.accentStart), accentEnd = c(t.accentEnd), onAccent = c(t.onAccent),
            headerField = t.headerField?.let(c) ?: Color.White.copy(alpha = if (dark) 0.10f else 0.70f),
            badge = c(t.badge), onBadge = c(t.onBadge),
        )
    }

    // Meldiq Web's `data-palette="meldiq"` tokens (styles/tokens.css), one for one where Android has the same role; the light
    // teal accent is a shade deeper than the web's #0e7fa0 and the dark violet a shade lighter than its #8b5cf6, as both read
    // about 4.3:1 here where Android draws text on or in them (4.5:1 is the rule).
    private val meldiqLight = Tones(
        background = 0xFFF4F6FB, surface = 0xFFFFFFFF, surfaceVariant = 0xFFEEF1F8, border = 0xFFE1E6F0, outline = 0xFF7F88A4,
        textPrimary = 0xFF121933, textSecondary = 0xFF434C6B, textTertiary = 0xFF5F6887,
        primary = 0xFF3A5BD9, primaryBright = 0xFF4A6BE6, primaryDeep = 0xFF2C48B8, primarySoft = 0xFFE6ECFD, onPrimary = 0xFFFFFFFF,
        action = 0xFF2563EB, onAction = 0xFFFFFFFF, accentStart = 0xFF0A6A86, accentEnd = 0xFF7C3AED, onAccent = 0xFFFFFFFF,
        headerStart = 0xFFFFFFFF, headerMid = 0xFFFFFFFF, headerEnd = 0xFFFFFFFF, badge = 0xFFC81E66, onBadge = 0xFFFFFFFF,
        bubbleOutgoing = 0xFFEAF0FE, onBubbleOutgoing = 0xFF121933, bubbleOutgoingMeta = 0xFF434C6B, navIndicator = 0xFFE6EAF6,
        headerField = 0xFFEEF1F8,
    )
    private val meldiqDark = Tones(
        background = 0xFF0B1020, surface = 0xFF10172B, surfaceVariant = 0xFF151D34, border = 0xFF1F2944, outline = 0xFF6B7598,
        textPrimary = 0xFFEEF2FF, textSecondary = 0xFFB4BDDB, textTertiary = 0xFF8A94B6,
        primary = 0xFF7AA2FF, primaryBright = 0xFF9AB8FF, primaryDeep = 0xFFA9C2FF, primarySoft = 0xFF1B2850, onPrimary = 0xFF0A1230,
        action = 0xFF2563EB, onAction = 0xFFFFFFFF, accentStart = 0xFF22D3EE, accentEnd = 0xFF9B73F7, onAccent = 0xFF0A1230,
        headerStart = 0xFF10172B, headerMid = 0xFF10172B, headerEnd = 0xFF10172B, badge = 0xFFFF5FA8, onBadge = 0xFF2A0517,
        bubbleOutgoing = 0xFF172245, onBubbleOutgoing = 0xFFEEF2FF, bubbleOutgoingMeta = 0xFFB4BDDB, navIndicator = 0xFF1F2A4A,
        headerField = 0xFF0C1326,
    )
    private val graphiteLight = Tones(
        background = 0xFFF4F5F7, surface = 0xFFFFFFFF, surfaceVariant = 0xFFEBECEF, border = 0xFFDCDEE3, outline = 0xFF7A7F8C,
        textPrimary = 0xFF17181C, textSecondary = 0xFF4A4D57, textTertiary = 0xFF5D616C,
        primary = 0xFF4B4FC9, primaryBright = 0xFF5B5FD8, primaryDeep = 0xFF353AA6, primarySoft = 0xFFE8E9FB, onPrimary = 0xFFFFFFFF,
        action = 0xFF4B4FC9, onAction = 0xFFFFFFFF, accentStart = 0xFF4B4FC9, accentEnd = 0xFF4B4FC9, onAccent = 0xFFFFFFFF,
        headerStart = 0xFFFFFFFF, headerMid = 0xFFFFFFFF, headerEnd = 0xFFFFFFFF, badge = 0xFFC42B32, onBadge = 0xFFFFFFFF,
        bubbleOutgoing = 0xFFE6E7FA, onBubbleOutgoing = 0xFF17181C, bubbleOutgoingMeta = 0xFF4A4D70, navIndicator = 0xFFE3E4F7,
        headerField = 0xFFEBECEF,
    )
    private val graphiteDark = Tones(
        background = 0xFF1E1F24, surface = 0xFF26282E, surfaceVariant = 0xFF2F3138, border = 0xFF383B43, outline = 0xFF7A7F8C,
        textPrimary = 0xFFECEDF0, textSecondary = 0xFFB6BAC3, textTertiary = 0xFF989DA8,
        primary = 0xFFA5ADFF, primaryBright = 0xFFB8BEFF, primaryDeep = 0xFFC8CDFF, primarySoft = 0xFF2E3150, onPrimary = 0xFF14163A,
        action = 0xFF5A5FD8, onAction = 0xFFFFFFFF, accentStart = 0xFF8B93FF, accentEnd = 0xFF8B93FF, onAccent = 0xFF14163A,
        headerStart = 0xFF26282E, headerMid = 0xFF26282E, headerEnd = 0xFF26282E, badge = 0xFFF06A6F, onBadge = 0xFF2A0A0C,
        bubbleOutgoing = 0xFF33365A, onBubbleOutgoing = 0xFFEEEFFD, bubbleOutgoingMeta = 0xFFBCC0E6, navIndicator = 0xFF383B52,
        headerField = 0xFF1E1F24,
    )
    private val auroraLight = Tones(
        background = 0xFFF4F5FB, surface = 0xFFFFFFFF, surfaceVariant = 0xFFECEEF8, border = 0xFFDDE0EE, outline = 0xFF7C82A8,
        textPrimary = 0xFF121433, textSecondary = 0xFF444868, textTertiary = 0xFF5A5E80,
        primary = 0xFF4441D0, primaryBright = 0xFF5B58E6, primaryDeep = 0xFF2E2B9E, primarySoft = 0xFFE9E8FD, onPrimary = 0xFFFFFFFF,
        action = 0xFF4441D0, onAction = 0xFFFFFFFF, accentStart = 0xFF4441D0, accentEnd = 0xFF7B35D9, onAccent = 0xFFFFFFFF,
        headerStart = 0xFFF1E4FA, headerMid = 0xFFE4E5FB, headerEnd = 0xFFD8E7FC, badge = 0xFFD1245A, onBadge = 0xFFFFFFFF,
        bubbleOutgoing = 0xFFE7E6FC, onBubbleOutgoing = 0xFF15163A, bubbleOutgoingMeta = 0xFF4F5180, navIndicator = 0xFFE3E2FB,
    )
    private val auroraDark = Tones(
        background = 0xFF0A0E27, surface = 0xFF121736, surfaceVariant = 0xFF1B2145, border = 0xFF272E57, outline = 0xFF6F77A6,
        textPrimary = 0xFFECEEFB, textSecondary = 0xFFB4B9DA, textTertiary = 0xFF959BC2,
        primary = 0xFFA3A5FF, primaryBright = 0xFFB9BAFF, primaryDeep = 0xFFC9CAFF, primarySoft = 0xFF25295C, onPrimary = 0xFF10123A,
        action = 0xFF5552E0, onAction = 0xFFFFFFFF, accentStart = 0xFF3CD6EE, accentEnd = 0xFFB49BFA, onAccent = 0xFF0A0E27,
        headerStart = 0xFF1E1C4E, headerMid = 0xFF172352, headerEnd = 0xFF112A55, badge = 0xFFFF7AA2, onBadge = 0xFF2B0715,
        bubbleOutgoing = 0xFF2A2D6A, onBubbleOutgoing = 0xFFEEEFFD, bubbleOutgoingMeta = 0xFFB9BBE8, navIndicator = 0xFF272B63,
    )
    private val sunsetLight = Tones(
        background = 0xFFFBF5F3, surface = 0xFFFFFFFF, surfaceVariant = 0xFFF6ECE9, border = 0xFFEBDDD8, outline = 0xFF9A8780,
        textPrimary = 0xFF24131A, textSecondary = 0xFF5B4450, textTertiary = 0xFF6E5662,
        primary = 0xFFA12460, primaryBright = 0xFFBC3474, primaryDeep = 0xFF7A1747, primarySoft = 0xFFFBE4EE, onPrimary = 0xFFFFFFFF,
        action = 0xFFA12460, onAction = 0xFFFFFFFF, accentStart = 0xFFB83A1E, accentEnd = 0xFFA12460, onAccent = 0xFFFFFFFF,
        headerStart = 0xFFFFE8D6, headerMid = 0xFFFDE2E0, headerEnd = 0xFFFBDCEA, badge = 0xFFB4281E, onBadge = 0xFFFFFFFF,
        bubbleOutgoing = 0xFFFBE3EC, onBubbleOutgoing = 0xFF2A1018, bubbleOutgoingMeta = 0xFF7A4A5C, navIndicator = 0xFFF8DCE8,
    )
    private val sunsetDark = Tones(
        background = 0xFF170E12, surface = 0xFF22151B, surfaceVariant = 0xFF2E1E25, border = 0xFF3D2A32, outline = 0xFF8A7079,
        textPrimary = 0xFFFBEFF2, textSecondary = 0xFFD3BCC4, textTertiary = 0xFFB49DA6,
        primary = 0xFFFF9DC5, primaryBright = 0xFFFFB3D2, primaryDeep = 0xFFFFC6DD, primarySoft = 0xFF47202F, onPrimary = 0xFF3A0A1E,
        action = 0xFFB23A70, onAction = 0xFFFFFFFF, accentStart = 0xFFFFAE7A, accentEnd = 0xFFFF8DB8, onAccent = 0xFF2A0E14,
        headerStart = 0xFF3A1D20, headerMid = 0xFF3A1B28, headerEnd = 0xFF3A1830, badge = 0xFFFF8A7A, onBadge = 0xFF2D0905,
        bubbleOutgoing = 0xFF4A2333, onBubbleOutgoing = 0xFFFCEFF3, bubbleOutgoingMeta = 0xFFE0B9C7, navIndicator = 0xFF4A2333,
    )
    private val meadowLight = Tones(
        background = 0xFFF3F8F4, surface = 0xFFFFFFFF, surfaceVariant = 0xFFE8F1EA, border = 0xFFD7E4DA, outline = 0xFF7E9284,
        textPrimary = 0xFF0F1E15, textSecondary = 0xFF3E5246, textTertiary = 0xFF536759,
        primary = 0xFF0E7340, primaryBright = 0xFF16894F, primaryDeep = 0xFF0A5730, primarySoft = 0xFFDDF3E4, onPrimary = 0xFFFFFFFF,
        action = 0xFF0E7340, onAction = 0xFFFFFFFF, accentStart = 0xFF0E7340, accentEnd = 0xFF0B6B5E, onAccent = 0xFFFFFFFF,
        headerStart = 0xFFE3F7E2, headerMid = 0xFFD7F3DD, headerEnd = 0xFFCBEFD8, badge = 0xFF0E6B3A, onBadge = 0xFFFFFFFF,
        bubbleOutgoing = 0xFFDCF1E2, onBubbleOutgoing = 0xFF0E1F14, bubbleOutgoingMeta = 0xFF3F6B4E, navIndicator = 0xFFD5EEDC,
    )
    private val meadowDark = Tones(
        background = 0xFF08130D, surface = 0xFF0F1D15, surfaceVariant = 0xFF18291F, border = 0xFF22372A, outline = 0xFF6C8A76,
        textPrimary = 0xFFE9F4EC, textSecondary = 0xFFAFC6B6, textTertiary = 0xFF91AA99,
        primary = 0xFF6EDB9E, primaryBright = 0xFF8AE5B2, primaryDeep = 0xFFA5EEC4, primarySoft = 0xFF173B27, onPrimary = 0xFF052414,
        action = 0xFF17804A, onAction = 0xFFFFFFFF, accentStart = 0xFF6EDB9E, accentEnd = 0xFF5ED6C8, onAccent = 0xFF062014,
        headerStart = 0xFF10301E, headerMid = 0xFF0F2D22, headerEnd = 0xFF0E2A26, badge = 0xFF6EDB9E, onBadge = 0xFF052414,
        bubbleOutgoing = 0xFF164A2E, onBubbleOutgoing = 0xFFEAF7EF, bubbleOutgoingMeta = 0xFFA9D3B8, navIndicator = 0xFF1A4029,
    )

    val ALL: List<Preset> = listOf(
        Preset("meldiq", "Meldiq", shared(meldiqLight, false), shared(meldiqDark, true)),
        Preset("graphite", "Graphite", shared(graphiteLight, false), shared(graphiteDark, true)),
        Preset("aurora", "Aurora", shared(auroraLight, false), shared(auroraDark, true)),
        Preset("sunset", "Sunset", shared(sunsetLight, false), shared(sunsetDark, true)),
        Preset("meadow", "Meadow", shared(meadowLight, false), shared(meadowDark, true)),
    )

    /**
     * Version of the default look. Installs before version 2 moved once to Graphite and from following the system to dark
     * mode (an explicit light or dark choice is kept); version 3 (2026-10-28) moves Graphite, the old default, to Meldiq,
     * as Meldiq Web did for browsers that never picked a palette. `SettingsStore` does this on first read.
     */
    const val DESIGN_VERSION = 3

    /** The default before [DESIGN_VERSION] 3: installs still on it move to [DEFAULT]. */
    const val PREVIOUS_DEFAULT = "graphite"

    /** The preset with this id; anything else (older accent ids, a missing setting) is the default. */
    fun of(id: String?): Preset = ALL.firstOrNull { it.id == id } ?: ALL.first()

    fun colors(id: String?, dark: Boolean): GriipColors = of(id).let { if (dark) it.dark else it.light }
}

/** Left-to-right accent gradient of a palette (highlights and accent text). */
fun GriipColors.accentBrush(): Brush = Brush.horizontalGradient(listOf(accentStart, accentEnd))

/** The header gradient (workspace name, search and filters sit on it). */
fun GriipColors.headerBrush(): Brush = Brush.horizontalGradient(listOf(heroStart, heroMid, heroEnd))
