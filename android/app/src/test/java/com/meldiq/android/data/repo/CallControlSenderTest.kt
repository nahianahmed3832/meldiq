package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.model.Payload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class CallControlSenderTest {
    @Test fun callControlsPostBeforeReturning() = runTest {
        val sent = mutableListOf<Payload>()
        val sender = CallControlSender { _, _, _, payload -> sent += payload }
        val invite = Payload(type = "call_invite", callId = "call-1", e2eeKey = "key")
        sender.send("conversation-1", invite)
        assertEquals(listOf(invite), sent)
        assertTrue(CallControlSender.handles(invite))
        assertTrue(CallControlSender.handles(Payload(type = "call_key_request")))
        assertFalse(CallControlSender.handles(Payload(type = "read")))
    }

    @Test fun lostResponseRetriesWithTheSameMessageId() = runTest {
        val attempts = mutableListOf<Pair<String, Long>>()
        val sender = CallControlSender { _, id, sentAt, _ ->
            attempts += id to sentAt
            if (attempts.size == 1) throw ApiException(0, "network", "lost response")
        }
        sender.send("conversation-1", Payload(type = "call_key_request", callId = "call-1"))
        assertEquals(2, attempts.size)
        assertEquals(attempts[0], attempts[1])
    }

    @Test fun permanentRefusalAndExhaustedRetriesReachTheCaller() = runTest {
        for (status in listOf(403, 426, 503)) {
            var attempts = 0
            val sender = CallControlSender { _, _, _, _ ->
                attempts++
                throw ApiException(status, "refused", "Call key was not sent")
            }
            try {
                sender.send("conversation-1", Payload(type = "call_invite"))
                fail("A failed send must not report success")
            } catch (e: ApiException) { assertEquals(status, e.status) }
            assertEquals(if (status == 503) 2 else 1, attempts)
        }
    }

    @Test fun cancellationDoesNotRetryOrReportSuccess() = runTest {
        var attempts = 0
        val sender = CallControlSender { _, _, _, _ -> attempts++; throw CancellationException() }
        try {
            sender.send("conversation-1", Payload(type = "call_invite"))
            fail("Cancellation must propagate")
        } catch (_: CancellationException) { }
        assertEquals(1, attempts)
    }

    @Test fun localEncryptionFailureIsVisibleAndDoesNotExposeInternalDetails() = runTest {
        val sender = CallControlSender { _, _, _, _ -> throw IllegalStateException("internal detail") }
        try {
            sender.send("conversation-1", Payload(type = "call_invite"))
            fail("A local failure must reach call setup")
        } catch (e: ApiException) {
            assertEquals("call_key_send", e.code)
            assertFalse(e.message.contains("internal detail"))
        }
    }
}
