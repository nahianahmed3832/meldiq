package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ClientEvent
import com.meldiq.android.data.api.RealtimeClient
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.ExpressionRules
import com.meldiq.android.data.model.MentionRules
import com.meldiq.android.data.model.MentionSet
import com.meldiq.android.data.model.Payload
import com.meldiq.android.data.model.PollRules
import com.meldiq.android.data.model.ReadRules

/**
 * Message controls: what you do to messages already sent (react, edit, delete, vote, close a poll, pin) and the read
 * and typing signals. Each changes this phone's copy at once and reaches the others as an encrypted control through
 * [sendControl] (the outbox); [MessageReceiver] applies the ones that arrive.
 */
class MessageControls(
    private val db: GriipDatabase,
    private val realtime: RealtimeClient,
    private val session: SessionRepository,
    private val conversations: ConversationRepository,
    private val settings: SettingsStore,
    private val files: AttachmentFiles,
    private val sendControl: suspend (cid: String, payload: Payload) -> Unit,
    /** A control for this person's own other devices only (audience "self"); false when it wasn't sent. */
    private val sendSelfControl: suspend (cid: String, payload: Payload) -> Boolean = { _, _ -> false },
) {
    private val lastReadSent = HashMap<String, Long>()
    private val myUserId get() = session.session?.userId

    /**
     * Resolves `@username` tokens against this conversation's members only. It used to look usernames up among every
     * user the phone knew, so a token could point at someone outside the conversation, or `@ann:other.server` at a
     * local "ann" (docs/MENTIONS.md).
     */
    internal suspend fun resolveMentions(cid: String, text: String): MentionSet {
        if (!text.contains('@')) return MentionSet.NONE
        val conv = db.conversations().get(cid) ?: return MentionSet.NONE
        if (conv.type == "DM") return MentionSet.NONE
        // What the phone already knows (no network wait while the composer still shows the message being sent).
        val members = conversations.knownMentionMembers(cid)
        return MentionRules.resolve(text, members, conversations.mentionAll.value[cid] == true, myUserId)
    }

    /**
     * Where the user can't post (announcement channels for non-managers, archived scopes), the server
     * refuses every envelope, controls included. Changing the message locally would show a reaction,
     * pin, edit or deletion that nobody else sees.
     */
    private suspend fun canSendIn(cid: String) = db.conversations().get(cid)?.canPost != false
    internal suspend fun inCommunity(cid: String) = db.conversations().get(cid)?.orgId != null

    suspend fun react(m: MessageEntity, emoji: String) {
        val me = myUserId ?: return
        if (!canSendIn(m.conversationId) || !ExpressionRules.reactionAllowed(emoji, inCommunity(m.conversationId))) return
        val current = MessageColumns.reactions(m)
        val add = current[emoji]?.contains(me) != true
        applyReaction(db.messages().get(m.id) ?: return, me, emoji, add) // fresh row: `m` may be stale
        sendControl(m.conversationId, Payload(type = "reaction", target = m.id, emoji = emoji, add = add))
    }

    /** Edits keep mention targets in step with the text (members only); @everyone stays as it was sent. */
    suspend fun edit(m: MessageEntity, newText: String, resolved: MentionSet? = null) {
        if (!m.outgoing || !canSendIn(m.conversationId)) return
        val ids = (resolved ?: resolveMentions(m.conversationId, newText)).ids
        val stored = MentionRules.stored(MentionSet(ids, MentionRules.fromStored(MessageColumns.mentions(m)).all))
        db.messages().upsert(m.copy(text = newText, editedAt = System.currentTimeMillis(), mentionsJson = MessageColumns.encodeIds(stored)))
        sendControl(m.conversationId, Payload(type = "edit", target = m.id, text = newText, mentions = ids))
    }

    suspend fun delete(m: MessageEntity) {
        if (!m.outgoing || !canSendIn(m.conversationId)) return
        files.deleteFor(m.id, MessageColumns.attachments(m)) // the decrypted copies go too (T1.10)
        db.messages().upsert(m.copy(deleted = true, text = "", attachmentsJson = "[]"))
        sendControl(m.conversationId, Payload(type = "delete", target = m.id))
        db.refreshPreview(m.conversationId)
    }

    /**
     * Your vote on the poll in [m] (docs/RICH_MESSAGES.md › Polls): shown here at once and sent to every member as an
     * encrypted "vote" control. An empty [choices] takes the vote back.
     */
    suspend fun vote(m: MessageEntity, choices: List<String>) {
        val me = myUserId ?: return
        if (!canSendIn(m.conversationId)) return
        val fresh = db.messages().get(m.id) ?: return
        val rich = MessageColumns.rich(fresh)?.takeIf { it.poll != null && it.pollClosed != true } ?: return
        val updated = PollRules.vote(rich, me, choices)
        db.messages().upsert(fresh.copy(richJson = MessageColumns.encodeRich(updated)))
        sendControl(m.conversationId, Payload(type = "vote", target = m.id, choices = updated.votes.orEmpty()[me].orEmpty()))
    }

    /** Closes your own poll for everyone: no more votes. */
    suspend fun closePoll(m: MessageEntity) {
        val me = myUserId ?: return
        if (!m.outgoing || !canSendIn(m.conversationId)) return
        val fresh = db.messages().get(m.id) ?: return
        val rich = MessageColumns.rich(fresh)?.takeIf { it.poll != null } ?: return
        db.messages().upsert(fresh.copy(richJson = MessageColumns.encodeRich(PollRules.close(rich, fresh.senderUserId, me))))
        sendControl(m.conversationId, Payload(type = "poll_close", target = m.id))
    }

    suspend fun setPinned(m: MessageEntity, pinned: Boolean) {
        if (!canSendIn(m.conversationId)) return
        db.messages().upsert(m.copy(pinned = pinned))
        sendControl(m.conversationId, Payload(type = "pin", target = m.id, pinned = pinned))
    }

    internal suspend fun applyReaction(t: MessageEntity, userId: String, emoji: String, add: Boolean) {
        val map = MessageColumns.reactions(t).toMutableMap()
        val set = map[emoji].orEmpty().toMutableList()
        if (add) { if (userId !in set) set += userId } else set.remove(userId)
        if (set.isEmpty()) map.remove(emoji) else map[emoji] = set
        db.messages().upsert(t.copy(reactionsJson = MessageColumns.encodeReactions(map)))
    }

    /**
     * Clear unread and (DMs/groups) send an encrypted read receipt. Channels and large groups send none; there, only
     * this person's own other devices hear "read up to here" (API 0.43.0), so reading here clears them on the web too.
     */
    suspend fun markConversationRead(cid: String) {
        db.conversations().markRead(cid)
        val conv = db.conversations().get(cid) ?: return
        val receipts = ReadRules.sendsReceipts(conv.type, conv.memberCount, conv.canPost) && settings.current.readReceipts
        val selfOnly = !ReadRules.sendsReceipts(conv.type, conv.memberCount, conv.canPost)
        if (!receipts && !selfOnly) return
        val latest = db.messages().latestIncoming(cid) ?: return
        val upTo = latest.serverTs ?: latest.sortTs
        if ((lastReadSent[cid] ?: 0) >= upTo) return
        lastReadSent[cid] = upTo
        if (receipts) sendControl(cid, Payload(type = "read", upTo = upTo))
        else if (!sendSelfControl(cid, Payload(type = "read", upTo = upTo))) lastReadSent.remove(cid)
    }

    private var lastTypingSent = 0L
    fun setTyping(cid: String, on: Boolean) {
        if (!settings.current.typingIndicators) return
        val now = System.currentTimeMillis()
        if (on && now - lastTypingSent < 2500) return
        lastTypingSent = if (on) now else 0
        realtime.send(ClientEvent.Typing(cid, on))
    }
}
