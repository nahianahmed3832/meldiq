package com.meldiq.android.data.db

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

@Dao
interface ConversationDao {
    // `id` breaks ties (chats with no messages created together, messages in the same millisecond), so rows never swap
    // places between two reads of the same data.
    @Query("SELECT * FROM conversations WHERE removed = 0 ORDER BY CASE WHEN lastMessageAt > 0 THEN lastMessageAt ELSE serverUpdatedAt END DESC, id")
    fun observeAll(): Flow<List<ConversationEntity>>

    /** A live call in this conversation, from the server's call events (UI-003: the "Join" banners follow them). */
    @Query("UPDATE conversations SET activeCallId = :callId, activeCallVideo = :video WHERE id = :cid")
    suspend fun setActiveCall(cid: String, callId: String, video: Boolean)

    /** That call ended: the banner goes, unless another call has started there meanwhile. */
    @Query("UPDATE conversations SET activeCallId = NULL, roomPeopleJson = NULL WHERE id = :cid AND activeCallId = :callId")
    suspend fun clearActiveCall(cid: String, callId: String)

    /** Voice rooms: who is in the room now (JSON list of user ids), from the call's own events. */
    @Query("UPDATE conversations SET roomPeopleJson = :json WHERE id = :cid")
    suspend fun setRoomPeople(cid: String, json: String?)

    @Query("SELECT * FROM conversations WHERE id = :id")
    fun observe(id: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun get(id: String): ConversationEntity?

    @Query("SELECT * FROM conversations")
    suspend fun all(): List<ConversationEntity>

    /** Restoring a backup: adds chats this phone doesn't have; never replaces one it has. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(c: ConversationEntity): Long

    @Upsert
    suspend fun upsert(c: ConversationEntity)

    @Query("UPDATE conversations SET unreadCount = 0, mentionCount = 0 WHERE id = :id")
    suspend fun markRead(id: String)

    @Query("UPDATE conversations SET muted = :muted WHERE id = :id")
    suspend fun setMuted(id: String, muted: Boolean)

    /** Archive ([at] = now) or restore ([at] = null) a chat on this phone. */
    @Query("UPDATE conversations SET archivedAt = :at WHERE id = :id")
    suspend fun setArchived(id: String, at: Long?)

    /** Marked unread on this phone: at least one unread (no receipt changes; opening the chat clears it). */
    @Query("UPDATE conversations SET unreadCount = CASE WHEN unreadCount = 0 THEN 1 ELSE unreadCount END WHERE id = :id")
    suspend fun markUnread(id: String)

    /** Mark unread from a message (the conversation's menu): [n] messages count as unread again. */
    @Query("UPDATE conversations SET unreadCount = :n WHERE id = :id")
    suspend fun setUnread(id: String, n: Int)

    @Query("UPDATE conversations SET draft = :draft WHERE id = :id")
    suspend fun setDraft(id: String, draft: String?)

    @Query("UPDATE conversations SET removed = 1, canPost = 0 WHERE id = :id")
    suspend fun markRemoved(id: String)

    /** Batch B6: a message request you declined leaves this phone entirely. */
    @Query("DELETE FROM conversations WHERE id = :id")
    suspend fun deleteLocal(id: String)

    /** A deleted organization's channels: kept on this phone as left, so their history stays readable. */
    @Query("UPDATE conversations SET removed = 1, canPost = 0, activeCallId = NULL WHERE orgId = :orgId")
    suspend fun markOrgRemoved(orgId: String)

    @Query("UPDATE conversations SET lastMessageId = :mid, lastMessagePreview = :preview, lastMessageAt = :at, lastSenderName = :sender, unreadCount = unreadCount + :unreadInc, mentionCount = mentionCount + :mentionInc WHERE id = :id AND lastMessageAt <= :at")
    suspend fun bumpPreview(id: String, mid: String, preview: String, at: Long, sender: String?, unreadInc: Int, mentionInc: Int): Int

    @Query("UPDATE conversations SET unreadCount = unreadCount + :unreadInc, mentionCount = mentionCount + :mentionInc WHERE id = :id")
    suspend fun bumpUnread(id: String, unreadInc: Int, mentionInc: Int)

    @Query("SELECT COALESCE(SUM(unreadCount), 0) FROM conversations WHERE muted = 0 AND removed = 0 AND archivedAt IS NULL AND (request IS NULL OR request != 'incoming')")
    fun observeTotalUnread(): Flow<Int>
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE conversationId = :cid AND threadRootId IS NULL ORDER BY sortTs DESC LIMIT :limit")
    fun observeLatest(cid: String, limit: Int): Flow<List<MessageEntity>>

    /** Scoped to the root's conversation: a reply claiming a root in another conversation never shows in it. */
    @Query("SELECT * FROM messages WHERE conversationId = :cid AND threadRootId = :root ORDER BY sortTs ASC")
    fun observeThread(cid: String, root: String): Flow<List<MessageEntity>>

    @Query("SELECT threadRootId AS root, COUNT(*) AS n, MAX(sortTs) AS lastTs FROM messages WHERE conversationId = :cid AND threadRootId IS NOT NULL AND deleted = 0 GROUP BY threadRootId")
    fun observeThreadCounts(cid: String): Flow<List<ThreadCount>>

    /** Batch B5: the conversation's threads (roots this phone has, with their reply counts), latest reply first. */
    @Query(
        """SELECT root.*, t.n AS replyCount, t.lastTs AS lastReplyTs FROM messages root
           JOIN (SELECT threadRootId AS r, COUNT(*) AS n, MAX(sortTs) AS lastTs FROM messages
                 WHERE conversationId = :cid AND threadRootId IS NOT NULL AND deleted = 0 GROUP BY threadRootId) t ON t.r = root.id
           WHERE root.conversationId = :cid ORDER BY t.lastTs DESC LIMIT :limit""",
    )
    fun observeThreadRoots(cid: String, limit: Int): Flow<List<ThreadRoot>>

    @Query("SELECT * FROM messages WHERE conversationId = :cid AND pinned = 1 AND deleted = 0 ORDER BY sortTs DESC")
    fun observePinned(cid: String): Flow<List<MessageEntity>>

    /**
     * Replies by others since [since] in threads you're part of (you started the thread or replied in it), newest first:
     * the Activity tab's thread replies. Uses the threadRootId and senderUserId indexes.
     */
    @Query(
        """SELECT r.* FROM messages r WHERE r.threadRootId IS NOT NULL AND r.deleted = 0 AND r.senderUserId != :me AND r.sortTs > :since
           AND (EXISTS (SELECT 1 FROM messages root WHERE root.id = r.threadRootId AND root.senderUserId = :me)
                OR EXISTS (SELECT 1 FROM messages mine WHERE mine.threadRootId = r.threadRootId AND mine.senderUserId = :me)
                OR r.threadRootId IN (:followed))
           ORDER BY r.sortTs DESC LIMIT :limit""",
    )
    fun observeThreadReplies(me: String, since: Long, limit: Int, followed: List<String>): Flow<List<MessageEntity>>

    /** Messages with files in a conversation, newest first: the channel details' Files section (this phone's history). */
    @Query("SELECT * FROM messages WHERE conversationId = :cid AND deleted = 0 AND attachmentsJson != '[]' ORDER BY sortTs DESC LIMIT :limit")
    fun observeWithFiles(cid: String, limit: Int): Flow<List<MessageEntity>>

    /** Batch B14: messages whose text may hold a link (the details screen's Links tab checks each with LinkRules). */
    @Query("SELECT * FROM messages WHERE conversationId = :cid AND deleted = 0 AND (text LIKE '%://%' OR text LIKE '%www.%') ORDER BY sortTs DESC LIMIT :limit")
    fun observeWithLinks(cid: String, limit: Int): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun get(id: String): MessageEntity?

    /** Your latest sent messages across conversations (Home › Drafts & sent). */
    @Query("SELECT * FROM messages WHERE outgoing = 1 AND deleted = 0 AND kind = 'text' AND threadRootId IS NULL ORDER BY sortTs DESC LIMIT :limit")
    fun observeRecentSent(limit: Int): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE id = :id")
    fun observe(id: String): Flow<MessageEntity?>

    @Query("SELECT COUNT(*) FROM messages WHERE conversationId = :cid AND threadRootId IS NULL")
    suspend fun count(cid: String): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(m: MessageEntity): Long

    @Upsert
    suspend fun upsert(m: MessageEntity)

    /** Backups: every stored message, oldest first, a page at a time. */
    @Query("SELECT * FROM messages ORDER BY sortTs, id LIMIT :limit OFFSET :offset")
    suspend fun page(limit: Int, offset: Int): List<MessageEntity>

    @Query("SELECT COUNT(*) FROM messages")
    suspend fun count(): Int

    /** Removes a message only from this phone (an unsent upload the person cancelled). */
    @Query("DELETE FROM messages WHERE id = :id")
    suspend fun deleteLocal(id: String)

    /** Batch B6: the messages of a declined message request. */
    @Query("DELETE FROM messages WHERE conversationId = :cid")
    suspend fun deleteConversationLocal(cid: String)

    @Query("UPDATE messages SET status = :status, serverTs = COALESCE(:serverTs, serverTs), errorText = :error WHERE id = :id")
    suspend fun setStatus(id: String, status: String, serverTs: Long?, error: String?)

    /** Never downgrade: only SENDING/SENT may advance to a later state through this call. */
    @Query("UPDATE messages SET status = 'SENT', serverTs = :serverTs, sortTs = :serverTs, errorText = NULL WHERE id = :id AND status IN ('SENDING','FAILED','HELD')")
    suspend fun markSent(id: String, serverTs: Long)

    /** Outgoing files still "sending" when the app starts were cut off: let the user retry them (T2.6). */
    @Query("UPDATE messages SET status = 'FAILED', errorText = :reason WHERE status = 'SENDING' AND outgoing = 1 AND attachmentsJson LIKE '%\"id\":\"pending\"%'")
    suspend fun failInterruptedUploads(reason: String)

    /** Messages paused by an identity change go back to "sending" once the user accepts the key (T1.2). */
    @Query("UPDATE messages SET status = 'SENDING', errorText = NULL WHERE status = 'HELD'")
    suspend fun resumeHeld()

    @Query("UPDATE messages SET status = 'DELIVERED' WHERE id = :id AND status IN ('SENDING','SENT')")
    suspend fun markDelivered(id: String)

    @Query("SELECT * FROM messages WHERE kind = 'text' AND deleted = 0 AND text LIKE '%' || :q || '%' ESCAPE '\\' ORDER BY sortTs DESC LIMIT 100")
    suspend fun search(q: String): List<MessageEntity>

    /** Search with operators (2026-10-23): words and a time window here; sender and has: are checked by the caller. */
    @Query("SELECT * FROM messages WHERE kind = 'text' AND deleted = 0 AND text LIKE '%' || :q || '%' ESCAPE '\\' AND sortTs >= :after AND sortTs < :before ORDER BY sortTs DESC LIMIT 1000")
    suspend fun searchBetween(q: String, after: Long, before: Long): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE conversationId = :cid AND kind = 'text' AND deleted = 0 AND text LIKE '%' || :q || '%' ESCAPE '\\' ORDER BY sortTs DESC LIMIT 100")
    suspend fun searchIn(cid: String, q: String): List<MessageEntity>

    /** Messages whose files may be named [q] (round 7 search): the caller checks the names in the decoded list. */
    @Query("SELECT * FROM messages WHERE deleted = 0 AND attachmentsJson != '[]' AND attachmentsJson LIKE '%' || :q || '%' ESCAPE '\\' ORDER BY sortTs DESC LIMIT 200")
    suspend fun searchFiles(q: String): List<MessageEntity>

    /** Pinned messages whose text matches [q] (round 7 search). */
    @Query("SELECT * FROM messages WHERE pinned = 1 AND deleted = 0 AND text LIKE '%' || :q || '%' ESCAPE '\\' ORDER BY sortTs DESC LIMIT 100")
    suspend fun searchPinned(q: String): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE conversationId = :cid AND outgoing = 1 AND status IN ('SENT','DELIVERED') AND sortTs <= :upTo")
    suspend fun outgoingUpTo(cid: String, upTo: Long): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE conversationId = :cid AND outgoing = 0 ORDER BY sortTs DESC LIMIT 1")
    suspend fun latestIncoming(cid: String): MessageEntity?

    @Query("SELECT * FROM messages WHERE conversationId = :cid AND threadRootId IS NULL AND deleted = 0 ORDER BY sortTs DESC LIMIT 1")
    suspend fun latestVisible(cid: String): MessageEntity?
}

/** A thread's replies on this phone: how many, and when the newest was sent (forum posts sort by it). */
data class ThreadCount(val root: String, val n: Int, val lastTs: Long = 0)
/** Batch B5: a thread's first message with how many replies it has and when the latest came. */
data class ThreadRoot(@androidx.room.Embedded val root: MessageEntity, val replyCount: Int, val lastReplyTs: Long)

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox WHERE nextAttemptAt <= :now ORDER BY createdAt LIMIT 20")
    suspend fun due(now: Long): List<OutboxEntity>

    @Query("SELECT MIN(nextAttemptAt) FROM outbox")
    suspend fun nextDue(): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(e: OutboxEntity)

    @Query("DELETE FROM outbox WHERE messageId = :id")
    suspend fun remove(id: String)

    @Query("SELECT * FROM outbox WHERE messageId = :id")
    suspend fun get(id: String): OutboxEntity?

    /** Sends paused by an identity change (T1.2) become due again. */
    @Query("UPDATE outbox SET nextAttemptAt = :now, lastError = NULL WHERE lastError = :reason")
    suspend fun resume(reason: String, now: Long)
}

@Dao
interface UserDao {
    @Query("SELECT * FROM users WHERE id = :id")
    suspend fun get(id: String): UserEntity?

    @Query("SELECT * FROM users WHERE id = :id")
    fun observe(id: String): Flow<UserEntity?>

    @Query("SELECT * FROM users")
    fun observeAll(): Flow<List<UserEntity>>

    @Query("SELECT * FROM users WHERE username = :username LIMIT 1")
    suspend fun byUsername(username: String): UserEntity?

    @Upsert
    suspend fun upsert(u: UserEntity)

    /** [presence]: "idle" or "dnd" while they appear so; null otherwise (older servers never send one). */
    @Query("UPDATE users SET online = :online, lastSeenAt = COALESCE(:lastSeen, lastSeenAt), presence = :presence WHERE id = :id")
    suspend fun setPresence(id: String, online: Boolean, lastSeen: Long?, presence: String? = null)

    @Query("SELECT * FROM users")
    suspend fun all(): List<UserEntity>

    /** Restoring a backup: adds people this phone doesn't know; never replaces a stored identity pin. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(u: UserEntity): Long
}

@Dao
interface CallDao {
    @Query("SELECT * FROM call_log ORDER BY startedAt DESC LIMIT 50")
    fun observeLog(): Flow<List<CallLogEntity>>

    @Upsert
    suspend fun upsertLog(e: CallLogEntity)

    @Query("SELECT * FROM call_log WHERE callId = :id")
    suspend fun getLog(id: String): CallLogEntity?

    @Upsert
    suspend fun putKey(k: CallKeyEntity)

    /** First key for a call wins: a later call_invite can't swap the media key mid-call. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun putKeyIfAbsent(k: CallKeyEntity): Long

    @Query("SELECT * FROM call_keys WHERE callId = :id")
    suspend fun key(id: String): CallKeyEntity?

    @Query("DELETE FROM call_keys WHERE callId = :id OR receivedAt < :olderThan")
    suspend fun dropKey(id: String, olderThan: Long)
}

@Dao
interface QuarantineDao {
    @Upsert
    suspend fun put(e: QuarantineEntity)

    @Query("SELECT * FROM quarantine WHERE senderUserId = :userId AND reason IS NULL ORDER BY queueId")
    suspend fun heldForIdentity(userId: String): List<QuarantineEntity>

    @Query("SELECT * FROM quarantine WHERE reason IS NOT NULL ORDER BY queueId")
    suspend fun setAside(): List<QuarantineEntity>

    @Query("DELETE FROM quarantine WHERE queueId = :queueId")
    suspend fun remove(queueId: Long)

    @Query("SELECT COUNT(*) FROM quarantine WHERE conversationId = :conversationId AND reason IS NULL")
    fun observeCount(conversationId: String): Flow<Int>
}

@Dao
interface PendingControlDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(e: PendingControlEntity): Long

    @Query("SELECT * FROM pending_controls WHERE conversationId = :conversationId AND targetId = :targetId")
    suspend fun forTarget(conversationId: String, targetId: String): List<PendingControlEntity>

    @Query("DELETE FROM pending_controls WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("SELECT COUNT(*) FROM pending_controls WHERE conversationId = :conversationId")
    suspend fun countIn(conversationId: String): Int

    @Query(
        "DELETE FROM pending_controls WHERE conversationId = :conversationId AND id NOT IN " +
            "(SELECT id FROM pending_controls WHERE conversationId = :conversationId ORDER BY serverTs DESC, id DESC LIMIT :keep)",
    )
    suspend fun deleteOldestIn(conversationId: String, keep: Int)

    @Query("DELETE FROM pending_controls WHERE expiresAt <= :now")
    suspend fun deleteExpired(now: Long)
}

@Dao
interface HistoryDao {
    @Query("SELECT * FROM history_outbox ORDER BY queuedAt LIMIT :limit")
    suspend fun next(limit: Int): List<HistoryOutboxEntity>

    /** Clears an entry only if nothing changed it since it was read (a newer change keeps it queued). */
    @Query("DELETE FROM history_outbox WHERE `key` = :key AND queuedAt = :queuedAt")
    suspend fun done(key: String, queuedAt: Long)

    @Query("DELETE FROM history_outbox WHERE `key` IN (:keys)")
    suspend fun drop(keys: List<String>)

    @Query("SELECT `key` FROM history_outbox WHERE `key` IN (:keys)")
    suspend fun queued(keys: List<String>): List<String>

    @Query("SELECT COUNT(*) FROM history_outbox")
    fun observeCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM history_outbox")
    suspend fun count(): Int

    /** Queues everything already on the phone (history turned on, or first run after updating). */
    @Query("INSERT OR IGNORE INTO history_outbox (`key`, queuedAt) SELECT 'm:' || id, 0 FROM messages")
    suspend fun queueAllMessages()

    @Query("INSERT OR IGNORE INTO history_outbox (`key`, queuedAt) SELECT 'c:' || id, 0 FROM conversations")
    suspend fun queueAllConversations()

    @Query("DELETE FROM history_outbox")
    suspend fun clear()
}

@Dao
interface KvDao {
    @Query("SELECT v FROM kv WHERE k = :k")
    suspend fun get(k: String): String?

    @Upsert
    suspend fun put(e: KvEntity)

    @Query("DELETE FROM kv WHERE k = :k")
    suspend fun delete(k: String)
}

@Database(
    entities = [ConversationEntity::class, MessageEntity::class, OutboxEntity::class, UserEntity::class, CallLogEntity::class, CallKeyEntity::class, KvEntity::class, QuarantineEntity::class, PendingControlEntity::class, HistoryOutboxEntity::class],
    version = GriipDatabase.VERSION,
    exportSchema = true,
)
abstract class GriipDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun messages(): MessageDao
    abstract fun outbox(): OutboxDao
    abstract fun users(): UserDao
    abstract fun calls(): CallDao
    abstract fun kv(): KvDao
    abstract fun quarantine(): QuarantineDao
    abstract fun pendingControls(): PendingControlDao
    abstract fun history(): HistoryDao

    companion object {
        /**
         * Schema version. Raising it needs a matching step in [Migrations] and the exported schema
         * committed under `app/schemas` (docs/DECISIONS.md D-13); `MigrationsTest` enforces both.
         */
        const val VERSION = 14

        /**
         * The database file is encrypted with SQLCipher (AES-256) using a random passphrase that is
         * itself sealed by an Android Keystore key (docs/SECURITY.md §6).
         */
        fun open(context: Context, passphrase: ByteArray, name: String): GriipDatabase {
            System.loadLibrary("sqlcipher")
            return Room.databaseBuilder(context, GriipDatabase::class.java, name)
                .openHelperFactory(SupportOpenHelperFactory(passphrase))
                .addMigrations(*Migrations.all())
                // Upgrades never fall back to wiping: local history is the only copy. A missing migration
                // fails loudly (and MigrationsTest fails first). Only a downgrade may recreate the file.
                .fallbackToDestructiveMigrationOnDowngrade(true)
                // The history triggers aren't part of Room's schema: (re)created on every open, so fresh installs
                // and migrated databases both have them.
                .addCallback(object : RoomDatabase.Callback() {
                    override fun onOpen(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                        HistoryTriggers.sql.forEach(db::execSQL)
                    }
                })
                .build()
        }
    }
}
