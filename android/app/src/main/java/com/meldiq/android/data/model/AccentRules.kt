package com.meldiq.android.data.model

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * A community's accent colour (API 0.44.0, docs/COMMUNITY_BRANDING.md) made safe to use, as Meldiq Web's
 * `ui/community/accent.ts`: whatever colour was picked, text in it stays readable on Meldiq's light and dark surfaces,
 * and text on it is black or white, whichever reads better. Only `#rrggbb` is accepted; anything else means Meldiq's own
 * theme. Colours are ARGB longs (opaque), so this stays plain Kotlin and unit-tested.
 */
object AccentRules {
    /** Suggested accents (Meldiq's palette, bright enough for both themes), offered first in Community settings. */
    val PRESETS = listOf("#22d3ee", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#facc15", "#22c55e", "#14b8a6")

    private const val WHITE = 0xFFFFFFFFL
    private const val BLACK = 0xFF000000L
    /** The dark text black-on-accent uses (Meldiq's navy), and the surfaces accent text has to read on. */
    private const val NAVY = 0xFF0B1020L
    private const val LIGHT_SURFACE = 0xFFFFFFFFL
    private const val DARK_SURFACE = 0xFF10172BL
    /** WCAG AA for normal text. */
    const val MIN_TEXT_CONTRAST = 4.5
    private const val STEP = 0.05

    /** [fill]: the colour as picked (a mid-tone nudged until its label reads): fills, bars, rings. */
    data class Colors(val fill: Long, val on: Long, val textLight: Long, val textDark: Long) {
        fun text(dark: Boolean): Long = if (dark) textDark else textLight
    }

    fun colors(hex: String?): Colors? {
        val picked = LookRules.argb(hex) ?: return null
        val on = onAccent(picked)
        // A mid-tone reads poorly with black and white alike: deepen (or lighten) it just enough for its label.
        val fill = readableAgainst(picked, on, if (on == WHITE) BLACK else WHITE)
        return Colors(fill, on, readableAgainst(fill, LIGHT_SURFACE, BLACK), readableAgainst(fill, DARK_SURFACE, WHITE))
    }

    /** White or Meldiq's navy, whichever reads better on [argb]. */
    fun onAccent(argb: Long): Long = if (contrast(argb, WHITE) >= contrast(argb, NAVY)) WHITE else NAVY

    fun luminance(argb: Long): Double {
        fun ch(shift: Int): Double {
            val s = ((argb shr shift) and 0xFF) / 255.0
            return if (s <= 0.03928) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
    }

    fun contrast(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    fun mix(a: Long, b: Long, t: Double): Long {
        fun ch(v: Long, shift: Int) = ((v shr shift) and 0xFF).toDouble()
        fun at(shift: Int) = (ch(a, shift) + (ch(b, shift) - ch(a, shift)) * t).let { Math.round(it).coerceIn(0, 255) }
        return BLACK or (at(16) shl 16) or (at(8) shl 8) or at(0)
    }

    /** [argb] moved towards [toward] just enough to reach [minimum] contrast against [surface]. */
    private fun readableAgainst(argb: Long, surface: Long, toward: Long, minimum: Double = MIN_TEXT_CONTRAST): Long {
        var t = 0.0
        while (t <= 1.0 + 1e-9) {
            val c = mix(argb, toward, t)
            if (contrast(c, surface) >= minimum) return c
            t += STEP
        }
        return toward
    }
}
