package com.meldiq.android.data.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TwoStepRulesTest {
    @Test
    fun `six digits from an app are a code, with or without spaces`() {
        assertTrue(TwoStepRules.isCode("123456"))
        assertTrue(TwoStepRules.isCode(" 123 456 "))
        assertFalse(TwoStepRules.isCode("12345"))
        assertFalse(TwoStepRules.isCode("1234567"))
        assertFalse(TwoStepRules.isCode("12a456"))
    }

    @Test
    fun `a backup code is ten letters or digits, with its dash or without`() {
        assertTrue(TwoStepRules.isCode("abcde-fghjk"))
        assertTrue(TwoStepRules.isCode("ABCDEFGHJK"))
        assertFalse(TwoStepRules.isCode("ABCDE-FGHJ"))
        assertEquals("ABCDE-FGHJK", TwoStepRules.clean(" abcde-fghjk "))
    }
}
