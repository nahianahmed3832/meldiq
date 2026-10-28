package com.meldiq.android.ui.screens.profile

import com.meldiq.android.data.api.MutualCommunityDto
import com.meldiq.android.data.api.ProfileLinkDto
import com.meldiq.android.data.api.UserDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The profile card (as Meldiq Web's ProfileDialog, 2026-10-28): what it shows, from the profile alone. */
class ProfileCardRulesTest {
    private val u = UserDto(id = "u1", username = "nahian", displayName = "Nahian")

    @Test
    fun joinedHereIsTheCommunityItWasOpenedFrom() {
        val p = u.copy(mutualCommunities = listOf(MutualCommunityDto("o1", "GriipBuddy", null, 1_000), MutualCommunityDto("o2", "Lab", 5, 2_000)))
        assertEquals(2_000L, ProfileCardRules.joinedHere(p, "o2")?.joinedAt)
        assertNull(ProfileCardRules.joinedHere(p, "o3"))
        assertNull(ProfileCardRules.joinedHere(p, null))
        assertNull(ProfileCardRules.joinedHere(u, "o1"))
    }

    @Test
    fun theStatusIsEmojiThenText() {
        assertEquals("🥶 Cold", ProfileCardRules.statusLine(u.copy(statusEmoji = "🥶", statusText = "Cold")))
        assertEquals("Cold", ProfileCardRules.statusLine(u.copy(statusText = "Cold")))
        assertNull(ProfileCardRules.statusLine(u))
    }

    @Test
    fun onlyGoAndPlusAreMojoBadges() {
        assertEquals("Mojo Go", ProfileCardRules.mojoName("go"))
        assertEquals("Mojo Plus", ProfileCardRules.mojoName("plus"))
        assertNull(ProfileCardRules.mojoName("gold"))
        assertNull(ProfileCardRules.mojoName(null))
    }

    @Test
    fun onlyHttpsLinksAreShown() {
        val p = u.copy(links = listOf(ProfileLinkDto("Site", "https://meldiq.app"), ProfileLinkDto("Bad", "javascript:alert(1)"), ProfileLinkDto("Plain", "http://x.test")))
        assertEquals(listOf("Site"), ProfileCardRules.links(p).map { it.label })
    }
}
