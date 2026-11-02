package com.meldiq.android.ui.screens.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AttachPanelTextTest {
    private val mb = 1024L * 1024

    @Test
    fun `the limit shown is the server's, not a fixed 25 MB`() {
        assertEquals(
            "Up to 10 at once, 1 GB per file on this server. Photos and videos are optimized by default. Select Original file to send unchanged.",
            AttachPanelText.limits(1024 * mb),
        )
        assertEquals(
            "Up to 10 at once, 25 MB per file on this server. Photos and videos are optimized by default. Select Original file to send unchanged.",
            AttachPanelText.limits(25 * mb),
        )
    }

    @Test
    fun `only a server still at 25 MB gets the compress hint`() {
        assertNotNull(AttachPanelText.smallServerHint(25 * mb))
        assertNull(AttachPanelText.smallServerHint(500 * mb))
        assertNull(AttachPanelText.smallServerHint(1024 * mb))
    }
}
