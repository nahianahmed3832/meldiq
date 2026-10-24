package com.meldiq.android.data.ai

import com.meldiq.android.data.db.MessageEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Agents' posts among a conversation's messages, and agent suggestions while typing (as Meldiq Web). */
class AgentTimelineTest {
    private fun msg(id: String, at: Long) = MessageEntity(id, "c", "u", "d", false, "text", id, sentAt = at, sortTs = at, status = "RECEIVED")
    private fun post(id: String, at: Long, kind: String = "result", job: String? = "j1") = AiPost(id, "c", kind = kind, jobId = job, agent = AiPostAgent("agi", "Writer"), createdAt = at)
    private fun agent(name: String, activation: String = "mention", canInvoke: Boolean = true) = AiChannelAgent(id = name, agentId = "x", displayName = name, activation = activation, canInvoke = canInvoke)

    @Test
    fun `posts sit among messages by time, newest first`() {
        val out = AgentTimeline.merge(listOf(msg("m3", 30), msg("m2", 20), msg("m1", 10)), listOf(post("p1", 25), post("p0", 5)))
        // p0 is older than everything loaded: it waits until older messages are loaded.
        assertEquals(listOf("m3", "x-p1", "m2", "m1"), out.map { it.key })
        assertEquals(1, AgentTimeline.indexOfMessage(listOf(AgentTimeline.Entry.Post(post("p", 1)), AgentTimeline.Entry.Msg(msg("m", 1))), "m"))
        assertEquals(listOf("x-p"), AgentTimeline.merge(emptyList(), listOf(post("p", 1))).map { it.key })
    }

    @Test
    fun `a progress note goes once its request is answered`() {
        val posts = listOf(post("r", 1, "request"), post("g", 2, "progress"), post("a", 3, "result"), post("g2", 4, "progress", job = "j2"))
        assertEquals(listOf("r", "a", "g2"), AgentTimeline.chatPosts(posts).map { it.id })
    }

    @Test
    fun `agents are suggested after an at sign and as commands after a leading slash`() {
        val agents = listOf(agent("Writer"), agent("Reel Maker", "command"), agent("Locked", canInvoke = false))
        assertEquals(listOf("Writer"), AgentTimeline.suggest("hi @wr", 6, agents)?.agents?.map { it.displayName })
        val cmd = AgentTimeline.suggest("/reel", 5, agents)
        assertEquals(true, cmd?.command)
        assertEquals("/reel-maker " to 12, AgentTimeline.insert("/reel", 5, cmd!!, agents[1]))
        assertEquals("hi @Writer " to 11, AgentTimeline.insert("hi @wr", 6, AgentTimeline.suggest("hi @wr", 6, agents)!!, agents[0]))
        assertNull(AgentTimeline.suggest("mail@wr", 7, agents))
        assertNull(AgentTimeline.suggest("hi /wr", 6, agents))
        assertNull(AgentTimeline.suggest("@lo", 3, agents))
    }
}
