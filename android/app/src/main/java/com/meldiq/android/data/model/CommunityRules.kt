package com.meldiq.android.data.model

import com.meldiq.android.data.api.CategoryDto
import com.meldiq.android.data.api.LayoutChannel
import com.meldiq.android.data.api.OverwriteDto

/**
 * Communities in the app (docs/COMMUNITY_REBUILD_2026-10-21.md): channel types, channels grouped into categories in
 * their order, permission overwrites and layout moves. Pure and unit-tested (`CommunityRulesTest`); the server decides
 * every permission again.
 */
enum class ChannelType { TEXT, ANNOUNCEMENT, FORUM, VOICE }

object ChannelTypes {
    fun of(kind: String?, voice: Boolean, format: String?): ChannelType = when {
        voice -> ChannelType.VOICE
        format == "forum" -> ChannelType.FORUM
        kind == "ANNOUNCEMENT" -> ChannelType.ANNOUNCEMENT
        else -> ChannelType.TEXT
    }

    /** What to send when creating a channel of [type]: (kind, voice, format). Private applies to text, forum and voice. */
    fun request(type: ChannelType, private: Boolean): Triple<String, Boolean, String> = when (type) {
        ChannelType.ANNOUNCEMENT -> Triple("ANNOUNCEMENT", false, "text")
        ChannelType.VOICE -> Triple(if (private) "PRIVATE" else "PUBLIC", true, "text")
        ChannelType.FORUM -> Triple(if (private) "PRIVATE" else "PUBLIC", false, "forum")
        ChannelType.TEXT -> Triple(if (private) "PRIVATE" else "PUBLIC", false, "text")
    }
}

/** A channel as the grouping needs it (built from Room rows or API rows). */
data class ChannelRef(val id: String, val name: String, val categoryId: String?, val position: Int)

/** One section of the channel list: a category (or the uncategorised channels, [categoryId] null) and its channels. */
data class ChannelSection<T>(val key: String, val categoryId: String?, val title: String?, val channels: List<T>)

object ChannelTree {
    /** Key of the section holding channels without a category (shown first, like Discord). */
    const val UNCATEGORISED = "category:none"

    fun key(categoryId: String?) = if (categoryId == null) UNCATEGORISED else "category:$categoryId"

    /**
     * [items] grouped by category: uncategorised channels first, then categories in [categories] order (a category the
     * list doesn't know yet goes by the channels' [categoryPosition] (API 0.48.0, as Meldiq Web v4), else last by its
     * name), channels by position then name. [keepEmpty]: also
     * list known categories without channels (for the people arranging them).
     */
    fun <T> sections(
        items: List<T>, categories: List<CategoryDto>, keepEmpty: Boolean = false, ref: (T) -> ChannelRef, categoryName: (T) -> String? = { null },
        categoryPosition: (T) -> Int? = { null },
    ): List<ChannelSection<T>> {
        val order = categories.sortedWith(compareBy({ it.position }, { it.name.lowercase() }, { it.id })).mapIndexed { i, c -> c.id to i }.toMap()
        val known = categories.associateBy { it.id }
        val byCategory = items.groupBy { ref(it).categoryId?.takeIf { id -> id.isNotEmpty() } }
        val sortChannels = { list: List<T> -> list.sortedWith(compareBy({ ref(it).position }, { ref(it).name.lowercase() }, { ref(it).id })) }
        val sections = mutableListOf<ChannelSection<T>>()
        byCategory[null]?.let { sections += ChannelSection(UNCATEGORISED, null, null, sortChannels(it)) }
        val ids = (byCategory.keys.filterNotNull() + if (keepEmpty) known.keys else emptySet()).toSet()
        // Known categories by the list's order; the others by the position their channels carry, after the known ones.
        val carried = { id: String -> byCategory[id]?.firstNotNullOfOrNull(categoryPosition) }
        ids.sortedWith(compareBy({ if (order[it] != null) 0 else 1 }, { order[it] ?: carried(it) ?: Int.MAX_VALUE }, { (known[it]?.name ?: byCategory[it]?.firstOrNull()?.let(categoryName) ?: "").lowercase() }, { it }))
            .forEach { id ->
                val list = byCategory[id].orEmpty()
                val title = known[id]?.name ?: list.firstOrNull()?.let(categoryName) ?: ""
                sections += ChannelSection(key(id), id, title, sortChannels(list))
            }
        return sections
    }
}

/** What an overwrite does with one capability. */
enum class OverwriteState { ALLOW, INHERIT, DENY }

object OverwriteRules {
    const val EVERYONE = "everyone"
    const val USER_PREFIX = "user:"

    fun state(o: OverwriteDto?, capability: String): OverwriteState = when {
        o == null -> OverwriteState.INHERIT
        capability in o.allow -> OverwriteState.ALLOW
        capability in o.deny -> OverwriteState.DENY
        else -> OverwriteState.INHERIT
    }

    /** [o]'s allow and deny after setting [capability] to [state] (nothing else changes). */
    fun with(o: OverwriteDto?, capability: String, state: OverwriteState): Pair<List<String>, List<String>> {
        val allow = o?.allow.orEmpty() - capability
        val deny = o?.deny.orEmpty() - capability
        return when (state) {
            OverwriteState.ALLOW -> (allow + capability) to deny
            OverwriteState.DENY -> allow to (deny + capability)
            OverwriteState.INHERIT -> allow to deny
        }
    }

    /** Overwrites in the order they apply: @everyone, roles, then members. */
    fun ordered(list: List<OverwriteDto>): List<OverwriteDto> =
        list.sortedWith(compareBy({ when (it.kind) { "everyone" -> 0; "role" -> 1; else -> 2 } }, { it.label.lowercase() }))

    /**
     * A channel with no rules of its own follows its category exactly (the reference's "synced"): Meldiq applies the
     * category's overwrites first and the channel's on top, so a channel without any is in sync by definition.
     */
    fun synced(channelOverwrites: List<OverwriteDto>): Boolean = channelOverwrites.all { it.allow.isEmpty() && it.deny.isEmpty() }

    /** The rules "Sync with category" removes: every subject with something set on the channel itself. */
    fun syncTargets(channelOverwrites: List<OverwriteDto>): List<String> = channelOverwrites.filter { it.allow.isNotEmpty() || it.deny.isNotEmpty() }.map { it.subject }

    /** True when the channel or category is hidden from people without a role (the lock on its name). */
    fun gated(list: List<OverwriteDto>): Boolean = list.any { it.subject == EVERYONE && VIEW in it.deny }

    /** Seeing the channel at all: the one capability the Basic view of permissions works with. */
    const val VIEW = "channels.view"

    /** Basic view: private means @everyone is denied [VIEW]. */
    fun isPrivate(list: List<OverwriteDto>): Boolean = gated(list)

    /** Basic view's "Who can access": the roles and members allowed [VIEW], roles first. */
    fun whoCanView(list: List<OverwriteDto>): List<OverwriteDto> = ordered(list.filter { it.subject != EVERYONE && VIEW in it.allow })

    /** @everyone's allow and deny for the Private switch; every other capability on it stays as it was. */
    fun privacy(everyone: OverwriteDto?, private: Boolean): Pair<List<String>, List<String>> =
        with(everyone, VIEW, if (private) OverwriteState.DENY else OverwriteState.INHERIT)

    /** A role's or member's allow and deny after giving ([can] true) or taking away access; only [VIEW] changes. */
    fun access(o: OverwriteDto?, can: Boolean): Pair<List<String>, List<String>> =
        with(o, VIEW, if (can) OverwriteState.ALLOW else OverwriteState.INHERIT)
}

object LayoutRules {
    /** [ids] with [id] moved one place up ([delta] -1) or down (+1); unchanged at either end. */
    fun move(ids: List<String>, id: String, delta: Int): List<String> {
        val i = ids.indexOf(id)
        val j = i + delta
        if (i < 0 || j !in ids.indices) return ids
        return ids.toMutableList().also { it.add(j, it.removeAt(i)) }
    }

    /** The layout entries for every channel in a category, in [orderedIds] order (positions 0, 1, 2…). */
    fun positions(categoryId: String?, orderedIds: List<String>): List<LayoutChannel> = orderedIds.mapIndexed { i, id -> LayoutChannel(id, categoryId, i) }

    /** Moving [channelId] into [toCategory]: it goes last there. */
    fun moveTo(channelId: String, toCategory: String?, targetIds: List<String>): List<LayoutChannel> =
        positions(toCategory, targetIds.filter { it != channelId } + channelId)
}
