package com.meldiq.android.data.db

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Explicit, append-only schema migrations (docs/DECISIONS.md D-13). The local database holds the
 * only copy of a user's history, so every version bump ships a step here and never a destructive
 * fallback. Steps are plain SQL so `MigrationsTest` (JVM) runs exactly what the app runs against the
 * exported schemas in `app/schemas`, checking the resulting schema and that existing rows survive.
 */
object Migrations {
    /** fromVersion → statements that take the schema from `fromVersion` to `fromVersion + 1`. */
    val steps: Map<Int, List<String>> = mapOf(
        // v2 (T1.2): envelopes held because their sender's identity key changed.
        1 to listOf(
            "CREATE TABLE IF NOT EXISTS `quarantine` (`queueId` INTEGER NOT NULL, `conversationId` TEXT NOT NULL, `senderUserId` TEXT NOT NULL, " +
                "`itemJson` TEXT NOT NULL, `receivedAt` INTEGER NOT NULL, PRIMARY KEY(`queueId`))",
            "CREATE INDEX IF NOT EXISTS `index_quarantine_senderUserId` ON `quarantine` (`senderUserId`)",
            "CREATE INDEX IF NOT EXISTS `index_quarantine_conversationId` ON `quarantine` (`conversationId`)",
        ),
        // v3 (T1.4): items set aside after repeated processing failures share the table, with a reason.
        2 to listOf("ALTER TABLE `quarantine` ADD COLUMN `reason` TEXT"),
        // v4 (T2.1): edits, deletions, reactions and pins waiting for their target message.
        3 to listOf(
            "CREATE TABLE IF NOT EXISTS `pending_controls` (`id` TEXT NOT NULL, `conversationId` TEXT NOT NULL, `targetId` TEXT NOT NULL, " +
                "`senderUserId` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `serverTs` INTEGER NOT NULL, `receivedAt` INTEGER NOT NULL, " +
                "`expiresAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
            "CREATE INDEX IF NOT EXISTS `index_pending_controls_conversationId_targetId` ON `pending_controls` (`conversationId`, `targetId`)",
        ),
        // v5 (2026-10-17): chats archived on this phone (swipe actions). Nullable, so every existing chat stays unarchived.
        4 to listOf("ALTER TABLE `conversations` ADD COLUMN `archivedAt` INTEGER"),
        // v6 (2026-10-17): profile photos. Nullable, so every known person starts without one until the server says.
        5 to listOf(
            "ALTER TABLE `users` ADD COLUMN `photoRev` INTEGER",
            // Rich messages: contact cards, locations, animated emoji; and the forwarded mark.
            "ALTER TABLE `messages` ADD COLUMN `richJson` TEXT",
            "ALTER TABLE `messages` ADD COLUMN `forwarded` INTEGER NOT NULL DEFAULT 0",
        ),
        // v7 (2026-10-17): the queue for the encrypted history on the server (docs/MESSAGE_HISTORY.md), and its triggers.
        // Existing messages are queued by HistorySync when history is on, not here.
        // v8 (2026-10-19, round 6): voice rooms. Every existing conversation is an ordinary one, with nobody in a room.
        7 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `voice` INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE `conversations` ADD COLUMN `roomPeopleJson` TEXT",
        ),
        // v9 (2026-10-21, communities): a channel's category, its order and whether it's a forum. Every existing
        // conversation is uncategorised, first, and a text channel until the server says otherwise.
        8 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `categoryId` TEXT",
            "ALTER TABLE `conversations` ADD COLUMN `categoryName` TEXT",
            "ALTER TABLE `conversations` ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE `conversations` ADD COLUMN `format` TEXT NOT NULL DEFAULT 'text'",
        ),
        // v10 (2026-10-21, Discord reference round): a forum's tags (JSON, from the server), and whether you may join and
        // talk in a voice channel. Existing conversations have no tags and keep both until the server says otherwise.
        9 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `forumTagsJson` TEXT",
            "ALTER TABLE `conversations` ADD COLUMN `canConnect` INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE `conversations` ADD COLUMN `canSpeak` INTEGER NOT NULL DEFAULT 1",
        ),
        // v11 (2026-10-21, member timeouts): when your timeout in the channel's community ends; none until the server says.
        10 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `timedOutUntil` INTEGER",
        ),
        // v12 (batch B6): message requests.
        11 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `request` TEXT",
        ),
        // v13 (batch B6b): a group's photo, and idle / do not disturb.
        12 to listOf(
            "ALTER TABLE `conversations` ADD COLUMN `photoRev` INTEGER",
            "ALTER TABLE `users` ADD COLUMN `presence` TEXT",
        ),
        // v14 (2026-10-28, Meldiq Web parity): how people look (animated avatar, name style, worn tag).
        13 to listOf(
            "ALTER TABLE `users` ADD COLUMN `lookJson` TEXT",
        ),
        6 to listOf(
            "CREATE TABLE IF NOT EXISTS `history_outbox` (`key` TEXT NOT NULL, `queuedAt` INTEGER NOT NULL, PRIMARY KEY(`key`))",
            "CREATE INDEX IF NOT EXISTS `index_history_outbox_queuedAt` ON `history_outbox` (`queuedAt`)",
        ) + HistoryTriggers.sql,
    )

    init {
        check(steps.keys.max() + 1 == GriipDatabase.VERSION) { "a migration step is missing" }
    }

    fun all(): Array<Migration> = steps.map { (from, sql) ->
        object : Migration(from, from + 1) {
            override fun migrate(db: SupportSQLiteDatabase) = sql.forEach(db::execSQL)
        }
    }.toTypedArray()
}

/**
 * Queue every new message and chat, and every change that matters to history, for the encrypted history on the server.
 * Receipts (readBy/deliveredTo), presence in member lists, drafts and unread counts don't. The new entry's version is one more than the highest in
 * the queue, so a change made while an upload is running keeps its entry queued. Deletions of rows aren't queued: a
 * message deleted for everyone is an update (its `deleted` flag), and nothing here ever removes history from the server.
 */
object HistoryTriggers {
    private const val NEXT = "(SELECT COALESCE(MAX(queuedAt), 0) + 1 FROM history_outbox)"
    private val MESSAGE_FIELDS = listOf("text", "attachmentsJson", "deleted", "editedAt", "pinned", "reactionsJson", "richJson", "status", "callJson", "forwarded", "replyToId")
    // Not membersJson: it carries members' online flags, and the server provides current membership anyway.
    private val CONVERSATION_FIELDS = listOf("name", "topic", "muted", "archivedAt", "removed", "type", "kind", "scopeName")

    /** Room rewrites whole rows, so an update counts only when one of [fields] really changed. */
    private fun changed(fields: List<String>) = fields.joinToString(" OR ") { "OLD.`$it` IS NOT NEW.`$it`" }

    private fun queue(prefix: String) = "INSERT OR REPLACE INTO `history_outbox` (`key`, queuedAt) VALUES ('$prefix:' || NEW.id, $NEXT);"

    /** Dropped and recreated on every open, so a database always has the current definitions. */
    val sql: List<String> = listOf(
        "DROP TRIGGER IF EXISTS `history_message_added`",
        "DROP TRIGGER IF EXISTS `history_message_changed`",
        "DROP TRIGGER IF EXISTS `history_conversation_added`",
        "DROP TRIGGER IF EXISTS `history_conversation_changed`",
        "CREATE TRIGGER `history_message_added` AFTER INSERT ON `messages` BEGIN ${queue("m")} END",
        "CREATE TRIGGER `history_message_changed` AFTER UPDATE ON `messages` WHEN ${changed(MESSAGE_FIELDS)} BEGIN ${queue("m")} END",
        "CREATE TRIGGER `history_conversation_added` AFTER INSERT ON `conversations` BEGIN ${queue("c")} END",
        "CREATE TRIGGER `history_conversation_changed` AFTER UPDATE ON `conversations` WHEN ${changed(CONVERSATION_FIELDS)} BEGIN ${queue("c")} END",
    )
}
