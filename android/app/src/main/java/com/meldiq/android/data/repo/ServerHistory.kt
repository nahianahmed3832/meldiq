package com.meldiq.android.data.repo

import android.content.Context
import android.util.Log
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.HistoryPageRes
import com.meldiq.android.data.api.ImportReq
import com.meldiq.android.data.api.ImportRes
import com.meldiq.android.data.api.StoredEventDto
import com.meldiq.android.data.api.StoredSearchRes
import com.meldiq.android.data.api.SummaryRes
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.MessageEntity
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.net.URLEncoder

/**
 * Messages served by the server (API 0.56.0, the owner's decision of 2026-10-28, server docs/SERVER_MESSAGES.md). The
 * server stores every message and every change; this phone only shows them. Conversations load their history in pages
 * from the server, the chat list comes from the server's summary, search asks the server, and what the phone shows is
 * a working copy: it is emptied at every start ([clearWorkingCopy]) and loaded again. Unsent messages stay until sent.
 *
 * Once, on the first start after updating, [importLegacy] uploads the history earlier versions kept on this phone (and
 * what the account's encrypted history on the server held), then deletes the phone's copies (messages and files).
 */
class ServerHistory(
    private val context: Context,
    private val api: ApiClient,
    private val db: GriipDatabase,
    private val attachmentsDir: File,
    private val ingest: suspend (StoredEventDto, Boolean) -> Unit,
    private val restoreEncryptedHistory: suspend () -> Unit,
) {
    private val prefs by lazy { context.getSharedPreferences("server_messages_" + (db.openHelper.databaseName ?: "default"), Context.MODE_PRIVATE) }
    private val importLock = Mutex()
    /** Conversations with older messages on the server than this phone has loaded: the oldest serverTs loaded. */
    private val oldest = HashMap<String, Long>()
    private val exhausted = HashSet<String>()

    /** Whether this phone's earlier history was uploaded (or there was none). */
    val imported: Boolean get() = prefs.getBoolean(KEY_IMPORTED, false)

    /** Whether the one-time notice "messages are now kept on Meldiq's servers" was seen. */
    var noticeSeen: Boolean
        get() = prefs.getBoolean(KEY_NOTICE, false)
        set(v) { prefs.edit().putBoolean(KEY_NOTICE, v).apply() }

    /** The newest page of [cid]'s history. */
    suspend fun loadLatest(cid: String) = page(cid, "?limit=$PAGE")

    /** The page before the oldest message loaded; false when there's nothing older. */
    suspend fun loadOlder(cid: String): Boolean {
        if (cid in exhausted) return false
        val before = oldest[cid] ?: return loadLatest(cid)
        return page(cid, "?before=$before&limit=$PAGE")
    }

    /** The messages around [messageId] (a link or a search hit further back). */
    suspend fun loadAround(cid: String, messageId: String) = page(cid, "?around=${enc(messageId)}&limit=$PAGE")

    private suspend fun page(cid: String, query: String): Boolean {
        val r = api.get<HistoryPageRes>("/v2/conversations/${enc(cid)}/messages" + query)
        // Oldest first, so the list's preview ends on the newest; then the changes, oldest first, like live ones.
        for (e in r.messages.asReversed()) apply(e)
        for (e in r.changes) apply(e)
        r.messages.minOfOrNull { it.serverTs }?.let { t -> oldest[cid] = minOf(oldest[cid] ?: Long.MAX_VALUE, t) }
        if (!r.more && !query.contains("around")) exhausted += cid
        return r.more
    }

    /**
     * The chat list after a start or a reconnection: each conversation's newest message and its unread and mention counts
     * as the server keeps them (your read position is your own "read" changes).
     */
    suspend fun syncSummary() {
        val r = api.get<SummaryRes>("/v2/messages/summary")
        for (s in r.conversations) {
            if (db.conversations().get(s.conversationId) == null) continue
            s.last?.let { apply(it) }
            db.conversations().setCounts(s.conversationId, s.unread, s.mentions)
        }
    }

    /** Text messages containing the words, in conversations you're in (all of them, or [cid]); loaded here and returned. */
    suspend fun search(q: String, cid: String? = null): List<MessageEntity> {
        val query = "?q=${enc(q)}&limit=50" + (cid?.let { "&conversationId=${enc(it)}" } ?: "")
        val r = api.get<StoredSearchRes>("/v2/messages/search" + query)
        r.messages.forEach { apply(it) }
        return r.messages.mapNotNull { db.messages().get(it.id) }
    }

    /**
     * Empties the working copy: every message the server already has. Messages still waiting to be sent (in the outbox,
     * sending or failed) stay. Runs at start-up, after the one-time import.
     */
    suspend fun clearWorkingCopy() {
        if (!imported) return
        db.messages().clearStored()
        oldest.clear()
        exhausted.clear()
    }

    /**
     * The one-time move of this phone's history to the server (as Meldiq Web's legacyImport). Uploads, in batches, every
     * message earlier versions kept here and what the account's encrypted history held, with their reactions, votes, poll
     * closings and pins as changes. The server keeps the first copy of each and skips the rest, so several devices
     * uploading the same chat is harmless. The phone's copies (messages and downloaded files) are deleted only after every
     * batch was accepted; a failure leaves them for the next start. Returns how many messages the server didn't have yet.
     */
    suspend fun importLegacy(): Int = importLock.withLock {
        if (imported) return 0
        runCatching { restoreEncryptedHistory() }.onFailure { Log.w(TAG, "encrypted history not restored: ${it.javaClass.simpleName}") }
        val items = StoredEvents.importItems(db.messages().keptForImport())
        var added = 0
        for (batch in items.chunked(StoredEvents.IMPORT_BATCH)) {
            added += api.post<ImportReq, ImportRes>("/v2/messages/import", ImportReq(batch)).added
        }
        // Everything was accepted: the phone's copies go; the sign-in stays.
        db.messages().clearStored()
        attachmentsDir.listFiles()?.forEach { it.deleteRecursively() }
        prefs.edit().putBoolean(KEY_IMPORTED, true).apply()
        added
    }

    private suspend fun apply(e: StoredEventDto) {
        runCatching { ingest(e, true) }.onFailure { Log.w(TAG, "stored event not applied: ${it.javaClass.simpleName}") }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    companion object {
        private const val TAG = "ServerHistory"
        private const val PAGE = 50
        private const val KEY_IMPORTED = "legacy_imported"
        private const val KEY_NOTICE = "server_notice_seen"
    }
}
