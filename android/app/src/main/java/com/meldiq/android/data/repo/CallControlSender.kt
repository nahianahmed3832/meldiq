package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.model.Payload
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import java.util.UUID

/** Call setup cannot wait behind chat uploads or an offline WebSocket's outbox. */
internal class CallControlSender(
    private val post: suspend (conversationId: String, messageId: String, sentAt: Long, payload: Payload) -> Unit,
) {
    suspend fun send(conversationId: String, payload: Payload) {
        val id = UUID.randomUUID().toString()
        val sentAt = System.currentTimeMillis()
        try {
            attempt(conversationId, id, sentAt, payload)
        } catch (e: ApiException) {
            if (!e.isNetwork && e.status != 401 && e.status != 429 && e.status < 500) throw e
            delay(1_000)
            // Reuse the id: a lost response must not deliver two invitations.
            attempt(conversationId, id, sentAt, payload)
        }
    }

    private suspend fun attempt(conversationId: String, id: String, sentAt: Long, payload: Payload) {
        try {
            post(conversationId, id, sentAt, payload)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            throw e
        } catch (e: IdentityChangedException) {
            throw ApiException(409, "identity_changed", "A security key changed. Review it in the conversation before calling again.")
        } catch (_: Exception) {
            throw ApiException(409, "call_key_send", "Couldn't send the call's encryption key. Try calling again.")
        }
    }

    companion object {
        fun handles(payload: Payload) = payload.type == "call_invite" || payload.type == "call_key_request"
    }
}
