package com.meldiq.android.data.model

import com.meldiq.android.data.api.NavPrefsDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** API 0.46.0: a whole community muted for a while (as Meldiq Web's community menu). */
class CommunityMuteTest {
    private val now = 1_000_000L

    @Test
    fun `a running community mute silences every channel, its own levels included`() {
        val p = NavPrefsRules.apply(NavPrefsDto(notify = mapOf("c1" to NotifyLevel.ALL)), NavOp.CommunityMute(now + 60_000))
        assertEquals(NotifyLevel.NONE, NavPrefsRules.level(p, "c1", now = now))
        assertEquals(NotifyLevel.NONE, NavPrefsRules.level(p, "c2", now = now))
        assertEquals(now + 60_000, NavPrefsRules.communityMutedUntil(p, now))
    }

    @Test
    fun `an ended or cleared community mute gives the channels back their levels`() {
        val muted = NavPrefsRules.apply(NavPrefsDto(notify = mapOf("c1" to NotifyLevel.MENTIONS)), NavOp.CommunityMute(now + 60_000))
        assertEquals(NotifyLevel.MENTIONS, NavPrefsRules.level(muted, "c1", now = now + 60_001))
        val cleared = NavPrefsRules.apply(muted, NavOp.CommunityMute(0))
        assertNull(NavPrefsRules.communityMutedUntil(cleared, now))
        assertEquals(NotifyLevel.MENTIONS, NavPrefsRules.level(cleared, "c1", now = now))
    }

    @Test
    fun `the next look comes when the community mute ends`() {
        val p = NavPrefsRules.apply(NavPrefsDto(), NavOp.CommunityMute(now + 5_000))
        assertEquals(now + 5_000, MuteRules.nextExpiry(listOf(p), now))
    }
}
