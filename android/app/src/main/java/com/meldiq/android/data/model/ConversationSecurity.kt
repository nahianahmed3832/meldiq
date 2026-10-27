package com.meldiq.android.data.model

/**
 * What the conversation's security panel says (round 6, docs/SECURITY_AND_PRIVACY.md): the header shows only a small
 * padlock, and the panel lists the facts that actually apply to this conversation. Every statement maps to how the
 * app works today; nothing here claims more than that (calls, for example, are end-to-end encrypted only with
 * Settings › Calls › End-to-end encrypt call media on).
 */
object ConversationSecurity {
    enum class Point {
        /** Messages, reactions, polls and edits: encrypted on the phone for each member's devices. */
        MESSAGES,
        /** Files and photos: encrypted on the phone before upload. */
        FILES,
        CALLS_E2EE,
        /** Call media only encrypted in transit to the media server (the call setting is off on this phone). */
        CALLS_TRANSPORT,
        /** Someone's security key changed; messages with them are paused until it's checked. */
        KEYS_CHANGED,
        /** Members on another server: both servers relay encrypted copies only. */
        OTHER_SERVERS,
        /** Channels: what connected apps post goes through the server and isn't end-to-end encrypted. */
        APP_UPDATES,
        /** What the server still sees: who talks with whom, when, and sizes. */
        METADATA,
    }

    data class Facts(
        /** "DM", "GROUP" or "CHANNEL". */
        val type: String,
        /** For a DM: whether the other person is verified; null for groups and channels. */
        val peerVerified: Boolean?,
        val changedMembers: Int,
        val otherServers: Int,
        val callMediaE2ee: Boolean,
    )

    fun points(f: Facts): List<Point> = buildList {
        if (f.changedMembers > 0) add(Point.KEYS_CHANGED)
        add(Point.MESSAGES)
        add(Point.FILES)
        add(if (f.callMediaE2ee) Point.CALLS_E2EE else Point.CALLS_TRANSPORT)
        // Safety numbers were retired (2026-10-28, as Meldiq Web v4): no "verified" points; a changed key still pauses.
        if (f.otherServers > 0) add(Point.OTHER_SERVERS)
        if (f.type == "CHANNEL") add(Point.APP_UPDATES)
        add(Point.METADATA)
    }

    /** The padlock is drawn in the warning colour when something needs the person's attention. */
    fun needsAttention(f: Facts): Boolean = f.changedMembers > 0
}
