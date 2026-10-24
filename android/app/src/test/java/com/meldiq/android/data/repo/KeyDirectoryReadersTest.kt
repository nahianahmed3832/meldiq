package com.meldiq.android.data.repo

import com.meldiq.android.crypto.LocalKeys
import com.meldiq.android.crypto.b64
import com.meldiq.android.data.ai.AiConversationReaders
import com.meldiq.android.data.ai.AiReaderView
import com.meldiq.android.data.ai.ReaderRules
import com.meldiq.android.data.api.AgentReaderKey
import com.meldiq.android.data.api.DeviceKeyDto
import com.meldiq.android.data.api.UserKeysDto
import com.meldiq.android.data.db.UserEntity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AI readers (API 0.40.0): an agent's device in a conversation is never a recipient by default; a message goes to it
 * only when its sender chose to share, and only for text messages and their edits and deletes (as Meldiq Web).
 */
class KeyDirectoryReadersTest {
    private class Account(val userId: String, val deviceId: String, val agent: AgentReaderKey? = null, val keys: LocalKeys = LocalKeys.generate()) {
        fun served(identity: LocalKeys = keys) = UserKeysDto(
            userId, identity.identityPublic.b64(),
            listOf(DeviceKeyDto(deviceId, identity.deviceSignPublic.b64(), identity.deviceEncPublic, identity.deviceCertificate())),
            agent = agent,
        )
    }

    private class FakeServer : KeySource {
        var keys: List<UserKeysDto> = emptyList()
        var choices = AiConversationReaders()
        var asked = 0
        override suspend fun conversationKeys(conversationId: String) = keys
        override suspend fun userKeys(userId: String) = keys.firstOrNull { it.userId == userId }
        override suspend fun readerChoices(conversationId: String) = choices.also { asked++ }
        override suspend fun chooseReader(conversationId: String, readerId: String, choice: String) =
            choices.copy(readers = choices.readers.map { if (it.readerId == readerId) it.copy(myChoice = choice) else it }).also { choices = it }
    }

    private class FakePins : PinStore {
        val rows = HashMap<String, UserEntity>()
        override suspend fun get(userId: String) = rows[userId]
        override suspend fun upsert(u: UserEntity) { rows[u.id] = u }
    }

    private val me = Account("u_me", "d_me")
    private val bob = Account("u_bob", "d_bob")
    private val bot = Account("u_bot", "d_reader", AgentReaderKey("agi_1", "rdr_1", "Writer"))
    private val server = FakeServer().apply { keys = listOf(me.served(), bob.served(), bot.served()) }
    private val dir = KeyDirectory(server, FakePins())

    private fun reader(choice: String?) = AiReaderView("rdr_1", "o_1", "agi_1", "u_bot", "Writer", "c1", mode = "channel", myChoice = choice)

    @Test
    fun `a reader is never an ordinary recipient or member`() = runTest {
        assertEquals(listOf("d_bob"), dir.conversationRecipients("c1", me.deviceId, force = true).map { it.deviceId })
        assertEquals(listOf("u_me", "u_bob"), dir.conversationMemberIds("c1"))
        assertEquals(listOf("d_reader"), dir.conversationReaders("c1", force = false).map { it.device.deviceId })
    }

    @Test
    fun `a message goes to a reader only when this person shares with it`() = runTest {
        val readers = dir.conversationReaders("c1", force = true)
        for ((choice, expected) in listOf(null to emptyList(), "keep" to emptyList(), "share" to listOf("d_reader"))) {
            val choices = AiConversationReaders(readingEnabled = true, readers = listOf(reader(choice)))
            assertEquals("choice $choice", expected, ReaderRules.pick(readers, { it.readerId }, choices).map { it.device.deviceId })
        }
        // The platform switched reading off: nothing is shared, whatever was chosen.
        assertTrue(ReaderRules.pick(readers, { it.readerId }, AiConversationReaders(readingEnabled = false, readers = listOf(reader("share")))).isEmpty())
    }

    @Test
    fun `only text messages and their edits and deletes are shareable`() {
        assertTrue(ReaderRules.shareable("message", "text"))
        assertTrue(ReaderRules.shareable("control", "edit"))
        assertTrue(ReaderRules.shareable("control", "delete"))
        for ((cls, type) in listOf("message" to "call_invite", "control" to "reaction", "control" to "read", "control" to "pin", "message" to null)) assertFalse("$cls/$type", ReaderRules.shareable(cls, type))
    }

    @Test
    fun `a reader whose identity changed is left out without pausing the conversation`() = runTest {
        dir.conversationReaders("c1", force = true) // pins the bot's identity
        server.keys = listOf(me.served(), bob.served(), bot.served(identity = LocalKeys.generate()))
        assertTrue(dir.conversationReaders("c1", force = true).isEmpty())
        assertEquals(listOf("d_bob"), dir.conversationRecipients("c1", me.deviceId, force = true).map { it.deviceId })
    }

    @Test
    fun `choices are cached and a choice made here is used at once`() = runTest {
        server.choices = AiConversationReaders(readingEnabled = true, readers = listOf(reader(null)))
        assertTrue(dir.readerChoices("c1").pending.isNotEmpty())
        dir.readerChoices("c1")
        assertEquals(1, server.asked)
        dir.chooseReader("c1", "rdr_1", "share")
        assertEquals(setOf("rdr_1"), dir.readerChoices("c1").sharingReaders)
        dir.invalidate("c1")
        dir.readerChoices("c1")
        assertEquals(2, server.asked)
    }
}
