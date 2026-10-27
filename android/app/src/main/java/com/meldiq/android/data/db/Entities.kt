package com.meldiq.android.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Server-provided conversation metadata merged with local-only state (unread, mute, preview). */
@kotlinx.serialization.Serializable
@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val type: String,                 // DM | GROUP | CHANNEL
    val orgId: String?,
    val scope: String?,
    val scopeId: String?,
    val scopeName: String?,
    val kind: String?,                // PUBLIC | PRIVATE | ANNOUNCEMENT
    val name: String?,
    val topic: String?,
    val archived: Boolean,
    val memberCount: Int,
    val membersJson: String,          // List<MemberSummary> (≤12) for avatars / DM peer
    val joined: Boolean,
    val myRole: String?,
    val canPost: Boolean,
    val canManage: Boolean,
    val activeCallId: String?,
    val activeCallVideo: Boolean,
    val serverUpdatedAt: Long,
    // local
    val lastMessageId: String? = null,
    val lastMessagePreview: String? = null,
    val lastMessageAt: Long = 0,
    val lastSenderName: String? = null,
    val unreadCount: Int = 0,
    val mentionCount: Int = 0,
    val muted: Boolean = false,
    val draft: String? = null,
    val removed: Boolean = false,     // no longer a member (kept so history stays readable)
    /**
     * When the user archived this chat on this phone (swipe left in Chats; null: not archived). Local only: membership,
     * history and notifications are unchanged, and nothing is sent. Not the server's [archived] (a channel an admin made
     * read-only).
     */
    val archivedAt: Long? = null,
    /** A voice room (round 6, docs/VOICE_ROOMS.md). */
    @androidx.room.ColumnInfo(defaultValue = "0") val voice: Boolean = false,
    /** Voice rooms: the user ids in the room now (JSON list), from the server; null when nobody is in it. */
    val roomPeopleJson: String? = null,
    /** Communities (2026-10-21): the channel's category (null: none), its order in it, and "text" or "forum". */
    val categoryId: String? = null,
    val categoryName: String? = null,
    @androidx.room.ColumnInfo(defaultValue = "0") val position: Int = 0,
    /** API 0.48.0: its category's place among the community's categories, so categories keep their order before the list loads. */
    val categoryPosition: Int? = null,
    @androidx.room.ColumnInfo(defaultValue = "text") val format: String = "text",
    /** A forum's tags, JSON [{id, name}] from the server (null: none). Which tags a post has is inside the post. */
    val forumTagsJson: String? = null,
    /** Voice channels: may you join the call, and talk in it (listen-only otherwise)? True outside communities. */
    @androidx.room.ColumnInfo(defaultValue = "1") val canConnect: Boolean = true,
    @androidx.room.ColumnInfo(defaultValue = "1") val canSpeak: Boolean = true,
    /** While you're timed out in the channel's community: when it ends (null: not timed out). From the server. */
    val timedOutUntil: Long? = null,
    /** Batch B6: a message request, "incoming" (to you: listed under Requests, silent) or "outgoing"; null: none. */
    val request: String? = null,
    /** Batch B6b: a group's photo revision (null: none). */
    val photoRev: Long? = null,
)

@kotlinx.serialization.Serializable
@Entity(
    tableName = "messages",
    indices = [Index("conversationId", "sortTs"), Index("threadRootId"), Index("senderUserId")],
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val senderUserId: String,
    val senderDeviceId: String,
    val outgoing: Boolean,
    val kind: String,                 // text | call | system | undecryptable
    val text: String,
    val replyToId: String? = null,
    val threadRootId: String? = null,
    val mentionsJson: String = "[]",
    val attachmentsJson: String = "[]",
    val sentAt: Long,
    val serverTs: Long? = null,
    val sortTs: Long,
    val status: String,               // SENDING | SENT | DELIVERED | READ | FAILED | RECEIVED
    val errorText: String? = null,
    val editedAt: Long? = null,
    val deleted: Boolean = false,
    val pinned: Boolean = false,
    val reactionsJson: String = "{}", // emoji -> [userId]
    val readByJson: String = "[]",
    val deliveredToJson: String = "[]",
    val callJson: String? = null,
    /** Contact card, location or animated emoji ([com.meldiq.android.data.model.RichContent] JSON); null for plain messages. */
    val richJson: String? = null,
    /** Forwarded from another conversation. */
    @androidx.room.ColumnInfo(defaultValue = "0") val forwarded: Boolean = false,
)

/** Messages waiting to be encrypted & submitted. Plaintext lives only in the encrypted local DB. */
@Entity(tableName = "outbox", indices = [Index("nextAttemptAt")])
data class OutboxEntity(
    @PrimaryKey val messageId: String,
    val conversationId: String,
    val cls: String,
    val payloadJson: String,
    val createdAt: Long,
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0,
    val lastError: String? = null,
    val visible: Boolean = true,      // false for control messages (reactions, receipts…)
)

/** Directory cache + trust-on-first-use pin of each user's identity key. */
@kotlinx.serialization.Serializable
@Entity(tableName = "users")
data class UserEntity(
    @PrimaryKey val id: String,
    val username: String,
    val displayName: String,
    val avatarColor: Int,
    val statusText: String?,
    val pinnedIdentityKey: String?,
    val identityChanged: Boolean = false,
    val verified: Boolean = false,
    val online: Boolean = false,
    val lastSeenAt: Long? = null,
    val updatedAt: Long = 0,
    /** Profile photo revision visible to this account (null: none, or not shown to you). */
    val photoRev: Long? = null,
    /** Batch B6b: "idle" or "dnd" while they appear so (null: online or offline as [online] says, or unknown). */
    val presence: String? = null,
    /** API 0.45.0–0.46.0: their animated avatar, style and worn tag ([com.meldiq.android.data.model.PersonLooks]); null: none. */
    val lookJson: String? = null,
)

@Entity(tableName = "call_log", indices = [Index("conversationId")])
data class CallLogEntity(
    @PrimaryKey val callId: String,
    val conversationId: String,
    val video: Boolean,
    val outgoing: Boolean,
    val startedAt: Long,
    val answeredAt: Long? = null,
    val endedAt: Long? = null,
    val endReason: String? = null,
    val peerName: String? = null,
)

/** Media E2EE keys received through encrypted messages, kept only until the call ends. */
@Entity(tableName = "call_keys")
data class CallKeyEntity(
    @PrimaryKey val callId: String,
    val conversationId: String,
    val key: String,
    val fromUserId: String,
    val receivedAt: Long,
)

@Entity(tableName = "kv")
data class KvEntity(@PrimaryKey val k: String, val v: String)

/**
 * An incoming envelope from a contact whose identity key changed (T1.2). It was acknowledged to the
 * relay only after being stored here, and is opened if the user accepts the new key.
 */
@Entity(tableName = "quarantine", indices = [Index("senderUserId"), Index("conversationId")])
data class QuarantineEntity(
    @PrimaryKey val queueId: Long,
    val conversationId: String,
    val senderUserId: String,
    val itemJson: String,
    val receivedAt: Long,
    /** null: held for an identity change (T1.2). Otherwise why it was set aside after repeated failures (T1.4). */
    val reason: String? = null,
)

/** A control message (edit, delete, reaction, pin) that arrived before its target message (T2.1). */
@Entity(tableName = "pending_controls", indices = [Index(value = ["conversationId", "targetId"])])
data class PendingControlEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val targetId: String,
    val senderUserId: String,
    val payloadJson: String,
    val serverTs: Long,
    val receivedAt: Long,
    val expiresAt: Long,
)

/**
 * Messages and chats waiting to be added to the encrypted history on the server (docs/MESSAGE_HISTORY.md). Filled by
 * database triggers ([HistoryTriggers]) on every insert and meaningful change, so no code path that writes a message is
 * missed; [queuedAt] is a version that grows with every change, so an upload only clears what it actually sent.
 * [key] is "m:<message id>" or "c:<conversation id>".
 */
@Entity(tableName = "history_outbox", indices = [Index("queuedAt")])
data class HistoryOutboxEntity(@PrimaryKey val key: String, val queuedAt: Long)
