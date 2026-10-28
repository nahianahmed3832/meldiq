package com.meldiq.android.data.repo

import android.content.Context
import android.util.Log
import com.meldiq.android.crypto.EnvelopeException
import com.meldiq.android.crypto.EnvelopeHeader
import com.meldiq.android.crypto.MessageCrypto
import com.meldiq.android.crypto.ReceivedEnvelope
import com.meldiq.android.data.api.AckReq
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.CallRes
import com.meldiq.android.data.api.ClientEvent
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.api.QueueItem
import com.meldiq.android.data.api.QueuePayload
import com.meldiq.android.data.api.QueueRes
import com.meldiq.android.data.api.RealtimeClient
import com.meldiq.android.data.db.CallKeyEntity
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.db.QuarantineEntity
import com.meldiq.android.data.model.AttachmentPolicy
import com.meldiq.android.data.model.CallInfo
import com.meldiq.android.data.model.ExpressionRules
import com.meldiq.android.data.model.MentionNotify
import com.meldiq.android.data.model.MentionRules
import com.meldiq.android.data.model.MentionSet
import com.meldiq.android.data.model.MessagePreview
import com.meldiq.android.data.model.MessageStatus
import com.meldiq.android.data.model.Payload
import com.meldiq.android.data.model.PollRules
import com.meldiq.android.data.model.RequestRules
import com.meldiq.android.data.model.RichRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Receiving, part 2: queue items. Each is verified and decrypted, applied to the local database (messages, controls,
 * receipts, call keys) and acknowledged only once that's committed or it's safely kept ([QueueProcessor]). Items that
 * can't be opened yet are quarantined or set aside, never lost.
 */
class MessageReceiver(
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
    private val files: AttachmentFiles,
    private val keyRequests: CallKeyRequests,
    private val signals: MessageSignals,
    private val controls: MessageControls,
    private val notify: (Notice) -> Unit,
    private val sendControl: suspend (cid: String, payload: Payload) -> Unit,
    private val kick: () -> Unit,
) {
    /** Round 3: the person's notification level for a conversation (set by the container from NavPreferences). */
    var notifyLevelOf: (ConversationEntity) -> String = { com.meldiq.android.data.model.NotifyLevel.ALL }
    /** Batch B2: whether @everyone counts as a mention in the conversation's community (set by the container). */
    var countsEveryoneOf: (ConversationEntity) -> Boolean = { true }

    private val json = GriipJson
    private val processLock = Mutex()
    private val pending = PendingControls(RoomPendingControlStore(db))
    private val callKeys = CallKeyVerifier { id ->
        try {
            api.get<CallRes>("/v1/calls/$id").call
        } catch (e: ApiException) {
            if (e.status == 404) null else throw e // other failures: redelivered and checked again
        }
    }
    private val myUserId get() = session.session?.userId
    private val myDeviceId get() = session.session?.deviceId

    /** Acknowledges an item only once its local state is committed or it's safely kept (T1.4, [QueueProcessor]). */
    private val processor = QueueProcessor(
        apply = { handleItem(it) },
        undecryptable = { item, reason -> recordUndecryptable(item, reason) },
        quarantine = { quarantine(it) },
        setAside = { item, e -> setAside(item, e) },
    )

    internal suspend fun processQueue(items: List<QueueItem>, backlog: Boolean) = processLock.withLock {
        val acks = processor.process(items)
        if (acks.size < items.size) Log.w(TAG, "deferring ${items.size - acks.size} queue item(s) for redelivery")
        if (acks.isNotEmpty() || backlog) {
            val sent = realtime.send(ClientEvent.Ack(acks, backlog))
            if (!sent && acks.isNotEmpty()) runCatching { api.post<AckReq, OkRes>("/v1/queue/ack", AckReq(acks)) }
        }
    }

    /** REST fallback used by the background service when the socket is unavailable. */
    suspend fun pollQueueOnce() {
        val r = api.get<QueueRes>("/v1/queue?limit=100")
        if (r.items.isEmpty()) return
        val acks = processLock.withLock { processor.process(r.items) }
        if (acks.isNotEmpty()) api.post<AckReq, OkRes>("/v1/queue/ack", AckReq(acks))
    }

    /**
     * Retries items set aside after repeated failures (for example after an app update fixed the
     * cause). Called at start-up; whatever still fails stays set aside.
     */
    internal suspend fun retrySetAside() = processLock.withLock {
        pending.purgeExpired()
        // Uploads cut off by the app being killed: offer a retry instead of "sending" forever (T2.6).
        db.messages().failInterruptedUploads("Upload interrupted · tap to retry")
        context.cacheDir.listFiles { f -> f.name.endsWith(".enc") }?.forEach { it.delete() }
        for (q in db.quarantine().setAside()) {
            val item = runCatching { json.decodeFromString(QueueItem.serializer(), q.itemJson) }.getOrNull() ?: continue
            if (runCatching { handleItem(item) }.isSuccess) db.quarantine().remove(q.queueId)
        }
    }

    /**
     * A stored message or change (API 0.56.0, docs/SERVER_MESSAGES.md): from the delivery queue, a history page, the
     * summary or search. Applied as a decrypted envelope was: nothing to open, the server already checked who may send
     * and change what. [history]: loaded, not just arrived: shown, never counted unread, notified, rung or marked read.
     */
    suspend fun ingest(e: com.meldiq.android.data.api.StoredEventDto, queueId: Long = 0, history: Boolean = false) {
        if (myUserId == null) throw ApiException(0, "not_signed_in", "Not signed in yet")
        val item = StoredEvents.queueItem(e, queueId)
        val existing = db.messages().get(e.id)
        if (existing != null && e.cls == "message" && existing.kind != "undecryptable") return // already here
        val payload = json.decodeFromJsonElement(Payload.serializer(), e.payload)
        val conv = db.conversations().get(e.conversationId) ?: runCatching { conversations.refreshOne(e.conversationId) }.getOrNull()
        if (db.users().get(e.senderUserId)?.displayName.isNullOrEmpty()) runCatching { users.fetch(e.senderUserId) }
        apply(payload, item, conv, e.senderUserId == myUserId, e.serverTs, history)
    }

    private suspend fun handleItem(item: QueueItem) {
        // Never "succeed" without a session: that would acknowledge (and lose) the item unprocessed.
        val me = myUserId ?: throw ApiException(0, "not_signed_in", "Not signed in yet")
        val myDevice = myDeviceId ?: throw ApiException(0, "not_signed_in", "Not signed in yet")
        // API 0.56.0: a stored message, sent as it is (no envelope to open).
        if (item.kind == "message") {
            val event = item.payload.event ?: throw EnvelopeException("malformed message")
            return ingest(event, item.id)
        }
        if (item.kind == "receipt") {
            if (item.payload.status == "delivered") {
                val m = db.messages().get(item.messageId) ?: return
                if (!m.outgoing) return
                val d = (MessageColumns.deliveredTo(m) + item.senderUserId).distinct()
                db.messages().upsert(m.copy(deliveredToJson = MessageColumns.encodeIds(d)))
                db.messages().markDelivered(m.id)
            }
            return
        }
        val p = item.payload
        val existing = db.messages().get(item.messageId)
        // A duplicate delivery is ignored, but a placeholder left by an earlier failure may be replaced.
        val placeholder = existing?.kind == "undecryptable" && existing.senderUserId == item.senderUserId
        if (existing != null && p.cls == "message" && !placeholder) return
        val signingKey = when (val k = directory.senderKey(item.senderUserId, item.senderDeviceId, p.serverTs ?: item.createdAt)) {
            is SenderKey.Trusted -> k.signingKey
            SenderKey.IdentityChanged -> throw SenderIdentityChanged()
            SenderKey.Unknown -> throw EnvelopeException("unknown or uncertified sender device")
        }
        val header = EnvelopeHeader(item.messageId, item.conversationId, item.senderUserId, item.senderDeviceId, p.sentAt ?: 0, p.cls ?: "message")
        val env = ReceivedEnvelope(
            header,
            p.nonce ?: throw EnvelopeException("malformed envelope"), p.ciphertext ?: throw EnvelopeException("malformed envelope"),
            p.signature ?: throw EnvelopeException("malformed envelope"), p.enc ?: throw EnvelopeException("malformed envelope"),
            p.wrappedKey ?: throw EnvelopeException("malformed envelope"),
        )
        val plain = crypto.open(env, signingKey, myDevice)
        val payload = json.decodeFromString(Payload.serializer(), String(plain))
        val conv = db.conversations().get(item.conversationId) ?: conversations.refreshOne(item.conversationId)
        if (db.users().get(item.senderUserId)?.displayName.isNullOrEmpty()) runCatching { users.fetch(item.senderUserId) }
        apply(payload, item, conv, item.senderUserId == me, p.serverTs ?: item.createdAt)
    }

    private suspend fun apply(pl: Payload, item: QueueItem, conv: ConversationEntity?, mine: Boolean, serverTs: Long, history: Boolean = false) {
        val me = myUserId ?: throw ApiException(0, "not_signed_in", "Not signed in yet")
        when (pl.type) {
            "text" -> {
                // Names are cleaned for display (no hidden or direction-changing characters that could disguise a type).
                val atts = pl.attachments.orEmpty().take(MessageRepository.MAX_RECEIVED_ATTACHMENTS).map { it.copy(name = AttachmentPolicy.safeName(it.name)) }
                // @everyone counts only with the server's mark on this copy, in a group or channel; a claim inside the
                // payload alone (or from another server) is plain text (docs/MENTIONS.md).
                val received = MentionRules.received(pl.mentions, pl.mentionAll, item.payload.mentionAll, conv?.type)
                val m = MessageEntity(
                    id = item.messageId, conversationId = item.conversationId, senderUserId = item.senderUserId, senderDeviceId = item.senderDeviceId,
                    outgoing = mine, kind = "text", text = pl.text.orEmpty(), replyToId = pl.replyTo, threadRootId = pl.threadRoot,
                    mentionsJson = MessageColumns.encodeIds(MentionRules.stored(received)), attachmentsJson = MessageColumns.encodeAttachments(atts),
                    sentAt = item.payload.sentAt ?: serverTs, serverTs = serverTs, sortTs = serverTs,
                    status = if (mine) MessageStatus.SENT else MessageStatus.RECEIVED,
                    richJson = MessageColumns.encodeRich(RichRules.fromPayload(pl)),
                    forwarded = pl.forwarded == true,
                )
                if (db.messages().insertIgnore(m) == -1L) return
                replayPending(item.conversationId, item.messageId, conv, me)
                if (history) {
                    // Loaded history: the list's preview follows the newest message (the server's summary sets unread counts).
                    if (pl.threadRoot == null) {
                        val sender = if (mine) "You" else db.users().get(item.senderUserId)?.displayName ?: "Someone"
                        db.conversations().bumpPreview(item.conversationId, item.messageId, MessagePreview.of(pl), serverTs, sender, 0, 0)
                    }
                    return
                }
                val viewing = appState.foreground.value && appState.viewingConversation.value == item.conversationId
                val mention = MentionNotify.isMention(mine, me in received.ids, received.all, conv?.let { countsEveryoneOf(it) } ?: true)
                // A muted conversation still notifies when someone mentions you by name; @everyone respects the mute.
                val personalMention = !mine && me in received.ids
                val unread = if (!mine && !viewing) 1 else 0
                val senderName = if (mine) "You" else db.users().get(item.senderUserId)?.displayName ?: "Someone"
                if (pl.threadRoot == null) {
                    db.conversations().bumpPreview(item.conversationId, item.messageId, MessagePreview.of(pl), serverTs, senderName, unread, if (mention && !viewing) 1 else 0)
                } else if (unread > 0) db.conversations().bumpUnread(item.conversationId, 0, if (mention) 1 else 0)
                if (viewing && !mine) scope.launch { controls.markConversationRead(item.conversationId) }
                val muted = conv?.muted == true
                val level = conv?.let { notifyLevelOf(it) } ?: com.meldiq.android.data.model.NotifyLevel.ALL
                // Batch B6: a message request never notifies; it waits under Requests.
                val request = conv?.request == RequestRules.INCOMING
                if (!mine && !viewing && !request && MentionNotify.shouldNotify(settings.current.notifications, level, muted, mention, personalMention)) {
                    val title = conv?.let { ConversationRepository.title(it, me) } ?: senderName
                    notify(Notice(item.conversationId, if (conv?.type == "CHANNEL") "#$title" else title, senderName, MessagePreview.of(pl), mention, conv?.type != "DM", canReply = conv?.canPost != false))
                }
            }
            "edit" -> {
                val t = target(pl, item, serverTs) ?: return
                if (t.senderUserId == item.senderUserId && !t.deleted) {
                    // New text, new mention targets (no new notification); @everyone stays as it was when sent.
                    val mentionsJson = pl.mentions?.let { ids ->
                        MessageColumns.encodeIds(MentionRules.stored(MentionSet(ids.distinct(), MentionRules.fromStored(MessageColumns.mentions(t)).all)))
                    } ?: t.mentionsJson
                    db.messages().upsert(t.copy(text = pl.text.orEmpty(), editedAt = serverTs, mentionsJson = mentionsJson))
                    if (db.conversations().get(t.conversationId)?.lastMessageId == t.id) db.refreshPreview(t.conversationId)
                }
            }
            "delete" -> {
                val t = target(pl, item, serverTs) ?: return
                if (t.senderUserId == item.senderUserId) {
                    files.deleteFor(t.id, MessageColumns.attachments(t))
                    db.messages().upsert(t.copy(deleted = true, text = "", attachmentsJson = "[]"))
                    db.refreshPreview(t.conversationId)
                }
            }
            "reaction" -> {
                // One emoji, not text: anything else from a modified client is dropped (docs/EMOJI.md). In a community a
                // reaction may also be one of its own emoji's `:name:` (batch B12).
                val emoji = pl.emoji?.takeIf { ExpressionRules.reactionAllowed(it, controls.inCommunity(item.conversationId)) } ?: return
                controls.applyReaction(target(pl, item, serverTs) ?: return, item.senderUserId, emoji, pl.add != false)
            }
            "pin" -> {
                val t = target(pl, item, serverTs) ?: return
                db.messages().upsert(t.copy(pinned = pl.pinned == true))
            }
            "vote" -> {
                val t = target(pl, item, serverTs) ?: return
                val rich = MessageColumns.rich(t)?.takeIf { it.poll != null } ?: return
                val updated = PollRules.vote(rich, item.senderUserId, pl.choices.orEmpty().take(PollRules.MAX_OPTIONS), serverTs)
                if (updated != rich) db.messages().upsert(t.copy(richJson = MessageColumns.encodeRich(updated)))
            }
            "poll_close" -> {
                val t = target(pl, item, serverTs) ?: return
                val rich = MessageColumns.rich(t)?.takeIf { it.poll != null } ?: return
                val updated = PollRules.close(rich, t.senderUserId, item.senderUserId)
                if (updated != rich) db.messages().upsert(t.copy(richJson = MessageColumns.encodeRich(updated)))
            }
            "read" -> {
                val upTo = pl.upTo ?: return
                if (mine && history) return
                if (mine) {
                    // Read on another of this person's devices: cleared here too, unless something newer arrived since.
                    val latest = db.messages().latestIncoming(item.conversationId)
                    if (com.meldiq.android.data.model.ReadRules.clearsHere(upTo, latest?.let { it.serverTs ?: it.sortTs })) db.conversations().markRead(item.conversationId)
                } else {
                    for (m in db.messages().outgoingUpTo(item.conversationId, upTo)) {
                        val r = (MessageColumns.readBy(m) + item.senderUserId).distinct()
                        db.messages().upsert(m.copy(readByJson = MessageColumns.encodeIds(r), status = MessageStatus.READ))
                    }
                }
            }
            "call_key_request" -> {
                if (history) return // an old request is history, not a live call
                // Only the call's creator answers, in the call's own conversation, while the call is live (T5.3).
                val callId = pl.callId ?: return
                val k = db.calls().key(callId) ?: return
                if (k.conversationId != item.conversationId || !keyRequests.shouldAnswer(callId)) return
                val call = runCatching { api.get<CallRes>("/v1/calls/$callId").call }.getOrNull() ?: return // the joiner asks again
                if (call.state == "ENDED") return
                // The creator answers; in a voice room, so does anyone connected who holds the key (docs/VOICE_ROOMS.md).
                val mayAnswer = (k.fromUserId == me && call.createdBy == me) || (call.voiceRoom && call.participants.any { it.userId == me })
                if (!mayAnswer) return
                sendControl(item.conversationId, Payload(type = "call_invite", callId = callId, video = call.video, e2eeKey = k.key))
            }
            "call_invite" -> {
                // An old call's invitation is history: the call log shows the call; it doesn't ring or set a key.
                if (history) return
                val callId = pl.callId ?: return
                val key = pl.e2eeKey ?: return
                if (db.calls().key(callId) != null) {
                    Log.w(TAG, "ignoring second media key for an existing call")
                    return
                }
                val verdict = callKeys.check(callId, item.conversationId, item.senderUserId)
                if (verdict != CallKeyVerifier.Verdict.ACCEPT) {
                    Log.w(TAG, "ignoring call key: $verdict") // T5.2: only the call's creator sets its key
                    return
                }
                if (db.calls().putKeyIfAbsent(CallKeyEntity(callId, item.conversationId, key, item.senderUserId, System.currentTimeMillis())) == -1L) {
                    Log.w(TAG, "ignoring second media key for an existing call")
                    return
                }
                val info = CallInfo(callId, pl.video == true)
                // A voice room's key: joining the room isn't a call to record in its conversation.
                val voiceRoom = db.conversations().get(item.conversationId)?.voice == true
                if (!voiceRoom) db.messages().insertIgnore(
                    MessageEntity(
                        id = "call-$callId", conversationId = item.conversationId, senderUserId = item.senderUserId, senderDeviceId = item.senderDeviceId,
                        outgoing = mine, kind = "call", text = if (pl.video == true) "Video call" else "Voice call", sentAt = serverTs, serverTs = serverTs,
                        sortTs = serverTs, status = if (mine) MessageStatus.SENT else MessageStatus.RECEIVED, callJson = MessageColumns.encodeCall(info),
                    ),
                )
                if (!mine) signals.emitCallInvite(IncomingCallKey(callId, item.conversationId, item.senderUserId, pl.video == true))
            }
        }
    }

    /**
     * The message a control refers to, only if it's in the control's own conversation (T3.4). A target
     * that hasn't arrived yet holds the control until it does (T2.1); one in another conversation is ignored.
     */
    private suspend fun target(pl: Payload, item: QueueItem, serverTs: Long): MessageEntity? {
        val id = pl.target ?: return null
        val t = db.messages().get(id)
        if (t == null) {
            pending.hold(item.messageId, item.conversationId, id, item.senderUserId, json.encodeToString(Payload.serializer(), pl), serverTs)
            return null
        }
        return t.takeIf { it.conversationId == item.conversationId }
    }

    /** Applies, in their original order, the controls that arrived before this message. */
    private suspend fun replayPending(conversationId: String, messageId: String, conv: ConversationEntity?, me: String) {
        for (c in pending.takeFor(conversationId, messageId)) {
            val pl = runCatching { json.decodeFromString(Payload.serializer(), c.payloadJson) }.getOrNull() ?: continue
            val item = QueueItem(0, "envelope", c.conversationId, c.id, c.senderUserId, "", c.serverTs, c.expiresAt, QueuePayload(cls = "control", serverTs = c.serverTs))
            apply(pl, item, conv, c.senderUserId == me, c.serverTs)
        }
    }


    /** Kept locally, then acknowledged: opened later if the user accepts the sender's new key (T1.2). */
    private suspend fun quarantine(item: QueueItem) {
        db.quarantine().put(QuarantineEntity(item.id, item.conversationId, item.senderUserId, json.encodeToString(QueueItem.serializer(), item), System.currentTimeMillis()))
    }

    /**
     * An item that kept failing for an unexpected reason (a local database error or a bug): kept on
     * the phone with the reason, shown in the conversation, and retried at start-up (T1.4).
     */
    private suspend fun setAside(item: QueueItem, e: Throwable) {
        Log.w(TAG, "setting aside queue item after repeated failures: ${e.javaClass.simpleName}")
        db.quarantine().put(
            QuarantineEntity(item.id, item.conversationId, item.senderUserId, json.encodeToString(QueueItem.serializer(), item), System.currentTimeMillis(), reason = "failed: ${e.javaClass.simpleName}"),
        )
        if (item.payload.cls == "message") {
            db.messages().insertIgnore(
                MessageEntity(
                    id = item.messageId, conversationId = item.conversationId, senderUserId = item.senderUserId, senderDeviceId = item.senderDeviceId,
                    outgoing = false, kind = "undecryptable", text = "This message couldn't be processed. It's kept on this phone and will be tried again when the app restarts.",
                    sentAt = item.createdAt, serverTs = item.createdAt, sortTs = item.createdAt, status = MessageStatus.RECEIVED, errorText = e.javaClass.simpleName,
                ),
            )
        }
    }

    /**
     * The user reviewed [identityKey] (the safety number they compared) and accepts it for [userId]:
     * pin it, resume paused sends and open the messages held while the key was untrusted.
     */
    suspend fun acceptIdentity(userId: String, identityKey: String) {
        directory.acceptIdentity(userId, identityKey)
        db.messages().resumeHeld()
        db.outbox().resume(MessageRepository.HELD_REASON, System.currentTimeMillis())
        kick()
        processLock.withLock {
            for (q in db.quarantine().heldForIdentity(userId)) {
                val item = runCatching { json.decodeFromString(QueueItem.serializer(), q.itemJson) }.getOrNull()
                if (item == null) {
                    db.quarantine().remove(q.queueId)
                    continue
                }
                try {
                    handleItem(item)
                    db.quarantine().remove(q.queueId)
                } catch (_: SenderIdentityChanged) {
                    // Still untrusted (the server presents yet another key): keep holding it.
                } catch (_: ApiException) {
                    // Keys unreachable right now: try again on the next acceptance or app start.
                } catch (e: EnvelopeException) {
                    recordUndecryptable(item, e.message ?: "")
                    db.quarantine().remove(q.queueId)
                }
            }
        }
    }

    private suspend fun recordUndecryptable(item: QueueItem, reason: String) {
        if (item.payload.cls != "message") return
        db.messages().insertIgnore(
            MessageEntity(
                id = item.messageId, conversationId = item.conversationId, senderUserId = item.senderUserId, senderDeviceId = item.senderDeviceId,
                outgoing = false, kind = "undecryptable", text = "This message couldn't be verified or decrypted and was discarded.",
                sentAt = item.createdAt, serverTs = item.createdAt, sortTs = item.createdAt, status = MessageStatus.RECEIVED, errorText = reason,
            ),
        )
    }

    private companion object {
        const val TAG = "Messages"
    }
}
