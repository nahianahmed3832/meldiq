package com.meldiq.android.data.account

import com.meldiq.android.data.api.GriipJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountSafetyRulesTest {
    @Test
    fun `a bug report needs a summary and details within the server's limits`() {
        assertFalse(StandingRules.canReport("abc", "long enough details"))
        assertFalse(StandingRules.canReport("Crash", "too short"))
        assertTrue(StandingRules.canReport("Crash on open", "It closes when I open a channel."))
        assertFalse(StandingRules.canReport("x".repeat(121), "It closes when I open a channel."))
    }

    @Test
    fun `the authenticator key is shown in groups of four`() {
        assertEquals("JBSW Y3DP EHPK 3PXP", StandingRules.grouped("JBSWY3DPEHPK3PXP"))
    }

    @Test
    fun `standing and two-step status decode as the server sends them`() {
        val s = GriipJson.decodeFromString(Standing.serializer(), """{"level":"limited","warnings":[{"id":"w1","reason":"Spam","createdAt":1,"expiresAt":2}]}""")
        assertEquals(StandingRules.LIMITED, s.level)
        assertEquals("Spam", s.warnings.single().reason)
        val t = GriipJson.decodeFromString(TotpStatus.serializer(), """{"available":true,"enabled":false,"enabledAt":null,"backupCodesLeft":0}""")
        assertTrue(t.available)
        assertFalse(t.enabled)
    }
}
