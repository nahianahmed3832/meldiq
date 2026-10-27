package com.meldiq.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccentRulesTest {
    @Test
    fun `only rrggbb is an accent`() {
        assertNull(AccentRules.colors(null))
        assertNull(AccentRules.colors("red"))
        assertNull(AccentRules.colors("#12345"))
        assertTrue(AccentRules.colors("#22D3EE") != null)
    }

    @Test
    fun `text on the accent and in it is always readable`() {
        for (hex in AccentRules.PRESETS + listOf("#777777", "#808000", "#ffff00", "#000080", "#ffffff", "#000000")) {
            val c = AccentRules.colors(hex)!!
            assertTrue("$hex label", AccentRules.contrast(c.on, c.fill) >= AccentRules.MIN_TEXT_CONTRAST)
            assertTrue("$hex on light", AccentRules.contrast(c.textLight, 0xFFFFFFFFL) >= AccentRules.MIN_TEXT_CONTRAST)
            assertTrue("$hex on dark", AccentRules.contrast(c.textDark, 0xFF10172BL) >= AccentRules.MIN_TEXT_CONTRAST)
        }
    }

    @Test
    fun `a bright accent gets dark text and a deep one white`() {
        assertEquals(0xFF0B1020L, AccentRules.onAccent(0xFFFACC15L))
        assertEquals(0xFFFFFFFFL, AccentRules.onAccent(0xFF1E3A8AL))
    }
}
