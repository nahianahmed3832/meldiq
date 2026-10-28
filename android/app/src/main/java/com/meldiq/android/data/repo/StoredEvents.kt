package com.meldiq.android.data.repo

import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.ImportItemDto
import com.meldiq.android.data.api.QueueItem
import com.meldiq.android.data.api.QueuePayload
import com.meldiq.android.data.api.StoredEventDto
import com.meldiq.android.data.db.MessageColumns
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.MentionRules
import com.meldiq.android.data.model.Payload
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Server-stored messages (API 0.56.0, the owner's decision of 2026-10-28, server docs/SERVER_MESSAGES.md): the pure
 * parts, unit-tested in `StoredEventsTest`. The payload is the JSON the app used to encrypt, now sent and stored as it is.
 */
object StoredEvents {
    /** The server takes message ids of 8–64 letters, digits, `-` and `_`. */
    private val ID = Regex("^[A-Za-z0-9_-]{8,64}$")

    /** Up to this many items per import call (the server takes 200). */
    const val IMPORT_BATCH = 150

    /** A stored event as the queue item the receiver applies (as the web's Receiver.ingest). */
    fun queueItem(e: StoredEventDto, queueId: Long = 0): QueueItem = QueueItem(
        id = queueId, kind = "message", conversationId = e.conversationId, messageId = e.id, senderUserId = e.senderUserId,
        senderDeviceId = e.senderDeviceId.orEmpty(), createdAt = e.serverTs, expiresAt = e.serverTs,
        payload = QueuePayload(cls = e.cls, sentAt = e.sentAt, serverTs = e.serverTs, mentionAll = if (e.mentionAll) true else null),
    )

    /** A payload as the JSON object the server stores. */
    fun payloadObject(p: Payload): JsonObject = GriipJson.encodeToJsonElement(Payload.serializer(), p).jsonObject

    /** An outbox entry's payload text as that object. */
    fun payloadObject(payloadJson: String): JsonObject = payloadObject(GriipJson.decodeFromString(Payload.serializer(), payloadJson))

    /** A kept message as the payload it was sent as (the inverse of the receiver's "text"), with its visible content. */
    fun payloadOf(m: MessageEntity): Payload {
        val r = MessageColumns.rich(m)
        val mentions = MentionRules.fromStored(MessageColumns.mentions(m))
        return Payload(
            type = "text", text = m.text, replyTo = m.replyToId, threadRoot = m.threadRootId, mentions = mentions.ids.ifEmpty { null },
            mentionAll = if (mentions.all) true else null, attachments = MessageColumns.attachments(m).ifEmpty { null },
            forwarded = if (m.forwarded) true else null, contact = r?.contact, location = r?.location, animoji = r?.animoji, link = r?.link,
            poll = r?.poll, sticker = r?.sticker, title = r?.title, tags = r?.tags?.ifEmpty { null }, customEmoji = r?.customEmoji?.ifEmpty { null },
            customSticker = r?.customSticker, origin = r?.origin,
        )
    }

    /**
     * What one kept message uploads as: the message, then its reactions, poll votes, closing and pin as the changes that
     * made them. Deleted messages, call lines, undecryptable placeholders and messages never sent upload nothing.
     */
    fun importItemsOf(m: MessageEntity): List<ImportItemDto> {
        if (m.deleted || m.kind != "text" || m.serverTs == null) return emptyList()
        val at = m.serverTs
        val sentAt = m.sentAt.takeIf { it > 0 } ?: at
        val items = ArrayList<ImportItemDto>()
        items += ImportItemDto(m.id, m.conversationId, m.senderUserId, "message", sentAt, at, payloadObject(payloadOf(m)))
        var n = 0
        fun change(suffix: String, sender: String, p: Payload) {
            val id = "${m.id.take(40)}-$suffix".take(64)
            items += ImportItemDto(id, m.conversationId, sender, "control", sentAt, at, payloadObject(p.copy(target = m.id)))
        }
        for ((emoji, users) in MessageColumns.reactions(m)) for (u in users) change("r${n++}", u, Payload(type = "reaction", emoji = emoji, add = true))
        val rich = MessageColumns.rich(m)
        for ((voter, choices) in rich?.votes.orEmpty()) change("v${n++}", voter, Payload(type = "vote", choices = choices))
        if (rich?.pollClosed == true) change("c", m.senderUserId, Payload(type = "poll_close"))
        if (m.pinned) change("p", m.senderUserId, Payload(type = "pin", pinned = true))
        return items.filter { ID.matches(it.id) }
    }

    /** Everything to upload, oldest first, each message followed by its changes. */
    fun importItems(kept: List<MessageEntity>): List<ImportItemDto> = kept.sortedBy { it.sortTs }.flatMap(::importItemsOf)
}
