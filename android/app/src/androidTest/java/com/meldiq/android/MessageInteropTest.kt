package com.meldiq.android

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.MessageStatus
import com.meldiq.android.data.repo.ProfileStorage
import com.meldiq.android.di.AppContainer
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Exercises ordinary Android messages against the same store-only API and payloads used by Meldiq Web. */
@RunWith(AndroidJUnit4::class)
class MessageInteropTest {
    private lateinit var container: AppContainer
    private lateinit var fixture: ApiClient

    @Before fun setUp() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val api = args.getString("interopApi")
        val peer = args.getString("interopFixture")
        assumeTrue("Needs the local interoperability fixture", api != null && peer != null)
        val name = "msginterop" + UUID.randomUUID().toString().replace("-", "").take(10)
        container = AppContainer(ApplicationProvider.getApplicationContext<Application>(), ProfileStorage.of(name), api!!)
        container.settings.update { it.copy(backgroundConnection = false) }
        fixture = ApiClient({ peer!! }, { null }, { false })
        container.session.register(api, name, "Android messaging test", 0)
    }

    @After fun tearDown() { if (::container.isInitialized) container.close() }

    private suspend fun prepare(community: Boolean): Pair<String, String> {
        val prepared = fixture.post<JsonObject, JsonObject>("/prepare", buildJsonObject {
            put("userId", container.session.session!!.userId); put("community", community)
        })
        prepared["inviteCode"]?.jsonPrimitive?.contentOrNull?.let { code ->
            container.api.post<JsonObject, JsonObject>("/v1/invites/accept", buildJsonObject { put("code", code) })
        }
        val cid = prepared.getValue("conversationId").jsonPrimitive.content
        container.conversations.refreshOne(cid)
        return prepared.getValue("id").jsonPrimitive.content to cid
    }

    private suspend fun peer(path: String, id: String, payload: JsonObject? = null): JsonObject =
        fixture.post<JsonObject, JsonObject>(path, buildJsonObject { put("id", id); payload?.let { put("payload", it) } })

    private suspend fun sent(id: String): MessageEntity = withTimeout(15_000) {
        while (true) {
            val message = container.db.messages().get(id)!!
            assertNotEquals("The send must not fail: ${message.errorText}", MessageStatus.FAILED, message.status)
            if (message.status in listOf(MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ)) return@withTimeout message
            delay(50)
        }
        error("Unreachable")
    }

    private suspend fun roundTrip(community: Boolean) {
        val (peerId, cid) = prepare(community)
        val id = container.messages.sendText(cid, "Hi from Android 📬")
        val outgoing = sent(id)
        assertNull("A successful send clears the red error", outgoing.errorText)
        var received = false
        withTimeout(10_000) {
            while (!received) {
                received = peer("/received", peerId).getValue("controls").jsonArray.any {
                    it.jsonObject["text"]?.jsonPrimitive?.content == outgoing.text
                }
                if (!received) delay(50)
            }
        }
        val incomingId = peer("/sendMessage", peerId, buildJsonObject { put("type", "text"); put("text", "Reply from Web 📩") })
            .getValue("messageId").jsonPrimitive.content
        withTimeout(10_000) {
            while (container.db.messages().get(incomingId) == null) { container.messages.pollQueueOnce(); delay(50) }
        }
        assertEquals("Reply from Web 📩", container.db.messages().get(incomingId)?.text)
        container.messages.edit(outgoing, "Edited on Android")
        container.messages.react(outgoing, "👍")
        container.messages.markConversationRead(cid)
        withTimeout(10_000) {
            while (true) {
                val changes = peer("/history", peerId).getValue("changes").jsonArray.map { it.jsonObject.getValue("payload").jsonObject }
                val edit = changes.any { it["type"]?.jsonPrimitive?.content == "edit" && it["target"]?.jsonPrimitive?.content == id && it["text"]?.jsonPrimitive?.content == "Edited on Android" }
                val reaction = changes.any { it["type"]?.jsonPrimitive?.content == "reaction" && it["target"]?.jsonPrimitive?.content == id }
                if (edit && reaction && container.db.outbox().due(Long.MAX_VALUE).isEmpty()) break
                delay(50)
            }
        }
        val summary = container.api.get<JsonObject>("/v2/messages/summary").getValue("conversations").jsonArray
            .map { it.jsonObject }.first { it["conversationId"]?.jsonPrimitive?.content == cid }
        assertEquals("Read receipts must use the current protocol too", container.db.messages().get(incomingId)!!.serverTs,
            summary.getValue("readUpTo").jsonPrimitive.long)
    }

    private suspend fun retryRejected(community: Boolean) {
        val (peerId, cid) = prepare(community)
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        container.db.messages().upsert(MessageEntity(
            id = id, conversationId = cid, senderUserId = container.session.session!!.userId,
            senderDeviceId = container.session.session!!.deviceId, outgoing = true, kind = "text", text = "Retry my failed message",
            sentAt = now, sortTs = now, status = MessageStatus.FAILED,
            errorText = "Update Meldiq to keep messaging: messages are now stored on Meldiq's servers.",
        ))
        container.messages.retry(id)
        assertNull(sent(id).errorText)
        val history = peer("/history", peerId).getValue("messages").jsonArray.filter { it.jsonObject["id"]?.jsonPrimitive?.content == id }
        assertEquals("Retry uses the original id and stores one message", 1, history.size)
        assertEquals("Retry my failed message", history.single().jsonObject.getValue("payload").jsonObject["text"]?.jsonPrimitive?.content)
    }

    @Test fun personalInboxSendsReceivesEditsAndReacts() = runBlocking { roundTrip(false) }
    @Test fun communitySendsReceivesEditsAndReacts() = runBlocking { roundTrip(true) }
    @Test fun retryFailedPersonalInboxMessage() = runBlocking { retryRejected(false) }
    @Test fun retryFailedCommunityMessage() = runBlocking { retryRejected(true) }
}
