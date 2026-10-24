package com.meldiq.android.data.ai

import com.meldiq.android.data.db.MessageEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import java.io.File

/** The AI Workforce rules the app applies before the server (as Meldiq Web's agentRules). */
class AgentRulesTest {
    private fun agent(id: String, name: String, activation: String = "mention", canInvoke: Boolean = true) =
        AiChannelAgent(id = id, agentId = "x", displayName = name, activation = activation, canInvoke = canInvoke)

    private fun msg(id: String, at: Long, text: String, kind: String = "text", deleted: Boolean = false, thread: String? = null, from: String = "u1") =
        MessageEntity(id, "c", from, "d", false, kind, text, threadRootId = thread, sentAt = at, sortTs = at, status = "RECEIVED", deleted = deleted)

    @Test
    fun `command names are plain lowercase words joined by dashes`() {
        assertEquals("reel-maker", AgentRules.commandName("Reel Maker"))
        assertEquals("cafe-bot", AgentRules.commandName("Café  Bot!"))
    }

    /** The server's cases (shared/contracts/fixtures/rules), which its channel readers and Meldiq Web pass too. */
    @Test
    fun `a message calls an agent as the server decides it`() {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "shared/contracts/fixtures/rules/agent-invocation.json") }
            .firstOrNull { it.isFile } ?: error("shared/contracts/fixtures/rules/agent-invocation.json not found")
        val shared = Json.parseToJsonElement(file.readText()).jsonObject
        val agents = shared.getValue("agents").jsonArray.map {
            val o = it.jsonObject
            agent(o.str("id"), o.str("displayName"), o.str("activation"))
        }
        val cases = shared.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val want = c["expect"]?.takeUnless { it is JsonNull }?.jsonObject
            val got = AgentRules.invocation(c.str("text"), agents)
            assertEquals(c.str("why"), want?.let { it.str("installId") to it.str("brief") }, got?.let { it.installId to it.brief })
        }
    }

    @Test
    fun `an invocation keeps the agent's name and whether the person may ask`() {
        val agents = listOf(agent("b", "Reel Maker"), agent("c", "Writer", "command", canInvoke = false))
        assertEquals(AgentRules.Invocation("b", "Reel Maker", "cut a 30s clip", true), AgentRules.invocation("@reel maker, cut a 30s clip", agents))
        assertEquals(AgentRules.Invocation("c", "Writer", "a post", false), AgentRules.invocation("/writer a post", agents))
        assertNull(AgentRules.invocation("@Reel Maker2 hi", agents))
    }

    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content

    @Test
    fun `sharing takes the newest readable messages oldest first within the limits`() {
        val names = mapOf("u1" to "Ana", "u2" to "Bo")
        val list = listOf(
            msg("1", 1, "first"), msg("2", 2, "call", kind = "call"), msg("3", 3, "gone", deleted = true),
            msg("4", 4, "in a thread", thread = "1"), msg("5", 5, "  second  ", from = "u2"), msg("6", 6, "third"),
        ).shuffled()
        val shared = AgentRules.messagesToShare(list, { names[it] ?: "" }, 2)
        assertEquals(listOf("second", "third"), shared.map { it.text })
        assertEquals("Bo", shared.first().author)
        assertEquals(3, AgentRules.messagesToShare(list, { names[it] ?: "" }, 150).size)
        assertTrue(AgentRules.messagesToShare(list, { "" }, 0).isEmpty())
        // Long messages are cut, and the total stops at the server's character limit.
        val big = (1..40).map { msg("m$it", it.toLong(), "x".repeat(5000)) }
        val capped = AgentRules.messagesToShare(big, { "A" }, 150)
        assertTrue(capped.all { it.text.length == AgentRules.SHARE_MESSAGE_CHARS })
        assertTrue(capped.sumOf { it.text.length + it.author.length + 2 } <= AgentRules.SHARE_CHARS)
    }

    @Test
    fun `share choices grow only while there are more messages`() {
        assertEquals(listOf(20), AgentRules.shareChoices(5))
        assertEquals(listOf(20, 50), AgentRules.shareChoices(30))
        assertEquals(listOf(20, 50, 150), AgentRules.shareChoices(400))
    }

    @Test
    fun `files are checked against the agent's limits`() {
        val limits = AiFileLimits(min = 1, max = 2, maxBytes = 100, types = listOf("text/csv"))
        val csv = AgentRules.PickedFile("a.csv", "text/csv", 10)
        assertNull(AgentRules.fileProblem(listOf(csv), limits))
        assertEquals(AgentRules.FileProblem.TooFew(1, listOf("text/csv")), AgentRules.fileProblem(emptyList(), limits))
        assertEquals(AgentRules.FileProblem.TooMany(2), AgentRules.fileProblem(listOf(csv, csv, csv), limits))
        assertEquals(AgentRules.FileProblem.WrongKind("p.png"), AgentRules.fileProblem(listOf(AgentRules.PickedFile("p.png", "image/png", 1)), limits))
        assertEquals(AgentRules.FileProblem.TooLarge("b.csv"), AgentRules.fileProblem(listOf(csv.copy(name = "b.csv", size = 101)), limits))
        assertEquals("text/csv", AgentRules.mimeOf("data.CSV", null))
        assertEquals("application/x-subrip", AgentRules.mimeOf("cues.srt", "application/octet-stream"))
        assertEquals("image/heic", AgentRules.mimeOf("x.heic", "image/heic"))
    }

    @Test
    fun `who steers and who approves`() {
        val job = AiJobDetail("j", AiJobAgent("i", "a", displayName = "A"), state = "awaiting_approval", requestedBy = "me")
        val none = AiPermissions()
        assertTrue(AgentRules.maySteer(job, "me", none))
        assertEquals(false, AgentRules.maySteer(job, "other", none))
        assertTrue(AgentRules.maySteer(job, "other", AiPermissions(canManage = true)))
        assertTrue(AgentRules.mayApprove(job, "other", AiPermissions(canApprove = true)))
        assertEquals(false, AgentRules.mayApprove(job, "other", none))
        assertEquals(0xFF5B5BD6, AgentRules.hexColor("#5B5BD6"))
        assertNull(AgentRules.hexColor("blue"))
    }

    @Test
    fun `job states`() {
        assertTrue(AiJobStates.active("awaiting_input"))
        assertEquals(false, AiJobStates.showsProgress("awaiting_approval"))
        assertTrue(AiJobStates.canRetry("failed", null))
        assertEquals(false, AiJobStates.canRetry("failed", "parent"))
        assertEquals(false, AiJobStates.canRetry("completed", null))
    }
}
