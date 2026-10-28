package com.meldiq.android.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** The Meldiq presets (2026-10-19): readable text, badges and controls in every preset, light and dark (WCAG 2.2). */
class MeldiqPalettesTest {
    private fun channel(v: Float): Double = if (v <= 0.03928f) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)

    private fun luminance(c: Color): Double = 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun assertContrast(name: String, fg: Color, bg: Color, minimum: Double) {
        val ratio = contrast(fg, bg)
        assertTrue("$name is %.2f:1, needs %.1f:1".format(ratio, minimum), ratio >= minimum)
    }

    private fun assertReadable(palette: String, c: GriipColors) {
        val text = 4.5
        assertContrast("$palette primary text", c.textPrimary, c.background, 7.0)
        for ((surfaceName, surface) in listOf("page" to c.background, "cards" to c.surface, "inputs" to c.surfaceVariant, "header start" to c.heroStart, "header end" to c.heroEnd)) {
            assertContrast("$palette primary text on $surfaceName", c.textPrimary, surface, text)
            assertContrast("$palette secondary text on $surfaceName", c.textSecondary, surface, text)
            assertContrast("$palette tertiary text on $surfaceName", c.textTertiary, surface, text)
        }
        // The search field on the header is translucent white: check it over both ends of the gradient.
        assertContrast("$palette search placeholder (start)", c.textSecondary, c.headerField.compositeOver(c.heroStart), text)
        assertContrast("$palette search placeholder (end)", c.textSecondary, c.headerField.compositeOver(c.heroEnd), text)
        // A poll option's text over its vote-share tint (Polls.kt: the primary colour at 30% over the option's fill).
        assertContrast("$palette poll option on its share", c.textPrimary, c.primary.copy(alpha = 0.30f).compositeOver(c.surfaceVariant), text)
        assertContrast("$palette links and focus", c.primary, c.background, text)
        assertContrast("$palette links on cards", c.primary, c.surface, text)
        assertContrast("$palette text on primary", c.onPrimary, c.primary, text)
        assertContrast("$palette button label", c.onAction, c.actionStart, text)
        assertContrast("$palette accent label (start)", c.onAccent, c.accentStart, text)
        assertContrast("$palette accent label (end)", c.onAccent, c.accentEnd, text)
        assertContrast("$palette accent text (start)", c.accentStart, c.background, text)
        assertContrast("$palette accent text (end)", c.accentEnd, c.background, text)
        assertContrast("$palette unread count", c.onBadge, c.badge, text)
        assertContrast("$palette unread count against its row", c.badge, c.surface, 3.0)
        assertContrast("$palette your message text", c.onBubbleOutgoing, c.bubbleOutgoing, text)
        assertContrast("$palette your message time", c.bubbleOutgoingMeta, c.bubbleOutgoing, text)
        assertContrast("$palette selected tab label", c.textPrimary, c.navIndicator, text)
        assertContrast("$palette error text", c.danger, c.background, text)
        assertContrast("$palette error banner", c.danger, c.dangerSoft, text)
        assertContrast("$palette warning banner", c.warning, c.warningSoft, text)
        assertContrast("$palette success text", c.success, c.background, text)
        assertContrast("$palette success banner", c.success, c.successSoft, text)
        // Input boundaries are user-interface components: 3:1 against what surrounds them and what fills them.
        assertContrast("$palette input outline on the page", c.outline, c.background, 3.0)
        assertContrast("$palette input outline on its fill", c.outline, c.surface, 3.0)
    }

    @Test
    fun everyPresetIsReadableInLightAndDarkMode() {
        assertEquals(listOf("meldiq", "midnight", "graphite", "aurora", "sunset", "meadow"), MeldiqPalettes.ALL.map { it.id })
        MeldiqPalettes.ALL.forEach { p ->
            assertReadable("${p.label} light", p.light)
            assertReadable("${p.label} dark", p.dark)
            assertTrue(!p.light.isDark && p.dark.isDark)
        }
    }

    @Test
    fun meldiqIsTheDefaultAndUnknownIdsFallBackToIt() {
        assertEquals("meldiq", MeldiqPalettes.DEFAULT)
        assertEquals(MeldiqPalettes.ALL.first(), MeldiqPalettes.of(null))
        assertEquals(MeldiqPalettes.ALL.first(), MeldiqPalettes.of("orbit")) // an older accent id
        assertEquals(LightColors, MeldiqPalettes.colors("meldiq", dark = false))
        assertEquals(DarkColors, MeldiqPalettes.colors("meldiq", dark = true))
        // As Meldiq Web's floating redesign (2026-10-28): near-black frame, charcoal panels, one lime with near-black
        // text on it, pink only for mentions.
        val d = MeldiqPalettes.of("meldiq").dark
        assertEquals(Color(0xFF040404), d.background)
        assertEquals(Color(0xFF141414), d.surface)
        assertEquals(Color(0xFFF4FFAC), d.actionStart)
        assertEquals(Color(0xFF0B0B0B), d.onAction)
        assertEquals(Color(0xFFFF5C93), d.mention)
        val l = MeldiqPalettes.of("meldiq").light
        assertEquals(Color(0xFFD4EE4E), l.actionStart)
        assertEquals(Color(0xFF4D5C00), l.primary)
        // The navy look stays selectable as Midnight.
        assertEquals(Color(0xFF0B1020), MeldiqPalettes.of("midnight").dark.background)
        assertEquals(Color(0xFFFF5FA8), MeldiqPalettes.of("midnight").dark.badge)
    }

    @Test
    fun mentionsAreReadableInEveryPreset() {
        MeldiqPalettes.ALL.forEach { p ->
            for (c in listOf(p.light, p.dark)) {
                assertContrast("${p.label} mention count", c.onMention, c.mention, 4.5)
                assertContrast("${p.label} mention against its row", c.mention, c.surface, 3.0)
            }
        }
    }

    @Test
    fun graphiteDarkIsCharcoalWithSeparatedSurfacesAndAFlatHeader() {
        val d = MeldiqPalettes.of("graphite").dark
        // Charcoal, not pure black; bars, cards and inputs each a step apart.
        assertNotEquals(Color.Black, d.background)
        assertTrue(luminance(d.background) < luminance(d.surface))
        assertTrue(luminance(d.surface) < luminance(d.surfaceVariant))
        assertTrue("cards stand apart from the page", contrast(d.surface, d.background) >= 1.1)
        // No decorative gradients: one header colour and one accent colour.
        assertEquals(d.heroStart, d.heroEnd)
        assertEquals(d.accentStart, d.accentEnd)
        assertEquals(d.actionStart, d.actionEnd)
    }

    @Test
    fun presetsChangeTheWholePaletteNotSingleColours() {
        val aurora = MeldiqPalettes.of("aurora").light
        val sunset = MeldiqPalettes.of("sunset").light
        val meadow = MeldiqPalettes.of("meadow").light
        assertNotEquals(aurora.actionStart, sunset.actionStart)
        assertNotEquals(aurora.heroStart, meadow.heroStart)
        assertNotEquals(sunset.badge, meadow.badge)
        assertNotEquals(aurora.background, sunset.background) // tinted neutrals follow the preset
        // The logo's navy is Aurora's dark ground.
        assertEquals(Color(0xFF0A0E27), MeldiqPalettes.of("aurora").dark.background)
    }
}
