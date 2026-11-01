package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.SendStoredReq
import com.meldiq.android.data.api.SendStoredRes

/** One protocol choice for messages and every control, including reads, edits, reactions and call keys. */
internal class MessageSender(
    private val postStored: suspend (SendStoredReq) -> SendStoredRes,
    private val supportsStore: suspend () -> Boolean = { true },
    private val postLegacy: (suspend (SendStoredReq) -> Long)? = null,
) {
    suspend fun send(request: SendStoredReq): Long {
        val legacy = postLegacy
        if (legacy == null || supportsStore()) return postStored(request).serverTs
        return try {
            legacy(request)
        } catch (e: ApiException) {
            // Feature discovery can be stale or unavailable during an upgrade. Only an explicit retirement of the
            // envelope endpoint allows this switch; permission and network errors must retain their real meaning.
            if (e.status != 426 || e.code != "update_required") throw e
            postStored(request).serverTs
        }
    }
}
