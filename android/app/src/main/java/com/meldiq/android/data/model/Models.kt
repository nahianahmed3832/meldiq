package com.meldiq.android.data.model

import kotlinx.serialization.Serializable

/** End-to-end encrypted payload (the plaintext inside griip-envelope-v1). */
@Serializable
data class Payload(
    val type: String,                       // text | edit | delete | reaction | pin | vote | poll_close | read | call_invite | call_key_request
    val text: String? = null,
    val replyTo: String? = null,
    val threadRoot: String? = null,
    val mentions: List<String>? = null,
    /** @everyone (docs/MENTIONS.md). Omitted unless true, so other messages keep their exact wire format. */
    val mentionAll: Boolean? = null,
    val attachments: List<AttachmentRef>? = null,
    val target: String? = null,
    val emoji: String? = null,
    val add: Boolean? = null,
    val pinned: Boolean? = null,
    val upTo: Long? = null,                 // read receipt: server timestamp cutoff
    val callId: String? = null,
    val video: Boolean? = null,
    val e2eeKey: String? = null,
    // Rich messages (2026-10-17, docs/RICH_MESSAGES.md). Always sent with a readable [text] fallback, so older apps show
    // the text; all omitted when absent, so other messages keep their exact wire format.
    val contact: ContactCard? = null,
    val location: SharedLocation? = null,
    /** An animated emoji: the emoji itself; [text] holds the same emoji. */
    val animoji: String? = null,
    /** Forwarded from another conversation (its sender isn't named). */
    val forwarded: Boolean? = null,
    /** 2026-10-23: where a forwarded message came from (a community channel only), shown as "Community • time ›". */
    val origin: ForwardOrigin? = null,
    /** A link preview made on the sender's phone (recipients never fetch the page). */
    val link: LinkPreview? = null,
    // Polls and stickers (2026-10-19, docs/RICH_MESSAGES.md). Sent with a readable [text] fallback like the rest.
    val poll: Poll? = null,
    /** A "vote" control: the chosen option ids of the poll in [target] (empty takes the vote back). */
    val choices: List<String>? = null,
    val sticker: StickerRef? = null,
    /**
     * A forum post's title (communities, 2026-10-21). [text] then starts with the title and a blank line, so apps
     * without forums still show it; omitted on every other message.
     */
    val title: String? = null,
    /** A forum post's tags: ids from the forum's tag list (Discord reference round, 2026-10-21); omitted elsewhere. */
    val tags: List<String>? = null,
    /** Batch B9: a community's own emoji used in [text] as `:name:`, and a community sticker (text: its `:name:`). */
    val customEmoji: List<CustomEmojiRef>? = null,
    val customSticker: CustomEmojiRef? = null,
)

/**
 * A poll (2026-10-19). Votes travel as end-to-end encrypted "vote" controls, like reactions: the server never sees
 * the question, the options or who voted for what. [multi] allows several choices.
 */
@Serializable
data class Poll(
    val question: String, val options: List<PollOption>, val multi: Boolean = false,
    /** Batch B8 (Discord POLL-CTRL-001): when voting ends (epoch ms); null: open until its creator closes it. */
    val endsAt: Long? = null,
)

/** [emoji]: batch B8, shown before the answer (older apps show the text only). */
@Serializable
data class PollOption(val id: String, val text: String, val emoji: String? = null)

/** A Meldiq sticker: its pack and id in the shared catalogue (shared/stickers, docs/STICKERS.md). */
@Serializable
data class StickerRef(val pack: String, val id: String)

/** Title and description of a link in the message, fetched by the sender's phone when they turned previews on. */
@Serializable
data class LinkPreview(val url: String, val title: String? = null, val description: String? = null, val siteName: String? = null)

/**
 * A shared contact. Since round 7 the app sends only Meldiq profile cards: the person's display name, Meldiq user id and
 * username, never a phone number or anything from the address book. [phones] and [emails] remain so cards received
 * from older apps still show; nothing new fills them.
 */
@Serializable
data class ContactCard(
    val name: String,
    val phones: List<String> = emptyList(),
    val emails: List<String> = emptyList(),
    val userId: String? = null,
    val username: String? = null,
)

/** A one-time location (never live): coordinates, accuracy in metres when known, and an optional place name. */
@Serializable
data class SharedLocation(val lat: Double, val lon: Double, val accuracyM: Float? = null, val label: String? = null)

/** What a message carries besides text and files (stored locally as JSON in `messages.richJson`). */
@Serializable
data class RichContent(
    val contact: ContactCard? = null,
    val location: SharedLocation? = null,
    val animoji: String? = null,
    val link: LinkPreview? = null,
    val poll: Poll? = null,
    /** A poll's votes as they arrived: voter's user id → chosen option ids. */
    val votes: Map<String, List<String>>? = null,
    /** The poll's creator closed it: no more votes. */
    val pollClosed: Boolean? = null,
    val sticker: StickerRef? = null,
    /** A forum post's title; the post's text still starts with it ([ForumRules.body] strips it for display). */
    val title: String? = null,
    /** A forum post's tag ids (the forum's tags name them). */
    val tags: List<String>? = null,
    /** Batch B9: community emoji shown inside the text, and a community sticker. */
    val customEmoji: List<CustomEmojiRef>? = null,
    val customSticker: CustomEmojiRef? = null,
    /** 2026-10-23: a forwarded message's source (see [ForwardOrigin]); not "structured": the text still shows. */
    val origin: ForwardOrigin? = null,
) {
    /** Replaces the text (a card, a poll, a sticker or an animated emoji) rather than accompanying it (a link preview). */
    val structured: Boolean get() = contact != null || location != null || animoji != null || poll != null || sticker != null || customSticker != null
}

/**
 * Where a forwarded message came from (2026-10-23, the reference's "Forwarded · Server • time ›"): the community's name,
 * when the original was sent, and its ids, so members of that channel can open it (a message link). Only for messages
 * forwarded out of a community channel; a DM's or group's origin is never sent. Inside the encrypted message.
 */
@Serializable
data class ForwardOrigin(val place: String? = null, val at: Long? = null, val conversationId: String? = null, val messageId: String? = null)

/**
 * Batch B9: a community's emoji or sticker as a message names it: which one ([id] in community [orgId]), its name, and
 * the image's SHA-256, so a phone shows the image only if the one it downloaded is the one the sender meant.
 */
@Serializable
data class CustomEmojiRef(val id: String, val orgId: String, val name: String, val sha256: String, val animated: Boolean = false)

@Serializable
data class AttachmentRef(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val key: String,
    val nonce: String,
    val sha256: String,
    // Voice messages (2026-10-16). Optional and omitted when absent, so other attachments keep their exact wire
    // format; older clients ignore these and show the clip as an ordinary audio file.
    val voice: Boolean? = null,
    val durationMs: Long? = null,
    /**
     * Large files (over 25 MB, 2026-10-17): encrypted in chunks of this many plaintext bytes (ChunkedAttachmentCrypto).
     * Absent: the original single-message format. Older apps can't open chunked files and say so.
     */
    val chunk: Int? = null,
    /**
     * Batch B16: a photo's or video's width and height as shown, so a chat keeps its space before it appears. Optional and
     * omitted when absent; older apps and the web ignore them. Checked with MediaDims.valid before use.
     */
    val w: Int? = null,
    val h: Int? = null,
    /** Separate encrypted derivative; the original descriptor and download remain unchanged. */
    val thumbnail: AttachmentThumbnail? = null,
    /** Local pending-message state only. Final sent references omit this field. */
    val pendingCipher: PendingAttachmentCipher? = null,
)

@Serializable
data class PendingAttachmentCipher(val key: String, val nonce: String, val sha256: String, val chunk: Int?, val cipherSize: Long)

@Serializable
data class AttachmentThumbnail(
    val id: String, val name: String, val mime: String, val size: Long,
    val key: String, val nonce: String, val sha256: String,
) {
    /** Received metadata is untrusted; previews never fetch an unbounded or active-content object. */
    fun asAttachment(): AttachmentRef? = if (size in 1..131072 && mime in setOf("image/jpeg", "image/png", "image/webp") && id.isNotBlank())
        AttachmentRef(id, name, mime, size, key, nonce, sha256) else null
}

@Serializable
data class MemberSummary(
    val id: String,
    val username: String,
    val displayName: String,
    val avatarColor: Int = 0,
    val role: String? = null,
    val online: Boolean? = null,
    /** Home server id of someone on another server (federation); null for people on this server. */
    val homeServer: String? = null,
    /** Profile photo revision when its owner shows it to everyone (server ≥ 2026-10-17). */
    val photoRev: Long? = null,
    /** Round 3: their status and emoji as you may see them, and whether they paused notifications. */
    val statusText: String? = null,
    val statusEmoji: String? = null,
    val notificationsPaused: Boolean? = null,
)

@Serializable
data class CallInfo(
    val callId: String,
    val video: Boolean,
    /** [CallHistory] outcome; null on entries written before call history (shown as a plain call). */
    val outcome: String? = null,
    /** Connected time in seconds, only when the server recorded both ends of it (never estimated). */
    val durationSec: Long? = null,
    /** Who started the call (user id). */
    val startedBy: String? = null,
    /** How many people connected, for group calls (null: not known). */
    val joined: Int? = null,
    val group: Boolean = false,
)

object MessageStatus {
    const val SENDING = "SENDING"
    const val SENT = "SENT"
    const val DELIVERED = "DELIVERED"
    const val READ = "READ"
    const val FAILED = "FAILED"
    const val RECEIVED = "RECEIVED"

    /** Not sent yet: a member's security key changed and the user hasn't reviewed it (T1.2). */
    const val HELD = "HELD"
}
