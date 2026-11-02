package com.meldiq.android.data.repo

import androidx.room.withTransaction
import com.meldiq.android.crypto.HistoryKeys
import com.meldiq.android.crypto.b64
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.AttachmentKeepRes
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.HistoryDeleteRes
import com.meldiq.android.data.api.HistoryItemDto
import com.meldiq.android.data.api.HistoryPage
import com.meldiq.android.data.api.HistoryPutReq
import com.meldiq.android.data.api.HistoryPutRes
import com.meldiq.android.data.api.HistorySummary
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.KvEntity
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.model.MessagePreview
import com.meldiq.android.data.model.MessageStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

/** One item of the encrypted history: a message or a chat, as this phone stores it. */
@Serializable
data class HistoryRecord(val v: Int = 1, val message: MessageEntity? = null, val conversation: ConversationEntity? = null)

/** What goes into the history and how a downloaded item is merged with this phone's copy. Pure: `HistorySyncTest`. */
object HistoryCodec {
    private const val PENDING = "pending"

    /** Messages are kept once they're settled: not while sending or failed, not undecryptable, no upload in progress. */
    fun uploadable(m: MessageEntity, refs: List<AttachmentRef>): Boolean =
        m.kind != "undecryptable" && m.status != MessageStatus.SENDING && m.status != MessageStatus.FAILED && refs.none { it.id == PENDING }

    /** The stored copy: no local error text; chats without drafts or unread counts (those stay on each phone). */
    fun forUpload(m: MessageEntity): MessageEntity = m.copy(errorText = null)
    fun forUpload(c: ConversationEntity): ConversationEntity = c.copy(draft = null, unreadCount = 0, mentionCount = 0)

    /**
     * The row to write for a downloaded message, or null to keep this phone's copy. A message this phone doesn't have is
     * added; one it has is only changed by a later edit or a deletion for everyone (its own receipts and reactions stay).
     */
    fun merge(local: MessageEntity?, remote: MessageEntity): MessageEntity? = when {
        local == null -> remote.copy(errorText = null)
        remote.deleted && !local.deleted -> local.copy(deleted = true, text = "", attachmentsJson = "[]", richJson = null)
        (remote.editedAt ?: 0) > (local.editedAt ?: 0) && !local.deleted -> local.copy(text = remote.text, editedAt = remote.editedAt, richJson = remote.richJson)
        else -> null
    }
}

/**
 * Keeps this account's messages in the encrypted history on its server (docs/MESSAGE_HISTORY.md), so they survive a
 * reinstall or a new phone: uploads what the history triggers queued (encrypted with keys only the account's devices
 * and its recovery key can derive), asks the server to keep their files, and downloads what other devices or an
 * earlier install stored. Per account; on unless the person turns it off in Data & Storage.
 */
class HistorySync(
    private val api: ApiClient,
    private val db: GriipDatabase,
    private val session: SessionRepository,
    private val features: ServerFeatures,
    private val conversations: ConversationRepository,
    private val scope: CoroutineScope,
) {
    data class State(
        val enabled: Boolean = true,
        /** null until the server has been asked; false: it doesn't keep history (older or configured off). */
        val supported: Boolean? = null,
        val pending: Int = 0,
        val lastUploadAt: Long? = null,
        val lastRestoreAt: Long? = null,
        val restoring: Boolean = false,
        val lastRestored: Int = 0,
        /** Items that couldn't be decrypted (stored under a different identity key). */
        val unreadable: Int = 0,
        val error: String? = null,
        val server: HistorySummary? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state
    private val lock = Mutex()
    private val wake = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
    private val kept = java.util.Collections.synchronizedSet(HashSet<String>())

    private fun keys(): HistoryKeys? {
        val seed = session.keys?.identitySeed?.takeIf { it.isNotEmpty() } ?: return null
        val user = session.session?.userId ?: return null
        return HistoryKeys(seed.unb64(), user)
    }

    private suspend fun kv(k: String) = db.kv().get(k)
    private suspend fun cursor() = kv(CURSOR)?.toLongOrNull() ?: 0L
    private suspend fun setCursor(v: Long) = db.kv().put(KvEntity(CURSOR, v.toString()))

    fun start() {
        // Each time the account is signed in on this phone (a new install, a restore with the recovery key, a linked
        // device, or simply starting the app): queue what this phone had before history existed, then download.
        scope.launch {
            session.state.map { it is SessionState.SignedIn }.distinctUntilChanged().collectLatest { signedIn ->
                if (!signedIn) return@collectLatest
                val on = kv(ENABLED) != "false"
                _state.update { it.copy(enabled = on) }
                if (!on) return@collectLatest
                // Before the first download: whatever this phone already had (an existing install) is queued; on a new
                // install there's nothing yet, and what the download adds isn't queued again.
                if (kv(BACKFILLED) == null) {
                    db.history().queueAllConversations()
                    db.history().queueAllMessages()
                    db.kv().put(KvEntity(BACKFILLED, System.currentTimeMillis().toString()))
                }
                var wait = 30_000L
                while (true) {
                    val r = runCatching { catchUp() }
                    r.exceptionOrNull()?.let { e ->
                        if (e is CancellationException) throw e
                        _state.update { it.copy(error = describe(e)) }
                    }
                    if (r.isSuccess) break
                    delay(wait)
                    wait = (wait * 2).coerceAtMost(15 * 60_000L)
                }
            }
        }
        // The queue's size wakes the uploader; the uploader runs separately, so its own progress (which shrinks the
        // queue) never cancels an upload half-way.
        scope.launch {
            db.history().observeCount().collect { n ->
                _state.update { it.copy(pending = n) }
                if (n > 0) wake.trySend(Unit)
            }
        }
        scope.launch {
            for (signal in wake) {
                if (!_state.value.enabled) continue
                delay(3_000) // batches bursts of messages
                var wait = 30_000L
                while (_state.value.enabled && db.history().count() > 0) {
                    val r = runCatching { flush() }
                    r.exceptionOrNull()?.let { e ->
                        if (e is CancellationException) throw e
                        _state.update { it.copy(error = describe(e)) }
                    }
                    if (r.isSuccess) break
                    delay(wait)
                    wait = (wait * 2).coerceAtMost(15 * 60_000L)
                }
            }
        }
    }

    /** Uploads everything queued. Returns how many items were sent. */
    suspend fun flush(): Int = lock.withLock {
        if (!_state.value.enabled) return 0
        val k = keys() ?: return 0
        when (features.has(ServerFeatures.HISTORY)) {
            null -> throw ApiException(0, "network", "Waiting for a connection")
            false -> {
                _state.update { it.copy(supported = false) }
                return 0
            }
            true -> _state.update { it.copy(supported = true) }
        }
        val keep = features.has(ServerFeatures.ATTACHMENT_KEEP) == true
        var sent = 0
        while (true) {
            val batch = db.history().next(150)
            if (batch.isEmpty()) break
            val items = ArrayList<HistoryItemDto>()
            val handled = ArrayList<com.meldiq.android.data.db.HistoryOutboxEntity>()
            val keepIds = HashMap<String, List<String>>() // outbox key -> files to keep
            var bytes = 0
            for (e in batch) {
                val kind = e.key.substringBefore(':')
                val id = e.key.substringAfter(':')
                val record: HistoryRecord? = when (kind) {
                    "m" -> db.messages().get(id)?.let { m ->
                        val refs = MessageColumns.attachments(m)
                        if (!HistoryCodec.uploadable(m, refs)) null
                        else {
                            if (keep && m.sortTs > System.currentTimeMillis() - 7 * 86_400_000L) keepIds[e.key] = refs.flatMap { listOfNotNull(it.id, it.thumbnail?.asAttachment()?.id) }.filter { it != "pending" }
                            HistoryRecord(message = HistoryCodec.forUpload(m))
                        }
                    }
                    "c" -> db.conversations().get(id)?.let { HistoryRecord(conversation = HistoryCodec.forUpload(it)) }
                    else -> null
                }
                // Gone, or not settled yet (a later change queues it again): nothing to send for this entry.
                if (record == null) {
                    handled += e
                    continue
                }
                val tag = if (kind == "m") k.messageTag(id) else k.conversationTag(id)
                val sealed = k.seal(tag, GriipJson.encodeToString(HistoryRecord.serializer(), record).toByteArray())
                if (sealed.size > MAX_ITEM_BYTES) {
                    handled += e
                    continue
                }
                if (bytes + sealed.size > MAX_BATCH_BYTES && items.isNotEmpty()) break
                bytes += sealed.size
                val m = record.message
                items += HistoryItemDto(tag, k.conversationTag(m?.conversationId ?: id), m?.sortTs ?: record.conversation!!.serverUpdatedAt, sealed.b64())
                handled += e
            }
            if (items.isNotEmpty()) {
                val before = cursor()
                val res = api.put<HistoryPutReq, HistoryPutRes>("/v1/history/items", HistoryPutReq(items))
                // Nobody else wrote in between: this phone already has everything up to the new position.
                if (res.seq - items.size == before) setCursor(res.seq)
                _state.update { it.copy(lastUploadAt = System.currentTimeMillis(), error = null) }
            }
            // A file the server couldn't be asked to keep (offline, server busy) leaves its message queued: the next round
            // uploads it again (same tag, replaced) and asks again.
            val keepLater = keepIds.filterValues { ids -> ids.map { keepFile(it) }.any { !it } }.keys
            for (e in handled) if (e.key !in keepLater) db.history().done(e.key, e.queuedAt)
            sent += items.size
            if (keepLater.isNotEmpty()) throw ApiException(0, "network", "Waiting to keep files on the server")
            if (handled.isEmpty()) break
        }
        sent
    }

    /** false when it should be tried again later; true when settled (kept, or gone/over quota: nothing more to do). */
    private suspend fun keepFile(id: String): Boolean {
        if (id in kept) return true
        val r = runCatching { api.post<AttachmentKeepRes>("/v1/attachments/$id/keep") }
        val e = r.exceptionOrNull()
        if (e is CancellationException) throw e
        val settled = e == null || (e is ApiException && (e.status == 404 || e.status == 429 || e.status == 403))
        if (settled) kept += id
        return settled
    }

    /**
     * Downloads what the server holds beyond what this phone has seen ([fromStart]: everything) and adds what's missing.
     * Returns how many messages and chats were added or updated.
     */
    suspend fun catchUp(fromStart: Boolean = false): Int = lock.withLock {
        val k = keys() ?: return 0
        val supported = features.has(ServerFeatures.HISTORY) ?: throw ApiException(0, "network", "Waiting for a connection")
        _state.update { it.copy(supported = supported) }
        if (!supported) return 0
        var cursor = if (fromStart) 0 else cursor()
        val firstRestore = cursor == 0L
        var restored = 0
        var unreadable = 0
        _state.update { it.copy(restoring = true, error = null) }
        try {
            while (true) {
                val page = api.get<HistoryPage>("/v1/history/items?after=$cursor&limit=500")
                val records = page.items.mapNotNull { item ->
                    val body = item.body ?: return@mapNotNull null
                    runCatching { GriipJson.decodeFromString(HistoryRecord.serializer(), String(k.open(item.tag, body.unb64()))) }
                        .getOrElse { unreadable++; null }
                }
                restored += apply(records, firstRestore)
                cursor = page.next
                setCursor(cursor)
                if (!page.more) break
            }
        } finally {
            _state.update { it.copy(restoring = false) }
        }
        _state.update { it.copy(lastRestoreAt = System.currentTimeMillis(), lastRestored = restored, unreadable = unreadable) }
        if (restored > 0) runCatching { conversations.refresh() }
        restored
    }

    private suspend fun apply(records: List<HistoryRecord>, firstRestore: Boolean): Int = db.withTransaction {
        val keys = records.mapNotNull { r -> r.message?.let { "m:${it.id}" } ?: r.conversation?.let { "c:${it.id}" } }
        val alreadyQueued = if (keys.isEmpty()) emptySet() else keys.chunked(500).flatMap { db.history().queued(it) }.toSet()
        var n = 0
        val newest = HashMap<String, MessageEntity>()
        for (r in records) {
            r.conversation?.let { c ->
                val local = db.conversations().get(c.id)
                if (local == null) {
                    db.conversations().insertIgnore(c.copy(unreadCount = 0, mentionCount = 0, draft = null))
                    n++
                } else if (firstRestore) {
                    // A new phone takes the account's chat preferences.
                    if (c.muted != local.muted) db.conversations().setMuted(c.id, c.muted)
                    if (c.archivedAt != local.archivedAt) db.conversations().setArchived(c.id, c.archivedAt)
                }
            }
            r.message?.let { m ->
                val row = HistoryCodec.merge(db.messages().get(m.id), m) ?: return@let
                db.messages().upsert(row)
                n++
                if (row.threadRootId == null && (newest[row.conversationId]?.sortTs ?: Long.MIN_VALUE) < row.sortTs) newest[row.conversationId] = row
            }
        }
        for ((cid, m) in newest) {
            val sender = if (m.outgoing) null else db.users().get(m.senderUserId)?.displayName
            db.conversations().bumpPreview(cid, m.id, MessagePreview.of(m), m.sortTs, sender, 0, 0)
        }
        // What was just downloaded is already on the server: the triggers queued it, so it's taken off again (unless
        // this phone had its own change waiting).
        keys.filter { it !in alreadyQueued }.chunked(500).forEach { db.history().drop(it) }
        n
    }

    suspend fun summary(): HistorySummary? = runCatching { api.get<HistorySummary>("/v1/history/summary") }.getOrNull()?.also { s ->
        _state.update { it.copy(server = s) }
    }

    /** Turns server history on (queues this phone's messages, then uploads) or off (stops uploading; nothing is deleted). */
    suspend fun setEnabled(on: Boolean) {
        db.kv().put(KvEntity(ENABLED, on.toString()))
        _state.update { it.copy(enabled = on, error = null) }
        if (on) {
            db.history().queueAllConversations()
            db.history().queueAllMessages()
        } else db.history().clear()
    }

    /** Turns history off and deletes this account's whole history from the server. Messages on this phone stay. */
    suspend fun deleteFromServer(): Long {
        setEnabled(false)
        val r = api.delete<HistoryDeleteRes>("/v1/history")
        setCursor(0)
        db.kv().delete(BACKFILLED)
        _state.update { it.copy(server = null) }
        summary()
        return r.deleted
    }

    private fun describe(e: Throwable): String {
        // Debug builds only: the exception type and where it came from (never message content).
        if (com.meldiq.android.BuildConfig.DEBUG) runCatching { android.util.Log.w("HistorySync", "history sync failed: ${e.javaClass.name}", e) }
        return describeFor(e)
    }

    private fun describeFor(e: Throwable): String = when {
        e is ApiException && e.status == 429 -> "The server's storage for your message history is full."
        e is ApiException && e.isNetwork -> "Waiting for a connection to back up messages."
        e is ApiException -> e.message
        else -> "Couldn't back up messages. Meldiq will try again."
    }

    companion object {
        private const val CURSOR = "history.cursor"
        private const val ENABLED = "history.enabled"
        private const val BACKFILLED = "history.backfilled"
        private const val MAX_ITEM_BYTES = 60 * 1024
        private const val MAX_BATCH_BYTES = 3 * 1024 * 1024
    }
}
