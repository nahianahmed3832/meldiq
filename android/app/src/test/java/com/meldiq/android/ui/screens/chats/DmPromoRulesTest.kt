package com.meldiq.android.ui.screens.chats

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Meldiq invitation in Messages (floating redesign, 2026-10-28): a link to Meldiq and the username to add you by. */
class DmPromoRulesTest {
    @Test
    fun linksToTheWebApp() {
        assertEquals("https://web.meldiq.app", DmPromoRules.MELDIQ_URL)
    }

    @Test
    fun theUsernameIsSharedWithoutItsAtSign() {
        assertEquals("nahian", DmPromoRules.handle("nahian"))
        assertEquals("nahian", DmPromoRules.handle(" @nahian "))
        assertNull(DmPromoRules.handle(null))
        assertNull(DmPromoRules.handle("  "))
        assertNull(DmPromoRules.handle("@"))
    }
}
