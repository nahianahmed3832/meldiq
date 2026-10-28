package com.meldiq.android.ui.screens.you

import org.junit.Assert.assertEquals
import org.junit.Test

/** The user panel's microphone and headphones, in a call and for the next one (floating redesign, 2026-10-28). */
class UserPanelRulesTest {
    @Test
    fun inACallTheButtonsShowThatCall() {
        assertEquals(UserPanelRules.Audio(micOff = true, deafened = false), UserPanelRules.audio(true, callMicOn = false, callDeafened = false, joinMuted = false, joinDeafened = true))
        assertEquals(UserPanelRules.Audio(micOff = false, deafened = true), UserPanelRules.audio(true, callMicOn = true, callDeafened = true, joinMuted = true, joinDeafened = false))
    }

    @Test
    fun outsideACallTheyShowHowTheNextCallStarts() {
        assertEquals(UserPanelRules.Audio(micOff = false, deafened = false), UserPanelRules.audio(false, true, false, joinMuted = false, joinDeafened = false))
        assertEquals(UserPanelRules.Audio(micOff = true, deafened = false), UserPanelRules.audio(false, true, false, joinMuted = true, joinDeafened = false))
        // Deafened also means muted, as in a call.
        assertEquals(UserPanelRules.Audio(micOff = true, deafened = true), UserPanelRules.audio(false, true, false, joinMuted = false, joinDeafened = true))
    }

    @Test
    fun theMicrophoneTogglesAndUnmutingWhileDeafenedBringsTheSoundBack() {
        assertEquals(true to false, UserPanelRules.toggleJoinMic(joinMuted = false, joinDeafened = false))
        assertEquals(false to false, UserPanelRules.toggleJoinMic(joinMuted = true, joinDeafened = false))
        assertEquals(false to false, UserPanelRules.toggleJoinMic(joinMuted = true, joinDeafened = true))
    }
}
