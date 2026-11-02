package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.SendStoredReq
import com.meldiq.android.data.api.SendStoredRes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class MessageSenderTest {
    private val request = SendStoredReq("community-1", "message-1234", "message", 123,
        buildJsonObject { put("type", "text"); put("text", "Hi @everyone"); put("futureField", "kept") }, mentionAll = true)

    @Test fun currentServerUsesStoredMessagesWithoutConsultingEncryptionKeys() = runTest {
        val posted = mutableListOf<SendStoredReq>()
        val sender = MessageSender(
            postStored = { posted += it; SendStoredRes(it.messageId, 456) },
            supportsStore = { true },
            postLegacy = { error("Current servers must not depend on device encryption keys") },
        )
        assertEquals(456L, sender.send(request))
        assertEquals(listOf(request), posted)
    }

    @Test fun olderSelfHostedServersRetainTheirEnvelopeProtocol() = runTest {
        val sender = MessageSender(postStored = { error("Not supported") }, supportsStore = { false }, postLegacy = { 789 })
        assertEquals(789L, sender.send(request))
    }

    @Test fun explicitUpgradeRefusalRecoversWithTheSameIdPayloadAndAudience() = runTest {
        val read = request.copy(cls = "control", payload = buildJsonObject { put("type", "read"); put("upTo", 100) }, audience = "self")
        for (r in listOf(request, read)) {
            val posted = mutableListOf<SendStoredReq>()
            val sender = MessageSender(
                postStored = { posted += it; SendStoredRes(it.messageId, 456) }, supportsStore = { false },
                postLegacy = { throw ApiException(426, "update_required", "Update Meldiq to keep messaging") },
            )
            assertEquals(456L, sender.send(r))
            assertEquals(listOf(r), posted)
        }
    }

    @Test fun otherRefusalsAndNetworkErrorsNeverChangeTheProtocol() = runTest {
        for (status in listOf(0, 401, 403, 409, 429, 500, 426)) {
            val failure = ApiException(status, "other_failure", "refused")
            val sender = MessageSender(postStored = { error("Must not fall back") }, supportsStore = { false }, postLegacy = { throw failure })
            try { sender.send(request); fail("Refusal must propagate") }
            catch (e: ApiException) { assertSame(failure, e) }
        }
    }

    @Test fun cancellationNeverFallsBackOrReportsSuccess() = runTest {
        val sender = MessageSender(postStored = { error("Must not fall back") }, supportsStore = { false }, postLegacy = { throw CancellationException() })
        try { sender.send(request); fail("Cancellation must propagate") } catch (_: CancellationException) { }
    }

    @Test fun requestEncodingKeepsMentionAttestationAndSelfOnlyReadScope() {
        val encoded = GriipJson.encodeToJsonElement(SendStoredReq.serializer(), request)
        assertEquals(request, GriipJson.decodeFromJsonElement(SendStoredReq.serializer(), encoded))
        val read = request.copy(audience = "self")
        assertEquals(read, GriipJson.decodeFromString(SendStoredReq.serializer(), GriipJson.encodeToString(SendStoredReq.serializer(), read)))
    }
}
