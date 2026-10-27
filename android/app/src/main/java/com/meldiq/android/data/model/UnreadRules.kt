package com.meldiq.android.data.model

/**
 * The one rule for unread markers on channel rows, DM rows and community icons, as Meldiq Web's `ui/unread.ts`
 * (community-first brief §C):
 *
 * - nothing new, or muted with no mention of you: no marker;
 * - exactly one unread message in a channel: the row is highlighted, with no number;
 * - two or more: highlighted, with a light count (99+ past 99; the real count stays in the spoken label);
 * - a DM or group: every message is addressed to you, so even one shows its number, in the accent colour;
 * - a mention of you: the pink `@` badge, which reads apart from plain unread by colour and its "@".
 */
sealed interface UnreadMarker {
    data object None : UnreadMarker
    data object Dot : UnreadMarker
    data class Count(val text: String, val direct: Boolean) : UnreadMarker
    data class Mention(val text: String) : UnreadMarker

    val highlighted: Boolean get() = this != None
}

object UnreadRules {
    /** Counts above this show as "99+". */
    const val COUNT_CAP = 99

    fun cap(n: Int): String = if (n > COUNT_CAP) "$COUNT_CAP+" else "$n"

    fun marker(unread: Int, mentions: Int, muted: Boolean, direct: Boolean = false): UnreadMarker = when {
        mentions > 0 -> UnreadMarker.Mention("@${cap(mentions)}")
        unread <= 0 || muted -> UnreadMarker.None
        unread == 1 && !direct -> UnreadMarker.Dot
        else -> UnreadMarker.Count(cap(unread), direct)
    }
}
