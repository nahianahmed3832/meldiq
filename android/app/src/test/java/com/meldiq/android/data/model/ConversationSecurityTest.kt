package com.meldiq.android.data.model

import com.meldiq.android.data.model.ConversationSecurity.Facts
import com.meldiq.android.data.model.ConversationSecurity.Point
import com.meldiq.android.data.repo.SettingsStore
import com.meldiq.android.ui.theme.MeldiqPalettes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The conversation security panel says only what applies (round 6). */
class ConversationSecurityTest {
    private val dm = Facts(type = "DM", peerVerified = false, changedMembers = 0, otherServers = 0, callMediaE2ee = true)

    @Test
    fun `an unverified one-to-one chat lists encryption, verification and metadata`() {
        assertEquals(
            listOf(Point.MESSAGES, Point.FILES, Point.CALLS_E2EE, Point.NOT_VERIFIED, Point.METADATA),
            ConversationSecurity.points(dm),
        )
        assertFalse(ConversationSecurity.needsAttention(dm))
    }

    @Test
    fun `calls are only claimed end-to-end encrypted when the call setting is on`() {
        val points = ConversationSecurity.points(dm.copy(callMediaE2ee = false))
        assertTrue(Point.CALLS_TRANSPORT in points)
        assertFalse(Point.CALLS_E2EE in points)
    }

    @Test
    fun `a changed key comes first and turns the padlock to a warning`() {
        val f = dm.copy(changedMembers = 1)
        assertEquals(Point.KEYS_CHANGED, ConversationSecurity.points(f).first())
        assertTrue(ConversationSecurity.needsAttention(f))
    }

    @Test
    fun `channels mention app updates, other servers and per-member verification`() {
        val points = ConversationSecurity.points(Facts("CHANNEL", null, 0, otherServers = 2, callMediaE2ee = true))
        assertTrue(Point.APP_UPDATES in points)
        assertTrue(Point.OTHER_SERVERS in points)
        assertTrue(Point.VERIFY_MEMBERS in points)
        assertFalse(Point.NOT_VERIFIED in points)
    }

    @Test
    fun `a verified peer is shown as verified`() {
        assertTrue(Point.VERIFIED in ConversationSecurity.points(dm.copy(peerVerified = true)))
    }

    @Test
    fun `the design move keeps an explicit theme and replaces following the system with dark`() {
        assertEquals("DARK" to MeldiqPalettes.DEFAULT, SettingsStore.migratedDesign("SYSTEM"))
        assertEquals("DARK" to MeldiqPalettes.DEFAULT, SettingsStore.migratedDesign(null))
        assertEquals("LIGHT" to MeldiqPalettes.DEFAULT, SettingsStore.migratedDesign("LIGHT"))
        assertEquals("DARK" to MeldiqPalettes.DEFAULT, SettingsStore.migratedDesign("DARK"))
    }

    @Test
    fun `the 2026-10-28 move takes the old default palette to Meldiq and keeps any other choice`() {
        assertEquals("meldiq", SettingsStore.migratedPalette("graphite"))
        assertEquals("meldiq", SettingsStore.migratedPalette(null))
        assertEquals("sunset", SettingsStore.migratedPalette("sunset"))
    }
}
