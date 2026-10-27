package com.meldiq.android.data.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReadRulesTest {
    @Test
    fun `receipts go out in DMs and small groups only`() {
        assertTrue(ReadRules.sendsReceipts("DM", 2, canPost = true))
        assertTrue(ReadRules.sendsReceipts("GROUP", 20, canPost = true))
        assertFalse(ReadRules.sendsReceipts("GROUP", 21, canPost = true))
        assertFalse(ReadRules.sendsReceipts("CHANNEL", 3, canPost = true))
        assertFalse(ReadRules.sendsReceipts("DM", 2, canPost = false))
    }

    @Test
    fun `a read elsewhere clears here only when nothing newer arrived`() {
        assertTrue(ReadRules.clearsHere(upTo = 100, latestIncoming = null))
        assertTrue(ReadRules.clearsHere(upTo = 100, latestIncoming = 100))
        assertFalse(ReadRules.clearsHere(upTo = 100, latestIncoming = 101))
    }
}
