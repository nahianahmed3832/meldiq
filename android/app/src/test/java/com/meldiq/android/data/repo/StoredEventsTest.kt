package com.meldiq.android.data.repo

import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.StoredEventDto
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.Payload
import com.meldiq.android.data.model.Poll
import com.meldiq.android.data.model.RichContent
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Server-stored messages (API 0.57.0): stored events as queue items, and the one-time import of the phone's history. */
class StoredEventsTest {
    private fun msg(id: String = "message-0001", serverTs: Long? = 2_000, kind: String = "text", deleted: Boolean = false) = MessageEntity(
        id = id, conversationId = "conv-1", senderUserId = "alice", senderDeviceId = "d1", outgoing = false, kind = kind, text = "hello",
        sentAt = 1_900, serverTs = serverTs, sortTs = serverTs ?: 1_900, status = "RECEIVED", deleted = deleted,
    )

    @Test
    fun aStoredEventBecomesTheQueueItemTheReceiverApplies() {
        val e = StoredEventDto(
            id = "message-0001", conversationId = "conv-1", senderUserId = "alice", senderDeviceId = null, cls = "message",
            payload = buildJsonObject { put("type", "text"); put("text", "hi") }, sentAt = 10, serverTs = 20, mentionAll = true,
        )
        val item = StoredEvents.queueItem(e, queueId = 7)
        assertEquals(7L, item.id)
        assertEquals("message", item.kind)
        assertEquals("message-0001", item.messageId)
        assertEquals("", item.senderDeviceId)
        assertEquals(20L, item.payload.serverTs)
        assertEquals(10L, item.payload.sentAt)
        assertEquals(true, item.payload.mentionAll)
        val noMention = StoredEvents.queueItem(e.copy(mentionAll = false))
        assertNull(noMention.payload.mentionAll)
    }

    @Test
    fun payloadsTravelAsTheJsonTheyUsedToEncrypt() {
        val o = StoredEvents.payloadObject(Payload(type = "reaction", target = "message-0001", emoji = "👍", add = true))
        assertEquals(JsonPrimitive("reaction"), o["type"])
        assertEquals(JsonPrimitive("👍"), o["emoji"])
        // Absent fields are left out, as the encrypted payloads did.
        assertTrue("text" !in o)
        assertEquals(GriipJson.decodeFromJsonElement(Payload.serializer(), o).target, "message-0001")
    }

    @Test
    fun aKeptMessageUploadsWithItsReactionsVotesClosingAndPin() {
        val rich = RichContent(poll = Poll(question = "Lunch?", options = emptyList()), votes = mapOf("bob" to listOf("a")), pollClosed = true)
        val m = msg().copy(
            reactionsJson = MessageColumns.encodeReactions(mapOf("👍" to listOf("bob", "carol"))), pinned = true, richJson = MessageColumns.encodeRich(rich),
        )
        val items = StoredEvents.importItemsOf(m)
        assertEquals(listOf("message", "control", "control", "control", "control", "control"), items.map { it.cls })
        assertEquals("message-0001", items[0].id)
        assertEquals(2_000L, items[0].serverTs)
        assertEquals(1_900L, items[0].sentAt)
        val types = items.drop(1).map { (it.payload["type"] as JsonPrimitive).content }
        assertEquals(listOf("reaction", "reaction", "vote", "poll_close", "pin"), types)
        // Every change points at its message and carries who made it.
        assertTrue(items.drop(1).all { (it.payload["target"] as JsonPrimitive).content == "message-0001" })
        assertEquals(listOf("bob", "carol", "bob", "alice", "alice"), items.drop(1).map { it.senderUserId })
        assertEquals(items.size, items.map { it.id }.toSet().size)
    }

    @Test
    fun deletedCallUnsentAndUndecryptableMessagesUploadNothing() {
        assertTrue(StoredEvents.importItemsOf(msg(deleted = true)).isEmpty())
        assertTrue(StoredEvents.importItemsOf(msg(kind = "call")).isEmpty())
        assertTrue(StoredEvents.importItemsOf(msg(kind = "undecryptable")).isEmpty())
        assertTrue(StoredEvents.importItemsOf(msg(serverTs = null)).isEmpty())
    }

    @Test
    fun idsTheServerWouldRefuseAreLeftOut() {
        assertTrue(StoredEvents.importItemsOf(msg(id = "short")).isEmpty())
        assertTrue(StoredEvents.importItemsOf(msg(id = "has space in it")).isEmpty())
    }

    @Test
    fun theUploadIsOldestFirst() {
        val items = StoredEvents.importItems(listOf(msg(id = "message-0002", serverTs = 3_000), msg(id = "message-0001", serverTs = 1_000)))
        assertEquals(listOf("message-0001", "message-0002"), items.map { it.id })
    }
}
