package com.meldiq.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as Meldiq Web's `unread-markers` test. */
class UnreadRulesTest {
    @Test
    fun `nothing new or muted without a mention shows nothing`() {
        assertEquals(UnreadMarker.None, UnreadRules.marker(0, 0, muted = false))
        assertEquals(UnreadMarker.None, UnreadRules.marker(5, 0, muted = true))
        assertFalse(UnreadRules.marker(0, 0, muted = false).highlighted)
    }

    @Test
    fun `one unread channel message is a dot, two or more a light count`() {
        assertEquals(UnreadMarker.Dot, UnreadRules.marker(1, 0, muted = false))
        assertEquals(UnreadMarker.Count("2", direct = false), UnreadRules.marker(2, 0, muted = false))
        assertEquals(UnreadMarker.Count("99+", direct = false), UnreadRules.marker(140, 0, muted = false))
    }

    @Test
    fun `a DM shows its number from the first message`() {
        assertEquals(UnreadMarker.Count("1", direct = true), UnreadRules.marker(1, 0, muted = false, direct = true))
    }

    @Test
    fun `a mention wins, even when muted`() {
        assertEquals(UnreadMarker.Mention("@3"), UnreadRules.marker(10, 3, muted = true))
        assertTrue(UnreadRules.marker(0, 1, muted = false).highlighted)
    }
}
