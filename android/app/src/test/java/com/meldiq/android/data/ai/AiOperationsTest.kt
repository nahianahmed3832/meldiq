package com.meldiq.android.data.ai

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Trigger schedules, skill limits, task actions and reader choices as the settings and screens read them. */
class AiOperationsTest {
    @Test
    fun `a schedule reads with defaults`() {
        val s = AiTriggerRules.schedule(JsonObject(mapOf("every" to JsonPrimitive("week"), "at" to JsonPrimitive("08:30"), "weekday" to JsonPrimitive(3), "timeZone" to JsonPrimitive("Asia/Dhaka"))))
        assertEquals(AiTriggerRules.Schedule("week", "08:30", 3, "Asia/Dhaka"), s)
        assertEquals(AiTriggerRules.Schedule("day", "09:00", 1, "UTC"), AiTriggerRules.schedule(null))
        assertEquals(6, AiTriggerRules.schedule(JsonObject(mapOf("weekday" to JsonPrimitive(9)))).weekday)
    }

    @Test
    fun `skill limits need both numbers`() {
        assertEquals(120 to 3, AiTriggerRules.skillLimits(mapOf("maxRuntimeSec" to JsonPrimitive(120), "maxAttempts" to JsonPrimitive(3))))
        assertNull(AiTriggerRules.skillLimits(mapOf("maxRuntimeSec" to JsonPrimitive(120))))
    }

    @Test
    fun `task actions ask for what they need`() {
        val task = AiTask("t", "T", "in_progress", assignee = AiPerson("a", "A"), createdBy = AiPerson("b", "B"), rev = 4)
        assertTrue(AiTaskStates.needsForm(AiTaskStates.SUBMIT))
        assertFalse(AiTaskStates.needsForm(AiTaskStates.ACCEPT))
        assertFalse(AiTaskStates.formReady(AiTaskStates.BLOCK, " ", 0, null))
        assertTrue(AiTaskStates.formReady(AiTaskStates.SUBMIT, "", 1, null))
        assertFalse(AiTaskStates.formReady(AiTaskStates.REASSIGN, "", 0, null))
        assertEquals(AiTaskActionReq(rev = 4, note = "done", fileIds = listOf("f")), AiTaskStates.body(task, AiTaskStates.SUBMIT, " done ", listOf("f"), null))
        assertEquals(AiTaskActionReq(rev = 4, reason = "why"), AiTaskStates.body(task, AiTaskStates.RETURN, "why", emptyList(), null))
        assertEquals(AiTaskActionReq(rev = 4, assigneeId = "c"), AiTaskStates.body(task, AiTaskStates.REASSIGN, "", emptyList(), "c"))
        assertEquals(listOf("accept", "submit"), AiTaskActions(accept = true, submit = true).allowed())
    }

    @Test
    fun `reader choices`() {
        fun r(id: String, mode: String, choice: String?) = AiReaderView(id, "o", "agi_$id", name = id, conversationId = "c", mode = mode, myChoice = choice)
        val v = AiConversationReaders(true, listOf(r("a", "channel", null), r("b", "channel", "share"), r("d", "direct", "share")))
        assertEquals(listOf("a"), v.pending.map { it.readerId })
        assertEquals("d", v.direct?.readerId)
        assertEquals(setOf("b", "d"), v.sharingReaders)
        assertEquals(setOf("agi_b", "agi_d"), v.sharingAgents)
        assertTrue(v.copy(readingEnabled = false).pending.isEmpty())
    }
}
