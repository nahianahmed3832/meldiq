package com.meldiq.android.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import com.meldiq.android.MainActivity
import com.meldiq.android.R
import com.meldiq.android.data.repo.Notice

object Channels {
    /**
     * Channel ids. Android fixes a channel's sound and vibration when it's created, so each sound setting has its own
     * channel (2026-10-17, docs/NOTIFICATIONS.md): changing Meldiq's sound or vibration setting creates the matching
     * channel and removes the old one, carrying over whether the person had turned it off or down in Android's settings.
     */
    @Volatile var MESSAGES = "messages"
        private set
    @Volatile var MENTIONS = "mentions"
        private set
    @Volatile var INCOMING_CALL = "incoming_call_v2"
        private set
    const val ONGOING_CALL = "ongoing_call"
    const val CONNECTION = "connection"
    /** Reminders the server fired (round 6, docs/REMINDERS.md). */
    const val REMINDERS = "reminders"

    /** Channels these replace (the original ids, and other sound variants). */
    private val LEGACY = mapOf("msg" to listOf("messages"), "mention" to listOf("mentions"), "call" to listOf("incoming_call", "incoming_call_v2"))

    /**
     * The channel ids for these sound settings (pure; unit-tested in `ChannelIdsTest`). Channels with a sound carry the
     * sound's version ([SOUNDS]): Android keeps a channel's sound for good, so new sounds need new channels (the old
     * ones are removed, keeping whether the person turned them off or down).
     */
    object Ids {
        /** 2026-10-28: the owner's ringtone and bell notification sound (res/raw, docs/NOTIFICATIONS.md). */
        private const val SOUNDS = "_t2"
        private fun sounds(on: Boolean) = if (on) SOUNDS else ""
        fun messages(sound: Boolean, vibrate: Boolean) = "meldiq_msg_s${if (sound) 1 else 0}v${if (vibrate) 1 else 0}${sounds(sound)}"
        fun mentions(sound: Boolean, vibrate: Boolean) = "meldiq_mention_s${if (sound) 1 else 0}v${if (vibrate) 1 else 0}${sounds(sound)}"
        fun calls(ring: Boolean, vibrate: Boolean) = "meldiq_call_r${if (ring) 1 else 0}v${if (vibrate) 1 else 0}${sounds(ring)}"
        fun category(id: String): String? = when {
            id.startsWith("meldiq_msg_") -> "msg"
            id.startsWith("meldiq_mention_") -> "mention"
            id.startsWith("meldiq_call_") -> "call"
            else -> LEGACY.entries.firstOrNull { id in it.value }?.key
        }
    }

    /** The system's settings for one of this app's channels (where a person can switch it off). */
    fun settingsIntent(context: Context, channelId: String): android.content.Intent =
        android.content.Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
            .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, channelId)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)

    fun create(context: Context) {
        val p = context.getSharedPreferences("griip_settings", Context.MODE_PRIVATE)
        apply(context, p.getBoolean("messageSound", true), p.getBoolean("callRingtone", true), p.getBoolean("vibrate", true))
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(ONGOING_CALL, "Ongoing call", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CONNECTION, "Background connection", NotificationManager.IMPORTANCE_MIN).apply { description = "Shown while Meldiq stays connected for background delivery" })
        nm.createNotificationChannel(NotificationChannel(REMINDERS, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply { description = "Reminders you set, and reminders for saved messages" })
    }

    /** After Settings › Notifications & Sounds changed. */
    fun applySoundSettings(context: Context, s: com.meldiq.android.data.repo.Settings) = apply(context, s.messageSound, s.callRingtone, s.vibrate)

    private fun sound(context: Context, raw: Int) = android.net.Uri.parse("android.resource://${context.packageName}/$raw")

    private fun apply(context: Context, messageSound: Boolean, ring: Boolean, vibrate: Boolean) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val notif = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        val ringAttrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        fun ensure(category: String, id: String, name: String, desc: String, build: NotificationChannel.() -> Unit) {
            val existing = nm.notificationChannels.filter { Ids.category(it.id) == category }
            if (existing.none { it.id == id }) {
                // Carry over a channel the person blocked or turned down in Android's settings.
                val keep = existing.minOfOrNull { it.importance }?.coerceAtMost(NotificationManager.IMPORTANCE_HIGH) ?: NotificationManager.IMPORTANCE_HIGH
                nm.createNotificationChannel(NotificationChannel(id, name, keep).apply { description = desc; build() })
            }
            existing.filter { it.id != id }.forEach { runCatching { nm.deleteNotificationChannel(it.id) } }
        }
        val msgId = Ids.messages(messageSound, vibrate)
        ensure("msg", msgId, "Messages", "New messages in your conversations") {
            setSound(if (messageSound) sound(context, R.raw.meldiq_message) else null, notif)
            enableVibration(vibrate)
        }
        val mentionId = Ids.mentions(messageSound, vibrate)
        ensure("mention", mentionId, "Mentions", "When someone @mentions you") {
            setSound(if (messageSound) sound(context, R.raw.meldiq_message) else null, notif)
            enableVibration(vibrate)
        }
        val callId = Ids.calls(ring, vibrate)
        ensure("call", callId, "Incoming calls", "Meldiq's ringtone for calls to you") {
            setSound(if (ring) sound(context, R.raw.meldiq_ringtone) else null, ringAttrs)
            enableVibration(vibrate)
            if (vibrate) vibrationPattern = longArrayOf(0, 600, 400, 600, 400, 600)
        }
        MESSAGES = msgId
        MENTIONS = mentionId
        INCOMING_CALL = callId
    }
}

/** Posts message notifications. Content shown is decrypted on-device; nothing is fetched from a push service. */
class MessageNotifier(private val context: Context) {
    private val history = NotificationHistory()

    companion object {
        const val PREFS = "griip_settings"
        /** Round 3: messages make no notification until this time (ms); calls still ring. */
        const val PAUSED_UNTIL = "notificationsPausedUntil"

        fun paused(pausedUntil: Long, now: Long): Boolean = pausedUntil > now
    }

    fun show(n: Notice) {
        // Settings › Notifications & Sounds (docs/NOTIFICATIONS.md): group chats can be silenced (mentions still come
        // through), and message text can be hidden from notifications altogether.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Paused from the profile sheet (round 3): the message still arrives and counts as unread, silently.
        if (paused(prefs.getLong(PAUSED_UNTIL, 0L), System.currentTimeMillis())) return
        if (n.isGroup && !n.mention && !prefs.getBoolean("groupNotifications", true)) return
        if (!prefs.getBoolean("notificationPreviews", true)) {
            showPrivate(n)
            return
        }
        val open = PendingIntent.getActivity(
            context, n.conversationId.hashCode(),
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_CONVERSATION, n.conversationId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val me = Person.Builder().setName("You").build()
        val style = NotificationCompat.MessagingStyle(me)
            .setConversationTitle(if (n.isGroup) n.title else null)
            .setGroupConversation(n.isGroup)
        for (l in history.add(n.conversationId, NotificationHistory.Line(n.sender, n.text.take(400), System.currentTimeMillis()))) {
            style.addMessage(l.text, l.at, Person.Builder().setName(l.sender).build())
        }
        val builder = NotificationCompat.Builder(context, if (n.mention) Channels.MENTIONS else Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_meldiq)
            .setStyle(style)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setColor(0xFF4441D0.toInt())
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, Channels.MESSAGES).setSmallIcon(R.drawable.ic_stat_meldiq).setContentTitle("Meldiq").setContentText("New message").build(),
            )
        // Reply only where the user may post; both actions need the phone unlocked (T4.4).
        if (n.canReply) {
            val input = RemoteInput.Builder(MessageActionReceiver.KEY_REPLY).setLabel("Reply").build()
            builder.addAction(
                NotificationCompat.Action.Builder(0, "Reply", action(n.conversationId, MessageActionReceiver.ACTION_REPLY, mutable = true))
                    .addRemoteInput(input).setAllowGeneratedReplies(false).setAuthenticationRequired(true)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build(),
            )
        }
        builder.addAction(
            NotificationCompat.Action.Builder(0, "Mark as read", action(n.conversationId, MessageActionReceiver.ACTION_MARK_READ, mutable = false))
                .setAuthenticationRequired(true).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build(),
        )
        runCatching { context.getSystemService(NotificationManager::class.java).notify(n.conversationId.hashCode(), builder.build()) }
    }

    /** Message previews off: "New message", without the sender or the text. */
    private fun showPrivate(n: Notice) {
        val open = PendingIntent.getActivity(
            context, n.conversationId.hashCode(),
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_CONVERSATION, n.conversationId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notif = NotificationCompat.Builder(context, if (n.mention) Channels.MENTIONS else Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_meldiq)
            .setContentTitle("Meldiq")
            .setContentText(if (n.mention) "You were mentioned" else "New message")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setColor(0xFF4441D0.toInt())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(n.conversationId.hashCode(), notif) }
    }

    /** An explicit intent to this app's own receiver; only the reply needs to be mutable (RemoteInput fills it). */
    private fun action(conversationId: String, action: String, mutable: Boolean): PendingIntent = PendingIntent.getBroadcast(
        context, 31 * conversationId.hashCode() + action.hashCode(),
        Intent(context, MessageActionReceiver::class.java).setAction(action).putExtra(MessageActionReceiver.EXTRA_CONVERSATION, conversationId),
        (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** Replaces the conversation's notification when a reply from it couldn't be queued. */
    fun showReplyFailed(conversationId: String) {
        history.clear(conversationId)
        val open = PendingIntent.getActivity(
            context, conversationId.hashCode(),
            Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_CONVERSATION, conversationId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notif = NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_meldiq)
            .setContentTitle("Reply not sent")
            .setContentText("Open the conversation to send it again.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(conversationId.hashCode(), notif) }
    }

    fun clear(conversationId: String) {
        history.clear(conversationId)
        context.getSystemService(NotificationManager::class.java).cancel(conversationId.hashCode())
    }

    /** Removes every message notification and its history, for sign-out and erase. Call notifications are left to the call code. */
    fun clearAll() {
        history.clearAll()
        val nm = context.getSystemService(NotificationManager::class.java)
        runCatching { nm.activeNotifications.filter { Channels.Ids.category(it.notification.channelId) in setOf("msg", "mention") }.forEach { nm.cancel(it.tag, it.id) } }
    }
}
