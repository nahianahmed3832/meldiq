package com.meldiq.android.ui.screens.community

import androidx.compose.runtime.Immutable
import com.meldiq.android.data.api.CategoryDto
import com.meldiq.android.data.api.ConversationDto
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.model.ChannelRef
import com.meldiq.android.data.model.ChannelTree
import com.meldiq.android.ui.screens.chats.ChatListRules

/**
 * One channel in Home's channel panel: one you're in (from this phone's database, with unread counts) or one you may
 * see but haven't joined (from the community's channel list on the server), drawn dimmed until you open it.
 */
@Immutable
data class PanelChannel(
    val id: String,
    val name: String,
    val kind: String?,
    val voice: Boolean,
    val format: String,
    val categoryId: String?,
    val categoryName: String?,
    val position: Int,
    val topic: String?,
    val joined: Boolean,
    val unread: Int = 0,
    val mentions: Int = 0,
    val muted: Boolean = false,
    val liveCall: Boolean = false,
    val canManage: Boolean = false,
    val archived: Boolean = false,
    /** The stored conversation, for channels you're in (null for one you haven't joined). */
    val conv: ConversationEntity? = null,
    /** API 0.48.0: its category's place, for the order before the category list loads. */
    val categoryPosition: Int? = null,
) {
    val hasNews: Boolean get() = unread > 0 || mentions > 0
}

/** One section of the panel: a category (or the channels without one) with what to draw while open or collapsed. */
@Immutable
data class PanelSection(
    val key: String,
    val title: String?,
    val categoryId: String?,
    val all: List<PanelChannel>,
    val shown: List<PanelChannel>,
    val collapsed: Boolean,
) {
    val unreadChannels: Int get() = all.count { it.unread > 0 && !it.muted }
}

/** A community's signals on the rail. */
@Immutable
data class RailBadge(val unread: Boolean, val mentions: Int)

/**
 * Home's community rail and channel panel (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §2). Pure and unit-tested
 * (`CommunityPanelRulesTest`).
 */
object CommunityPanelRules {
    /**
     * The selected community's channels: those you're in (not left, not archived on this phone) and, from the
     * server's list, the ones you may see but haven't joined (not archived). A channel known both ways is the joined one.
     */
    fun channels(convs: List<ConversationEntity>, server: List<ConversationDto>, orgId: String?): List<PanelChannel> {
        if (orgId == null) return emptyList()
        val joined = convs.filter { it.type == "CHANNEL" && it.orgId == orgId && it.joined && !it.removed && !ChatListRules.isArchived(it) }
            .map { c ->
                PanelChannel(
                    c.id, c.name.orEmpty(), c.kind, c.voice, c.format, c.categoryId, c.categoryName, c.position, c.topic, joined = true,
                    unread = c.unreadCount, mentions = c.mentionCount, muted = c.muted, liveCall = c.activeCallId != null,
                    canManage = c.canManage, archived = c.archived, conv = c, categoryPosition = c.categoryPosition,
                )
            }
        val known = joined.map { it.id }.toSet()
        val others = server.filter { it.orgId == orgId && !it.joined && !it.archived && it.id !in known }
            .map { d ->
                PanelChannel(
                    d.id, d.name.orEmpty(), d.kind, d.voice, d.format, d.categoryId, d.categoryName, d.position, d.topic, joined = false,
                    liveCall = d.activeCall != null, canManage = d.canManage, categoryPosition = d.categoryPosition,
                )
            }
        return joined + others
    }

    /**
     * The panel's sections in the community's order. A collapsed category ([collapsed] holds its key) keeps showing
     * channels with something new and the one you have open ([selectedId]), as the reference does. [hideMuted] hides
     * muted channels unless they mention you; [unreadOnly] shows only channels with something new. [placed]: channels
     * shown in Favourites or your own sections instead. A section left with nothing to show stays while it's collapsed
     * (to open it again) and, for the people who may add channels ([keepEmpty]), while it has no channels at all;
     * otherwise it's left out.
     */
    fun sections(
        channels: List<PanelChannel>,
        categories: List<CategoryDto>,
        collapsed: Set<String>,
        selectedId: String? = null,
        hideMuted: Boolean = false,
        unreadOnly: Boolean = false,
        placed: Set<String> = emptySet(),
        keepEmpty: Boolean = false,
        /** Batch B3: channels hidden from the list; they still show while they mention you or are open. */
        hidden: Set<String> = emptySet(),
    ): List<PanelSection> {
        val listed = channels.filter { it.id !in placed }
        return ChannelTree.sections(listed, categories, keepEmpty = keepEmpty, ref = { ChannelRef(it.id, it.name, it.categoryId, it.position) }, categoryName = { it.categoryName }, categoryPosition = { it.categoryPosition })
            .mapNotNull { s ->
                val isCollapsed = s.key in collapsed
                val shown = s.channels.filter { ch ->
                    val muteOk = !hideMuted || !ch.muted || ch.mentions > 0
                    val unreadOk = !unreadOnly || ch.hasNews || ch.id == selectedId
                    val collapseOk = !isCollapsed || ch.hasNews || ch.id == selectedId
                    val hiddenOk = ch.id !in hidden || ch.mentions > 0 || ch.id == selectedId
                    muteOk && unreadOk && collapseOk && hiddenOk
                }
                // A collapsed header stays so it can be opened again; an empty category stays for the people who fill it.
                val keep = shown.isNotEmpty() || (isCollapsed && !unreadOnly) || (keepEmpty && !unreadOnly && s.channels.isEmpty())
                if (keep) PanelSection(s.key, s.title, s.categoryId, s.channels, shown, isCollapsed) else null
            }
    }

    /**
     * The rail's signals per community: something unread in a channel you haven't muted, and the number of unread
     * mentions (mentions count even in muted channels: they were meant for you).
     */
    fun rail(convs: List<ConversationEntity>): Map<String, RailBadge> =
        convs.asSequence()
            .filter { it.type == "CHANNEL" && it.orgId != null && it.joined && !it.removed && !ChatListRules.isArchived(it) }
            .groupBy { it.orgId!! }
            .mapValues { (_, list) -> RailBadge(list.any { it.unreadCount > 0 && !it.muted }, list.sumOf { it.mentionCount }) }
            .filterValues { it.unread || it.mentions > 0 }

    /** "Mark as read" for a community or one category: the joined channels with something unread. */
    fun markReadTargets(channels: List<PanelChannel>): List<ConversationEntity> = channels.filter { it.joined && it.hasNews }.mapNotNull { it.conv }

    /** Whether every joined channel in [channels] is muted (the community or category's Mute item then says Unmute). */
    fun allMuted(channels: List<PanelChannel>): Boolean = channels.filter { it.joined }.let { it.isNotEmpty() && it.all { ch -> ch.muted } }

    /** The joined channels a Mute or Unmute of the whole community or category changes. */
    fun muteTargets(channels: List<PanelChannel>, mute: Boolean): List<ConversationEntity> = channels.filter { it.joined && it.muted != mute }.mapNotNull { it.conv }

    /**
     * The channel to highlight: the one last opened in this community, while it's still listed; null otherwise (the
     * panel doesn't open anything by itself).
     */
    fun selected(lastOpened: String?, channels: List<PanelChannel>): String? = lastOpened?.takeIf { id -> channels.any { it.id == id } }

    /** The community the rail selects: the saved choice while you still belong to it, else the first one (null: none). */
    fun selectedCommunity(orgs: List<OrgDto>, saved: String?): String? = saved?.takeIf { s -> orgs.any { it.id == s } } ?: orgs.firstOrNull()?.id
}
