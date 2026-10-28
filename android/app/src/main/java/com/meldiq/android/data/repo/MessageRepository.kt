package com.meldiq.android.data.repo

import com.meldiq.android.data.api.SendStoredReq
import com.meldiq.android.data.api.SendStoredRes

import android.content.Context
import android.util.Log
import com.meldiq.android.crypto.AttachmentCrypto
import com.meldiq.android.crypto.ChunkedAttachmentCrypto
import com.meldiq.android.crypto.EnvelopeException
import com.meldiq.android.crypto.EnvelopeHeader
import com.meldiq.android.crypto.MessageCrypto
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.CallDto
import com.meldiq.android.data.api.CallRes
import com.meldiq.android.data.api.CallsRes
import com.meldiq.android.data.api.ConnState
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.RealtimeClient
import com.meldiq.android.data.api.SendMessageReq
import com.meldiq.android.data.api.SendMessageRes
import com.meldiq.android.data.api.ServerEvent
import com.meldiq.android.data.api.WireKeyWrap
import com.meldiq.android.data.db.CallKeyEntity
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.db.OutboxEntity
import com.meldiq.android.data.model.AttachmentPolicy
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.model.CallHistory
import com.meldiq.android.data.model.CallInfo
import com.meldiq.android.data.model.MentionRules
import com.meldiq.android.data.model.MentionSet
import com.meldiq.android.data.model.MessagePreview
import com.meldiq.android.data.model.MessageStatus
import com.meldiq.android.data.model.Payload
import com.meldiq.android.data.model.RichContent
import com.meldiq.android.data.model.RichRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.UUID

data class Notice(val conversationId: String, val title: String, val sender: String, val text: String, val mention: Boolean, val isGroup: Boolean, val canReply: Boolean = true)
data class IncomingCallKey(val callId: String, val conversationId: String, val fromUserId: String, val video: Boolean)

/** Live UI context used to decide notifications / read receipts. */
class AppState {
    val foreground = MutableStateFlow(false)
    val viewingConversation = MutableStateFlow<String?>(null)
    /** Push wake-up fetches in progress ([WakeFetch]): the relay connection stays open while above zero. */
    val wakeHolds = MutableStateFlow(0)
}

/**
 * Message pipeline: local-first history in Room, an outbox that encrypts and submits with retry,
 * and an ordered consumer for relay deliveries that verifies, decrypts, applies and acknowledges.
 */
class MessageRepository(
    private val context: Context,
    private val db: GriipDatabase,
    private val api: ApiClient,
    private val realtime: RealtimeClient,
    private val session: SessionRepository,
    private val crypto: MessageCrypto,
    private val directory: KeyDirectory,
    private val conversations: ConversationRepository,
    private val users: UserRepository,
    private val settings: SettingsStore,
    private val appState: AppState,
    private val scope: CoroutineScope,
    attachmentsDir: File = File(context.filesDir, "attachments"),
    /** Direct uploads to the server's file store when it offers them; the original upload otherwise. */
    private val uploader: AttachmentUploader = AttachmentUploader(api, null),
    /** Whether this account's server has a feature ([ServerFeatures]); unknown counts as no. */
    private val serverHas: suspend (String) -> Boolean = { false },
    private val notify: (Notice) -> Unit,
) {
    private val json = GriipJson
    private val files = AttachmentFiles(attachmentsDir)
    private val keyRequests = CallKeyRequests()
    private val kickCh = Channel<Unit>(Channel.CONFLATED)

    private val _transfer = MutableStateFlow<Map<String, Float>>(emptyMap())
    val transferProgress: StateFlow<Map<String, Float>> = _transfer

    private val myUserId get() = session.session?.userId
    private val myDeviceId get() = session.session?.deviceId

    private val signals = MessageSignals(db, conversations, directory, users) { session.session?.userId }
    private val controls = MessageControls(db, realtime, session, conversations, settings, files, ::sendControl, ::sendSelfControl)
    private val receiver = MessageReceiver(
        context, db, api, realtime, session, crypto, directory, conversations, users, settings, appState, scope, files, keyRequests,
        signals, controls, notify, ::sendControl, ::kick,
    )

    /** Messages served by the server (API 0.57.0): history pages, the chat list's summary, search and the one-time import. */
    val history = ServerHistory(
        context, api, db, attachmentsDir, ingest = { e, loaded -> receiver.ingest(e, history = loaded) },
        restoreEncryptedHistory = { restoreEncryptedHistory() }, supported = { serverHas(ServerFeatures.SERVER_MESSAGES) },
    )
    /** Set by the container: reads what the account's old encrypted history on the server holds, before the import. */
    var restoreEncryptedHistory: suspend () -> Unit = {}

    /** Round 3: the person's notification level for a conversation (set by the container from NavPreferences). */
    var notifyLevelOf: (ConversationEntity) -> String
        get() = receiver.notifyLevelOf
        set(value) { receiver.notifyLevelOf = value }
    /** Batch B2: whether @everyone counts as a mention in the conversation's community (set by the container). */
    var countsEveryoneOf: (ConversationEntity) -> Boolean
        get() = receiver.countsEveryoneOf
        set(value) { receiver.countsEveryoneOf = value }

    // ─────────── Receiving: the socket's signals (MessageSignals) and the queue (MessageReceiver) ───────────

    val typing: StateFlow<Map<String, Map<String, Long>>> = signals.typing
    val callInvites: SharedFlow<IncomingCallKey> = signals.callInvites
    val callFrames: SharedFlow<ServerEvent.Call> = signals.callFrames
    /** Round 7: a meeting starting in ten minutes (its id), and a workspace whose meetings changed (its id). */
    val meetingSoon: SharedFlow<String> = signals.meetingSoon
    val meetingUpdates: SharedFlow<String> = signals.meetingUpdates
    val orgEvents: SharedFlow<String> = signals.orgEvents
    /** Batch B6: someone sent, accepted, cancelled or removed a connection with you (screens reload their lists). */
    val connectionsChanged: SharedFlow<Unit> = signals.connectionsChanged
    val entitlementsChanged: SharedFlow<Unit> = signals.entitlementsChanged
    val orgDeleted: SharedFlow<String> = signals.orgDeleted
    /** Reminders that went off or changed on another device ("reminder.due", "reminders.changed"): their ids. */
    val reminderEvents: SharedFlow<String> = signals.reminderEvents
    /** Workspaces whose personal preferences another device of this person changed ("prefs.updated"). */
    val prefsUpdated: SharedFlow<String> = signals.prefsUpdated
    val backlogDrained: MutableStateFlow<Boolean> = signals.backlogDrained
    /** Your profile or account settings changed on another of your devices (server 0.28.0+). */
    val ownAccountUpdates: SharedFlow<String> = signals.ownAccountUpdates

    /** REST fallback used by the background service when the socket is unavailable. */
    suspend fun pollQueueOnce() = receiver.pollQueueOnce()

    /**
     * The user reviewed [identityKey] (the safety number they compared) and accepts it for [userId]:
     * pin it, resume paused sends and open the messages held while the key was untrusted.
     */
    suspend fun acceptIdentity(userId: String, identityKey: String) = receiver.acceptIdentity(userId, identityKey)

    // ─────────── Message controls (MessageControls) ───────────

    suspend fun react(m: MessageEntity, emoji: String) = controls.react(m, emoji)
    /** Edits keep mention targets in step with the text (members only); @everyone stays as it was sent. */
    suspend fun edit(m: MessageEntity, newText: String, resolved: MentionSet? = null) = controls.edit(m, newText, resolved)
    suspend fun delete(m: MessageEntity) = controls.delete(m)
    /** Your vote on the poll in [m] (docs/RICH_MESSAGES.md › Polls); an empty [choices] takes the vote back. */
    suspend fun vote(m: MessageEntity, choices: List<String>) = controls.vote(m, choices)
    /** Closes your own poll for everyone: no more votes. */
    suspend fun closePoll(m: MessageEntity) = controls.closePoll(m)
    suspend fun setPinned(m: MessageEntity, pinned: Boolean) = controls.setPinned(m, pinned)
    /** Clear unread and (DMs/groups) send an encrypted read receipt. */
    suspend fun markConversationRead(cid: String) = controls.markConversationRead(cid)
    fun setTyping(cid: String, on: Boolean) = controls.setTyping(cid, on)

    fun start() {
        scope.launch { realtime.events.collect { e -> runCatching { signals.handle(e) { q -> receiver.processQueue(q.items, q.backlog) } }.onFailure { Log.w(TAG, "event ${e.javaClass.simpleName} failed: ${it.javaClass.simpleName}") } } }
        scope.launch { outboxLoop() }
        scope.launch { runCatching { receiver.retrySetAside() } }
        // Messages live on the server: the phone's working copy from the last run goes (unsent ones stay).
        scope.launch { runCatching { history.clearWorkingCopy() } }
        scope.launch {
            realtime.state.collect { st ->
                if (st == ConnState.Connected) {
                    kick()
                    runCatching { conversations.refresh() }
                    // API 0.57.0: the phone's earlier history goes to the server once; then the list comes from the server.
                    runCatching { history.importLegacy() }.onFailure { Log.w(TAG, "history import: ${it.javaClass.simpleName}") }
                    runCatching { history.syncSummary() }.onFailure { Log.w(TAG, "summary: ${it.javaClass.simpleName}") }
                } else backlogDrained.value = false
            }
        }
        scope.launch {
            while (true) {
                delay(3000)
                signals.pruneTyping()
            }
        }
    }

    fun kick() {
        kickCh.trySend(Unit)
    }

    fun observeMessages(cid: String, limit: Int): Flow<List<MessageEntity>> = db.messages().observeLatest(cid, limit)
    fun observeThread(cid: String, root: String) = db.messages().observeThread(cid, root)
    fun observeThreadCounts(cid: String) = db.messages().observeThreadCounts(cid)
    fun observeThreadRoots(cid: String, limit: Int) = db.messages().observeThreadRoots(cid, limit)
    fun observePinned(cid: String) = db.messages().observePinned(cid)
    fun observeWithFiles(cid: String, limit: Int) = db.messages().observeWithFiles(cid, limit)
    fun observeWithLinks(cid: String, limit: Int) = db.messages().observeWithLinks(cid, limit)
    /** [followed]: thread roots followed on this phone (batch B8), whose replies count even if you never wrote there. */
    fun observeThreadReplies(me: String, since: Long, limit: Int, followed: Set<String> = emptySet()) =
        db.messages().observeThreadReplies(me, since, limit, followed.toList())
    fun observeMessage(id: String) = db.messages().observe(id)
    suspend fun search(q: String, cid: String? = null): List<MessageEntity> {
        // API 0.57.0: the server keeps the messages, so it searches them; what it finds is loaded here first.
        runCatching { history.search(q, cid) }
        val esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return if (cid == null) db.messages().search(esc) else db.messages().searchIn(cid, esc)
    }

    /**
     * Messages on this phone matching [sq]'s words and its from:, has:, before: and after: filters (2026-10-23), newest
     * first. Senders are matched by display name or username among the people this phone knows.
     */
    suspend fun search(sq: com.meldiq.android.data.model.SearchQuery): List<MessageEntity> {
        val esc = sq.text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        val names = if (sq.from == null) emptyMap() else db.users().all().associate { it.id to listOf(it.displayName, it.username) }
        return db.messages().searchBetween(esc, sq.after ?: 0L, sq.before ?: Long.MAX_VALUE)
            .filter { m -> sq.matches(names[m.senderUserId].orEmpty(), m.sortTs, m.text, attachments(m).map { it.mime }) }
            .take(100)
    }

    /** Files on this phone whose name contains [q], newest first, with the message each belongs to (round 7 search). */
    suspend fun searchFiles(q: String): List<Pair<MessageEntity, AttachmentRef>> {
        val esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return db.messages().searchFiles(esc).flatMap { m -> attachments(m).filter { it.name.contains(q, ignoreCase = true) }.map { m to it } }.take(100)
    }

    /** Pinned messages on this phone whose text contains [q] (round 7 search). */
    suspend fun searchPinned(q: String): List<MessageEntity> =
        db.messages().searchPinned(q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"))

    fun reactions(m: MessageEntity): Map<String, List<String>> = MessageColumns.reactions(m)
    fun attachments(m: MessageEntity): List<AttachmentRef> = MessageColumns.attachments(m)
    fun readBy(m: MessageEntity): List<String> = MessageColumns.readBy(m)
    fun deliveredTo(m: MessageEntity): List<String> = MessageColumns.deliveredTo(m)
    fun mentions(m: MessageEntity): List<String> = MessageColumns.mentions(m)
    fun callInfo(m: MessageEntity): CallInfo? = MessageColumns.call(m)
    fun rich(m: MessageEntity): RichContent? = MessageColumns.rich(m)

    // ─────────────────────────── Sending ───────────────────────────

    /**
     * [mentions]: what the composer resolved against the conversation's members (docs/MENTIONS.md). Without it (a reply
     * from a notification) the text is resolved here against the members known for the conversation.
     */
    suspend fun sendText(
        cid: String, text: String, replyTo: String? = null, threadRoot: String? = null, attachments: List<AttachmentRef> = emptyList(),
        presetId: String? = null, mentions: MentionSet? = null, rich: RichContent? = null, forwarded: Boolean = false,
    ): String {
        val s = session.session ?: error("not signed in")
        val id = presetId ?: UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        // A contact, location or animated emoji travels with a readable text, which older apps show instead.
        val body = if (rich != null && rich.structured && text.isBlank()) RichRules.fallbackText(rich) else text
        val m = mentions ?: if (rich?.structured == true) MentionSet.NONE else controls.resolveMentions(cid, body)
        val payload = Payload(
            type = "text", text = body, replyTo = replyTo, threadRoot = threadRoot, mentions = m.ids.ifEmpty { null },
            mentionAll = if (m.all) true else null, attachments = attachments.ifEmpty { null },
            contact = rich?.contact, location = rich?.location, animoji = rich?.animoji, forwarded = if (forwarded) true else null,
            link = rich?.link, poll = rich?.poll, sticker = rich?.sticker, title = rich?.title, tags = rich?.tags?.ifEmpty { null },
            customEmoji = rich?.customEmoji?.ifEmpty { null }, customSticker = rich?.customSticker,
            origin = if (forwarded) rich?.origin else null,
        )
        val existing = db.messages().get(id)
        val msg = MessageEntity(
            id = id, conversationId = cid, senderUserId = s.userId, senderDeviceId = s.deviceId, outgoing = true, kind = "text", text = body,
            replyToId = replyTo, threadRootId = threadRoot, mentionsJson = MessageColumns.encodeIds(MentionRules.stored(m)),
            attachmentsJson = MessageColumns.encodeAttachments(attachments), sentAt = existing?.sentAt ?: now, sortTs = existing?.sortTs ?: now, status = MessageStatus.SENDING,
            richJson = MessageColumns.encodeRich(rich), forwarded = forwarded,
        )
        db.messages().upsert(msg)
        db.outbox().put(OutboxEntity(id, cid, "message", json.encodeToString(Payload.serializer(), payload), now))
        if (threadRoot == null) db.conversations().bumpPreview(cid, id, MessagePreview.of(payload), now, "You", 0, 0)
        kick()
        return id
    }

    private suspend fun sendControl(cid: String, payload: Payload) {
        val id = UUID.randomUUID().toString()
        db.outbox().put(OutboxEntity(id, cid, "control", json.encodeToString(Payload.serializer(), payload), System.currentTimeMillis(), visible = false))
        kick()
    }

    /**
     * A control for this person's own other devices only (API 0.43.0, audience "self"), e.g. "read up to here" in a
     * channel, so their other phones and browsers clear it while nobody else learns what was read. Best effort, like
     * Meldiq Web: not kept in the outbox (the next read says it again). False when it wasn't sent.
     */
    private suspend fun sendSelfControl(cid: String, payload: Payload): Boolean {
        session.session ?: return false
        if (!serverHas(ServerFeatures.SELF_CONTROLS)) return false
        return try {
            val now = System.currentTimeMillis()
            api.post<SendStoredReq, SendStoredRes>(
                "/v2/messages",
                SendStoredReq(cid, UUID.randomUUID().toString(), "control", now, StoredEvents.payloadObject(payload), audience = SELF_AUDIENCE),
            )
            true
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "self-only control not sent: ${e.javaClass.simpleName}")
            false
        }
    }

    suspend fun retry(id: String) {
        val m = db.messages().get(id) ?: return
        if (m.status != MessageStatus.FAILED) return
        // Files that never finished uploading are prepared and sent again from their local copies (T2.6); the ones
        // already uploaded aren't sent twice.
        if (attachments(m).any { it.id == AttachmentFiles.PENDING }) {
            db.messages().setStatus(id, MessageStatus.SENDING, null, null)
            startBatch(id)
            return
        }
        sendText(m.conversationId, m.text, m.replyToId, m.threadRootId, attachments(m), presetId = id, rich = rich(m), forwarded = m.forwarded)
    }

    /** Distribute a call's media E2EE key to all member devices through the encrypted channel. */
    suspend fun sendCallKey(cid: String, callId: String, video: Boolean, key: String) {
        val s = session.session ?: return
        db.calls().putKey(CallKeyEntity(callId, cid, key, s.userId, System.currentTimeMillis()))
        sendControl(cid, Payload(type = "call_invite", callId = callId, video = video, e2eeKey = key))
    }

    /**
     * This call's media key, if it has arrived. While it's missing, the call's creator is asked to
     * re-send it (T5.3): a device that joins after the call started never received the original.
     */
    suspend fun callKey(callId: String): String? {
        db.calls().key(callId)?.let { return it.key }
        if (keyRequests.shouldRequest(callId)) scope.launch { runCatching { requestCallKey(callId) } }
        return null
    }

    private suspend fun requestCallKey(callId: String) {
        val call = api.get<CallRes>("/v1/calls/$callId").call
        if (call.state == "ENDED") return
        sendControl(call.conversationId, Payload(type = "call_key_request", callId = callId))
    }

    // ─────────── Attachments (encrypted before upload) ───────────

    /** The picked file is larger than attachments may be (25 MB). */
    class AttachmentTooLarge : Exception("This file is larger than this server accepts.")
    class NotEnoughSpace : Exception("Not enough free space on this phone to send this file. Free up some space and try again.")

    /**
     * Copies the picked file into app storage (streamed, never whole in memory), then encrypts and uploads
     * it (T2.6). The local copy is the retry source until the upload succeeds. A voice message passes
     * [voiceDurationMs] and travels as an ordinary encrypted attachment marked as voice.
     */
    suspend fun sendAttachment(cid: String, name: String, mime: String, input: java.io.InputStream, caption: String, voiceDurationMs: Long? = null, replyTo: String? = null) {
        val s = session.session ?: return
        val id = UUID.randomUUID().toString()
        val local = files.fileFor(id, name)
        withContext(Dispatchers.IO) {
            try {
                local.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_ATTACHMENT_BYTES) throw AttachmentTooLarge()
                        out.write(buf, 0, n)
                    }
                }
            } catch (e: Exception) {
                local.delete()
                throw e
            }
        }
        val now = System.currentTimeMillis()
        val voice = voiceDurationMs?.let { true }
        val placeholder = AttachmentRef(AttachmentFiles.PENDING, name, mime, local.length(), "", "", local.name, voice, voiceDurationMs)
        db.messages().upsert(
            MessageEntity(id, cid, s.userId, s.deviceId, true, "text", caption, replyToId = replyTo, attachmentsJson = MessageColumns.encodeAttachments(listOf(placeholder)), sentAt = now, sortTs = now, status = MessageStatus.SENDING),
        )
        db.conversations().bumpPreview(cid, id, MessagePreview.of(caption, listOf(placeholder), null), now, "You", 0, 0)
        uploadAttachment(id, cid, placeholder, local, caption)
    }

    /**
     * Encrypts [local] to a temporary file and uploads it, retrying transient failures. Any failure
     * leaves the message FAILED with a reason (never stuck in SENDING); the local copy stays for a retry.
     */
    private suspend fun uploadAttachment(id: String, cid: String, pending: AttachmentRef, local: File, caption: String) {
        val name = pending.name
        val enc = File(context.cacheDir, "$id.enc")
        _transfer.update { it + (id to 0f) }
        try {
            val meta = withContext(Dispatchers.IO) { AttachmentCrypto.encryptFile(local, enc) }
            val up = uploader.upload(cid, enc, meta.sha256) { p -> _transfer.update { it + (id to p) } }
            val dims = com.meldiq.android.media.MediaDims.of(local, pending.mime).takeIf { pending.voice != true }
            val ref = AttachmentRef(up.id, name, pending.mime, local.length(), meta.key, meta.nonce, meta.sha256, pending.voice, pending.durationMs, w = dims?.first, h = dims?.second)
            local.renameTo(files.fileFor(up.id, name))
            sendText(cid, caption, replyTo = db.messages().get(id)?.replyToId, attachments = listOf(ref), presetId = id)
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e // left SENDING; marked interrupted at the next start (failInterruptedUploads)
        } catch (e: ApiException) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: Exception) {
            Log.w(TAG, "attachment send failed: ${e.javaClass.simpleName}")
            db.messages().setStatus(id, MessageStatus.FAILED, null, "Couldn't send this file")
        } finally {
            enc.delete()
            _transfer.update { it - id }
        }
    }

    // ─────────── Several photos, videos or files in one message (2026-10-17, docs/ATTACHMENTS.md) ───────────

    /** One picked file for [sendBatch]: where to read it, and what [AttachmentPolicy] found when it was picked. */
    data class BatchItem(
        val uri: android.net.Uri,
        val name: String,
        val mime: String,
        val size: Long,
        val kind: AttachmentPolicy.Kind,
        val sniffed: AttachmentPolicy.Sniffed?,
        /** A voice message being forwarded: it stays a voice message. */
        val voiceDurationMs: Long? = null,
        /** Video length, when the picker could read it (for size estimates). */
        val durationMs: Long? = null,
    )

    /** An album being prepared and sent: [done] of [total] files are uploaded; [stage] describes the current one. */
    data class BatchProgress(val done: Int, val total: Int, val stage: String)

    private val _batches = MutableStateFlow<Map<String, BatchProgress>>(emptyMap())
    val batchProgress: StateFlow<Map<String, BatchProgress>> = _batches

    /** Where each not-yet-prepared file comes from, by its placeholder's local file name (lost if the app is closed). */
    private data class BatchSource(val uri: android.net.Uri, val quality: AttachmentPolicy.Quality, val kind: AttachmentPolicy.Kind, val sniffed: AttachmentPolicy.Sniffed?)
    private val batchSources = java.util.concurrent.ConcurrentHashMap<String, BatchSource>()
    private val runningBatches = java.util.Collections.synchronizedSet(HashSet<String>())

    /** At most two uploads at a time, the server's per-person limit. */
    private val uploadSlots = kotlinx.coroutines.sync.Semaphore(2)

    class MissingOriginal : Exception("Some files are no longer on this phone. Delete this message and pick them again.")

    /**
     * Sends up to [AttachmentPolicy.MAX_ITEMS] photos, videos or files as one message (an album), with one [caption].
     * The message appears at once; each file is then prepared at [quality], encrypted and uploaded in the background (it
     * carries on when you leave the conversation), and the message is sent once every file is uploaded. A failure leaves
     * the message FAILED with a reason; retrying resumes with the files that aren't uploaded yet. Returns the message id.
     */
    suspend fun sendBatch(
        cid: String, items: List<BatchItem>, photoQuality: AttachmentPolicy.Quality, caption: String, replyTo: String? = null,
        videoQuality: AttachmentPolicy.Quality = AttachmentPolicy.Quality.ORIGINAL, forwarded: Boolean = false, rich: RichContent? = null,
    ): String {
        val s = session.session ?: throw IllegalStateException("Not signed in")
        require(items.size in 1..AttachmentPolicy.MAX_ITEMS) { "1 to ${AttachmentPolicy.MAX_ITEMS} files" }
        val id = UUID.randomUUID().toString()
        val placeholders = items.mapIndexed { i, it ->
            val local = files.fileFor("$id-$i", it.name)
            val q = if (it.kind == AttachmentPolicy.Kind.VIDEO) videoQuality else photoQuality
            batchSources[local.name] = BatchSource(it.uri, q, it.kind, it.sniffed)
            AttachmentRef(
                AttachmentFiles.PENDING, it.name, AttachmentPolicy.sendMime(it.mime, it.kind, it.sniffed), it.size, "", "", local.name,
                voice = it.voiceDurationMs?.let { true }, durationMs = it.voiceDurationMs,
            )
        }
        val now = System.currentTimeMillis()
        db.messages().upsert(
            MessageEntity(
                id, cid, s.userId, s.deviceId, true, "text", caption, replyToId = replyTo, attachmentsJson = MessageColumns.encodeAttachments(placeholders),
                sentAt = now, sortTs = now, status = MessageStatus.SENDING, forwarded = forwarded, richJson = MessageColumns.encodeRich(rich),
            ),
        )
        db.conversations().bumpPreview(cid, id, MessagePreview.of(caption, placeholders, null), now, "You", 0, 0)
        startBatch(id)
        return id
    }

    private val batchJobs = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    private fun startBatch(id: String) {
        batchJobs[id] = scope.launch { try { processBatch(id) } finally { batchJobs.remove(id) } }
    }

    /**
     * Cancels a message whose files are still being prepared or uploaded (it hasn't been sent): the upload stops and the
     * message and its local copies are removed. Nothing reaches anyone. Returns false once the message has been sent.
     */
    suspend fun cancelBatch(id: String): Boolean {
        val m = db.messages().get(id) ?: return false
        if (m.status != MessageStatus.SENDING && m.status != MessageStatus.FAILED) return false
        if (db.outbox().get(id) != null) return false // already handed to the outbox: it's being sent
        batchJobs.remove(id)?.cancel()
        attachments(m).forEach { ref -> if (ref.id == AttachmentFiles.PENDING) batchSources.remove(ref.sha256) }
        files.deleteFor(id, attachments(m))
        db.messages().deleteLocal(id)
        db.refreshPreview(m.conversationId)
        return true
    }

    /**
     * The largest file this server accepts (its `/v1/server-info`), capped at the app's own limit. Cached for
     * [SERVER_LIMIT_TTL_MS], so a limit the server's operator raises (production ran 25 MB) applies without restarting Meldiq.
     */
    @Volatile private var serverMaxBytes: Pair<Long, Long>? = null // limit, when it was read
    suspend fun maxAttachmentBytes(): Long {
        serverMaxBytes?.let { (limit, at) -> if (System.currentTimeMillis() - at < SERVER_LIMIT_TTL_MS) return limit }
        val info = runCatching { api.get<com.meldiq.android.data.api.ServerInfo>("/v1/server-info") }.getOrNull()
        return AttachmentPolicy.effectiveMax(info?.attachmentMaxBytes, info?.fileMaxBytes)
            .also { if (info != null) serverMaxBytes = it to System.currentTimeMillis() }
    }

    /**
     * Forwards [m] to [destCid], which the person chose and confirmed. Text, contact cards, locations and animated
     * emoji go as a new message; files are decrypted copies on this phone (downloaded first if needed), encrypted again
     * with new keys and uploaded for the destination, because each conversation's files can only be fetched by its
     * members. Mentions aren't carried over. Returns the new message's id.
     */
    /** [origin]: where it came from, for a message forwarded out of a community channel (2026-10-23); else null. */
    suspend fun forward(m: MessageEntity, destCid: String, origin: com.meldiq.android.data.model.ForwardOrigin? = null): String {
        val refs = attachments(m).filter { it.id != AttachmentFiles.PENDING }
        val rich = rich(m)?.copy(origin = origin) ?: origin?.let { RichContent(origin = it) }
        if (refs.isEmpty()) return sendText(destCid, m.text, mentions = MentionSet.NONE, rich = rich, forwarded = true)
        val items = refs.map { ref ->
            val f = downloadAttachment(ref)
            val head = withContext(Dispatchers.IO) { f.inputStream().use { i -> ByteArray(64).let { b -> b.copyOf(i.read(b).coerceAtLeast(0)) } } }
            val sniffed = AttachmentPolicy.sniff(head)
            BatchItem(
                android.net.Uri.fromFile(f), ref.name, ref.mime, f.length(), AttachmentPolicy.kind(ref.mime, sniffed), sniffed,
                voiceDurationMs = if (ref.voice == true) ref.durationMs ?: 0 else null,
            )
        }
        val caption = if (m.text.isBlank()) "" else m.text
        return sendBatch(destCid, items, AttachmentPolicy.Quality.ORIGINAL, caption, forwarded = true, rich = rich)
    }

    private suspend fun processBatch(id: String) {
        if (!runningBatches.add(id)) return
        val m0 = db.messages().get(id) ?: run { runningBatches.remove(id); return }
        val cid = m0.conversationId
        val refs = attachments(m0).toMutableList()
        val total = refs.size
        suspend fun save() {
            db.messages().get(id)?.let { db.messages().upsert(it.copy(attachmentsJson = MessageColumns.encodeAttachments(refs))) }
        }
        fun progress(i: Int, stage: String, fraction: Float) {
            _batches.update { it + (id to BatchProgress(refs.count { r -> r.id != AttachmentFiles.PENDING }, total, stage)) }
            _transfer.update { it + (id to ((i + fraction.coerceIn(0f, 1f)) / total)) }
        }
        try {
            for (i in refs.indices) {
                val pending = refs[i]
                if (pending.id != AttachmentFiles.PENDING) continue
                val local = files.child(pending.sha256) ?: throw MissingOriginal()
                val what = if (total > 1) " ${i + 1} of $total" else ""
                var ref = pending
                if (!local.exists()) {
                    val src = batchSources[pending.sha256] ?: throw MissingOriginal()
                    progress(i, "Preparing$what", 0f)
                    ref = prepare(pending, local, src) { f -> progress(i, (if (src.kind == AttachmentPolicy.Kind.VIDEO) "Compressing video" else "Preparing") + what, f * 0.5f) }
                    batchSources.remove(pending.sha256)
                    refs[i] = ref
                    save()
                }
                progress(i, "Uploading$what", 0f)
                val uploaded = uploadSlots.withPermit {
                    val enc = File(context.cacheDir, "${local.name}.enc")
                    try {
                        // Over 25 MB: the chunked format, so neither side ever holds the whole file in memory.
                        val chunked = local.length() > AttachmentPolicy.LEGACY_MAX_FILE_BYTES
                        val meta = withContext(Dispatchers.IO) {
                            if (chunked) ChunkedAttachmentCrypto.encryptFile(local, enc) else AttachmentCrypto.encryptFile(local, enc)
                        }
                        val up = uploader.upload(cid, enc, meta.sha256) { p -> progress(i, "Uploading$what", 0.5f + p * 0.5f) }
                        // Batch B16: the size as shown, so the other phones keep the picture's space while it loads.
                        val dims = com.meldiq.android.media.MediaDims.of(local, ref.mime).takeIf { ref.voice != true }
                        AttachmentRef(
                            up.id, ref.name, ref.mime, local.length(), meta.key, meta.nonce, meta.sha256, ref.voice, ref.durationMs,
                            chunk = if (chunked) ChunkedAttachmentCrypto.DEFAULT_CHUNK else null,
                            w = dims?.first, h = dims?.second,
                        )
                    } finally {
                        enc.delete()
                    }
                }
                local.renameTo(files.fileFor(uploaded.id, uploaded.name))
                refs[i] = uploaded
                save()
            }
            val m = db.messages().get(id) ?: return
            sendText(cid, m.text, replyTo = m.replyToId, attachments = refs, presetId = id, forwarded = m.forwarded, mentions = if (m.forwarded) MentionSet.NONE else null, rich = rich(m))
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e // left SENDING; marked interrupted at the next start (failInterruptedUploads)
        } catch (e: ApiException) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: AttachmentTooLarge) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: NotEnoughSpace) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: MissingOriginal) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: com.meldiq.android.media.MediaPrep.TooLargeAfterCompression) {
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: com.meldiq.android.media.MediaPrep.CompressionFailed) {
            Log.w(TAG, "video compression failed: ${generateSequence(e.cause) { it.cause }.take(3).joinToString(" < ") { it.javaClass.simpleName }}")
            db.messages().setStatus(id, MessageStatus.FAILED, null, e.message)
        } catch (e: Exception) {
            Log.w(TAG, "attachment batch failed: ${e.javaClass.simpleName}")
            db.messages().setStatus(id, MessageStatus.FAILED, null, if (total > 1) "Couldn't send these files" else "Couldn't send this file")
        } finally {
            runningBatches.remove(id)
            _batches.update { it - id }
            _transfer.update { it - id }
        }
    }

    /**
     * Writes the file to send into [local] (which appears only when complete): the picked file as it is, or a Standard/HD
     * version of a photo or video. Returns the placeholder with its final name, type and size.
     */
    private suspend fun prepare(pending: AttachmentRef, local: File, src: BatchSource, onProgress: (Float) -> Unit): AttachmentRef {
        val compress = src.quality != AttachmentPolicy.Quality.ORIGINAL && AttachmentPolicy.compressible(src.kind, src.sniffed)
        // Large files (up to 1 GiB) need room for their copy and its encrypted copy: refuse early rather than fill the phone.
        if ((local.parentFile ?: context.filesDir).usableSpace < AttachmentPolicy.spaceNeeded(pending.size)) throw NotEnoughSpace()
        val part = File(local.parentFile, local.name + ".part")
        val raw = File(context.cacheDir, "prep-${local.name}")
        try {
            val copyTo = if (compress) raw else part
            val max = maxAttachmentBytes()
            copyFromUri(src.uri, copyTo, if (compress) AttachmentPolicy.MAX_SOURCE_BYTES else max)
            // The bytes read now must still be what was checked when it was picked (a file can change after picking).
            val head = copyTo.inputStream().use { i -> ByteArray(64).let { b -> b.copyOf(i.read(b).coerceAtLeast(0)) } }
            val kindNow = AttachmentPolicy.kind(pending.mime, AttachmentPolicy.sniff(head))
            var name = pending.name
            var mime = if (kindNow == src.kind) pending.mime else AttachmentPolicy.sendMime(pending.mime, kindNow, AttachmentPolicy.sniff(head))
            if (compress && kindNow == src.kind) {
                val done = when (src.kind) {
                    AttachmentPolicy.Kind.PHOTO -> com.meldiq.android.media.MediaPrep.photo(raw, part, name, src.quality)
                    else -> com.meldiq.android.media.MediaPrep.video(context, raw, part, name, src.quality, max, onProgress)
                }
                if (done == null) {
                    // Already within this quality: sent as it is, if it fits.
                    if (raw.length() > max) throw AttachmentTooLarge()
                    if (!raw.renameTo(part)) raw.copyTo(part, overwrite = true)
                } else {
                    name = done.name
                    mime = done.mime
                }
            } else if (compress) {
                if (raw.length() > max) throw AttachmentTooLarge()
                if (!raw.renameTo(part)) raw.copyTo(part, overwrite = true)
            }
            if (part.length() > max) throw AttachmentTooLarge()
            if (!part.renameTo(local)) throw java.io.IOException("couldn't store the prepared file")
            return pending.copy(name = name, mime = mime, size = local.length())
        } finally {
            part.delete()
            raw.delete()
        }
    }

    private suspend fun copyFromUri(uri: android.net.Uri, out: File, max: Long) = withContext(Dispatchers.IO) {
        val input = context.contentResolver.openInputStream(uri) ?: throw MissingOriginal()
        input.use { i ->
            out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = i.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > max) throw AttachmentTooLarge()
                    o.write(buf, 0, n)
                }
                if (total == 0L) throw java.io.IOException("empty file")
            }
        }
    }

    fun localAttachment(ref: AttachmentRef): File? =
        files.fileFor(ref.id, ref.name).takeIf { it.exists() } ?: files.child(ref.sha256)?.takeIf { ref.id == AttachmentFiles.PENDING && it.exists() }

    /**
     * Downloads the ciphertext to a partial file (resumed after an interruption), checks its hash, and
     * decrypts it next to the other attachments (T2.6). A corrupt partial file is discarded.
     */
    suspend fun downloadAttachment(ref: AttachmentRef): File {
        localAttachment(ref)?.let { return it }
        val part = File(context.cacheDir, "dl-${ref.id.replace(Regex("[^A-Za-z0-9_-]"), "_")}.part")
        _transfer.update { it + (ref.id to 0f) }
        try {
            TransferRetry.run { api.downloadTo("/v1/attachments/${ref.id}", part) { p -> _transfer.update { it + (ref.id to p) } } }
            val out = files.fileFor(ref.id, ref.name)
            try {
                withContext(Dispatchers.IO) {
                    val chunk = ref.chunk
                    if (chunk != null) ChunkedAttachmentCrypto.decryptFile(part, ref.key, ref.nonce, ref.sha256, chunk, out)
                    else AttachmentCrypto.decryptFile(part, ref.key, ref.nonce, ref.sha256, out)
                }
            } catch (e: EnvelopeException) {
                part.delete() // start over next time rather than resume corrupt bytes
                throw e
            }
            part.delete()
            return out
        } catch (e: ApiException) {
            if (e.status == 404) part.delete()
            throw e
        } finally {
            _transfer.update { it - ref.id }
        }
    }


    // ─────────────────────────── Outbox ───────────────────────────

    private suspend fun outboxLoop() {
        while (true) {
            if (session.session != null && realtime.state.value != ConnState.Offline) {
                runCatching { processOutbox() }.onFailure { Log.w(TAG, "outbox: ${it.javaClass.simpleName}") }
            }
            val next = db.outbox().nextDue()
            val wait = if (next == null) 60_000L else (next - System.currentTimeMillis()).coerceIn(300L, 60_000L)
            withTimeoutOrNull(wait) { kickCh.receive() }
        }
    }

    private suspend fun processOutbox() {
        for (item in db.outbox().due(System.currentTimeMillis())) sendOne(item)
    }

    /**
     * Sends one outbox entry to the server's message store (API 0.57.0, docs/SERVER_MESSAGES.md): the payload as it is,
     * over TLS; the server stores it and delivers it to every member's devices. Idempotent on the message id, so a retry
     * of an accepted message is answered as a duplicate.
     */
    private suspend fun sendOne(item: OutboxEntity) {
        session.session ?: return
        try {
            val now = System.currentTimeMillis()
            val sentAt = if (now - item.createdAt > 20 * 3600_000L) now else item.createdAt
            val payload = StoredEvents.payloadObject(item.payloadJson)
            // @everyone asks the server for its attestation, on every attempt.
            val mentionAll = item.cls == "message" && runCatching { json.decodeFromString(Payload.serializer(), item.payloadJson).mentionAll == true }.getOrDefault(false)
            val res = api.post<SendStoredReq, SendStoredRes>(
                "/v2/messages",
                SendStoredReq(item.conversationId, item.messageId, item.cls, sentAt, payload, mentionAll = if (mentionAll) true else null),
            )
            db.outbox().remove(item.messageId)
            if (item.visible) db.messages().markSent(item.messageId, res.serverTs)
            // Batch B3: under slowmode the composer counts down to the next allowed message.
            if (item.cls == "message") com.meldiq.android.data.model.SlowmodeRules.nextAfterPost(conversations.slowmode.value[item.conversationId], res.serverTs)
                ?.let { conversations.slowmodeWait(item.conversationId, it) }
        } catch (e: ApiException) {
            // Batch B3: slowmode isn't a failure. The message waits until the server allows the next one.
            if (e.status == 429 && e.code == "slowmode") {
                val next = com.meldiq.android.data.model.SlowmodeRules.nextFrom(e.details) ?: (System.currentTimeMillis() + SLOWMODE_FALLBACK_MS)
                conversations.slowmodeWait(item.conversationId, next)
                db.outbox().put(item.copy(nextAttemptAt = next + 250, lastError = e.message))
                return
            }
            // Batch B6: a message request's limit isn't transient: the message fails with the server's explanation.
            val transient = (e.isNetwork || e.status >= 500 || e.status == 429 || e.status == 401 || e.code == "decode") && e.code != "request_limit"
            if (transient && item.attempts < MAX_ATTEMPTS) {
                val backoff = BACKOFF.getOrElse(item.attempts) { BACKOFF.last() }
                db.outbox().put(item.copy(attempts = item.attempts + 1, nextAttemptAt = System.currentTimeMillis() + backoff, lastError = e.message))
            } else {
                db.outbox().remove(item.messageId)
                if (item.visible) db.messages().setStatus(item.messageId, MessageStatus.FAILED, null, e.message)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "send failed: ${e.javaClass.simpleName}")
            db.outbox().remove(item.messageId)
            if (item.visible) db.messages().setStatus(item.messageId, MessageStatus.FAILED, null, "Couldn't send this message")
        }
    }

    // ─────────────────────────── Receiving ───────────────────────────

    // ─────────────────────────── Call history ───────────────────────────

    /**
     * Writes or updates the conversation's entry for [call] from the server's record (docs/CALL_HISTORY.md). Idempotent:
     * one entry per call id, updated in place, so repeated events and syncs never duplicate it.
     */
    suspend fun recordCall(call: CallDto) {
        val me = session.session?.userId ?: return
        if (db.conversations().get(call.conversationId) == null) return
        // A voice room's comings and goings aren't calls in its history (docs/VOICE_ROOMS.md); an entry an earlier
        // build made is removed (phone test: opening the room added "Group voice call in progress").
        if (call.voiceRoom) {
            db.messages().deleteLocal("call-${call.id}")
            db.refreshPreview(call.conversationId)
            return
        }
        val declinedHere = db.calls().getLog(call.id)?.endReason == "declined"
        val info = CallHistory.summarize(call, me, declinedHere)
        val id = "call-${call.id}"
        val encoded = MessageColumns.encodeCall(info)
        val existing = db.messages().get(id)
        if (existing == null) {
            val mine = call.createdBy == me
            db.messages().insertIgnore(
                MessageEntity(
                    id = id, conversationId = call.conversationId, senderUserId = call.createdBy, senderDeviceId = "", outgoing = mine,
                    kind = "call", text = if (call.video) "Video call" else "Voice call", sentAt = call.createdAt, serverTs = call.createdAt,
                    sortTs = call.createdAt, status = if (mine) MessageStatus.SENT else MessageStatus.RECEIVED, callJson = encoded,
                ),
            )
        } else if (existing.kind == "call" && existing.conversationId == call.conversationId && existing.callJson != encoded) {
            db.messages().upsert(existing.copy(callJson = encoded))
        } else return
        db.refreshPreview(call.conversationId)
    }

    /** Brings the conversation's call entries up to date (on open). Servers before 2026-10-17 have no call list: skipped. */
    suspend fun syncCalls(cid: String) {
        val calls = runCatching { api.get<CallsRes>("/v1/conversations/$cid/calls?limit=50").calls }.getOrNull() ?: return
        for (c in calls.asReversed()) if (c.conversationId == cid) recordCall(c)
    }

    /** A call that never started because the request to start it failed: a local entry, so the attempt isn't lost. */
    suspend fun recordFailedCall(cid: String, video: Boolean) {
        val conv = db.conversations().get(cid) ?: return
        val me = session.session?.userId ?: return
        val now = System.currentTimeMillis()
        val id = "local-${UUID.randomUUID()}"
        val info = CallHistory.failedAttempt(id, video, me, conv.type != "DM")
        db.messages().insertIgnore(
            MessageEntity(
                id = "call-$id", conversationId = cid, senderUserId = me, senderDeviceId = "", outgoing = true, kind = "call",
                text = if (video) "Video call" else "Voice call", sentAt = now, sortTs = now, status = MessageStatus.SENT,
                callJson = MessageColumns.encodeCall(info),
            ),
        )
        db.refreshPreview(cid)
    }

    companion object {
        /** Self-only controls go to this person's own other devices alone (API 0.43.0). */
        private const val SELF_AUDIENCE = "self"
        const val MAX_ATTACHMENT_BYTES = 25L * 1024 * 1024
        private const val SERVER_LIMIT_TTL_MS = 10 * 60_000L
        /** More than a sender can attach (10), so an older or newer app's message still shows, but bounded. */
        const val MAX_RECEIVED_ATTACHMENTS = 20
        /** Outbox `lastError` marking a send paused by an identity change. */
        internal const val HELD_REASON = "identity_changed"
        private const val HELD_RECHECK_MS = 6 * 3600_000L
        private const val TAG = "Messages"
        private const val MAX_ATTEMPTS = 6
        /** When a slowmode refusal doesn't say when (it always should): try again after this. */
        private const val SLOWMODE_FALLBACK_MS = 5_000L
        private val BACKOFF = listOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L, 120_000L)
    }
}
