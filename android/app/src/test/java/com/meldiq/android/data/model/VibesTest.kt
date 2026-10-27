package com.meldiq.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VibesTest {
    @Test
    fun `presets match Meldiq Web's twenty`() {
        assertEquals(20, Vibes.ALL.size)
        assertEquals(listOf("#6ee7b7", "#38bdf8"), Vibes.colors("mint-wave", null))
        assertNull(Vibes.colors(null, null))
        assertNull(Vibes.colors("not-a-vibe", null))
    }

    @Test
    fun `a custom theme needs two or three real colours`() {
        assertEquals(listOf("#ff0000", "#00ff00"), Vibes.colors(Vibes.CUSTOM, listOf("#ff0000", "#00ff00")))
        assertNull(Vibes.colors(Vibes.CUSTOM, listOf("#ff0000")))
        assertNull(Vibes.colors(Vibes.CUSTOM, listOf("#ff0000", "green")))
    }

    @Test
    fun `strength is kept in range and softer on light palettes`() {
        assertEquals(Vibes.STRENGTH_MIN, Vibes.strength(0))
        assertEquals(0.54f, Vibes.alpha(60, dark = true), 0.001f)
        assertEquals(0.168f, Vibes.alpha(60, dark = false), 0.001f)
    }
}
