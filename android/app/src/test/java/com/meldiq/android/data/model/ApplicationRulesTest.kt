package com.meldiq.android.data.model

import com.meldiq.android.data.api.CommunityPreviewRes
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.model.ApplicationRules.Offer
import com.meldiq.android.ui.scan.InviteCodes
import com.meldiq.android.ui.screens.profile.ProfileInvite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Batch B4b: join applications, activity alerts in the community summary, and inviting from a profile. */
class ApplicationRulesTest {
    @Test
    fun `questions are trimmed, blanks dropped, and kept within the server's limits`() {
        val q = ApplicationRules.cleanQuestions(listOf("  Why?  ", "", "x".repeat(300), "a", "b", "c", "d"))
        assertEquals(5, q?.size)
        assertEquals("Why?", q?.first())
        assertEquals(200, q?.get(1)?.length)
        assertNull(ApplicationRules.cleanQuestions(listOf(" ", "")))
    }

    @Test
    fun `an application needs an answer to every question`() {
        val q = listOf("Why?", "Where from?")
        assertFalse(ApplicationRules.complete(q, listOf("because", " ")))
        assertFalse(ApplicationRules.complete(q, listOf("because")))
        assertTrue(ApplicationRules.complete(q, listOf("because", "a friend")))
        assertEquals(1000, ApplicationRules.cleanAnswers(listOf("y".repeat(1200))).single().length)
    }

    @Test
    fun `the preview offers waiting, applying, joining or asking for an invite`() {
        assertEquals(Offer.Waiting, ApplicationRules.offer(true, "pending", openJoin = true))
        assertEquals(Offer.Apply, ApplicationRules.offer(true, "denied", openJoin = true))
        assertEquals(Offer.Apply, ApplicationRules.offer(true, null, openJoin = false))
        assertEquals(Offer.Join, ApplicationRules.offer(false, "withdrawn", openJoin = true))
        assertEquals(Offer.AskForInvite, ApplicationRules.offer(false, null, openJoin = false))
    }

    @Test
    fun `the community summary and preview read the new fields and default without them`() {
        val org = GriipJson.decodeFromString(OrgDto.serializer(), """{"id":"o1","name":"Lab","joinQuestions":["Why?"],"activityAlerts":false,"activityAlert":{"kind":"joins","count":12,"at":5}}""")
        assertEquals(listOf("Why?"), org.joinQuestions)
        assertFalse(org.activityAlerts)
        assertEquals(12, org.activityAlert?.count)
        val old = GriipJson.decodeFromString(OrgDto.serializer(), """{"id":"o1","name":"Lab"}""")
        assertNull(old.joinQuestions)
        assertTrue(old.activityAlerts)
        val p = GriipJson.decodeFromString(CommunityPreviewRes.serializer(), """{"community":{"id":"o1","name":"Lab"},"application":{"id":"a1","status":"pending","createdAt":3}}""")
        assertEquals("pending", p.application?.status)
    }

    @Test
    fun `a profile invite is one use for a week, offered only where you're not a guest, and sends the https link`() {
        val orgs = listOf(OrgDto("o2", "beta", myRole = "MEMBER"), OrgDto("o1", "Alpha", myRole = "OWNER"), OrgDto("o3", "Guest", myRole = "GUEST"))
        assertEquals(listOf("o1", "o2"), ProfileInvite.offered(orgs).map { it.id })
        assertEquals(1, ProfileInvite.USES)
        assertEquals(168, ProfileInvite.HOURS)
        assertEquals("Alpha: https://web.meldiq.app/invite/ABCD-EFGH-JKLM", ProfileInvite.message("Alpha", InviteCodes.link("ABCD-EFGH-JKLM")))
    }
}
