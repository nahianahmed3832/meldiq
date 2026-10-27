package com.meldiq.android.data.model

import kotlinx.serialization.Serializable

/**
 * How a person chose to look (API 0.45.0–0.46.0, docs/PROFILE_MEDIA.md, as Meldiq Web): an animated avatar, an avatar
 * frame, a banner with its effect and colour, a name style (font, colour or gradient, glow or shimmer) and the community
 * tag they wear. Not end-to-end encrypted, like the photo: the server stores it and shows it to whoever may see it.
 */
@Serializable
data class MediaRef(val kind: String, val rev: Long)

@Serializable
data class ProfileStyleDto(
    val decoration: String? = null,
    val effect: String? = null,
    val accent: String? = null,
    val nameFont: String? = null,
    val nameColors: List<String>? = null,
    val nameEffect: String? = null,
    val tagOrgId: String? = null,
)

/** The community tag someone wears: its letters, its colour (the community's accent) and the community. */
@Serializable
data class WornTag(val orgId: String, val text: String, val color: String? = null)

/** What lists and messages need of a person's look; kept with the person on this phone (`users.lookJson`). */
@Serializable
data class PersonLook(val avatarMedia: MediaRef? = null, val style: ProfileStyleDto? = null, val tag: WornTag? = null) {
    val isEmpty: Boolean get() = avatarMedia == null && style == null && tag == null
}

/** The server's fixed lists (server `PROFILE_DECORATIONS`, `PROFILE_EFFECTS`, `NAME_FONTS`, `NAME_EFFECTS`). */
object LookRules {
    val DECORATIONS = listOf("aurora", "ember", "frost", "neon", "sakura", "pixel")
    val EFFECTS = listOf("sparkles", "glow", "stars", "bubbles")
    val NAME_FONTS = listOf("pixel", "arcade", "script", "block", "tech", "mono")
    val NAME_EFFECTS = listOf("glow", "shimmer")
    const val MAX_NAME_COLORS = 3
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    fun isHex(v: String): Boolean = HEX.matches(v)

    /** `#rrggbb` as an ARGB long, or null for anything else (the server stores what it accepted, but views are data). */
    fun argb(hex: String?): Long? = hex?.takeIf(::isHex)?.substring(1)?.toLong(16)?.let { 0xFF000000L or it }

    /**
     * Meldiq's colour presets for names, profiles and the app's tint (as Meldiq Web's `COLOR_PRESETS`): our own
     * names, two or three stops each.
     */
    val COLOR_PRESETS: List<Pair<String, List<String>>> = listOf(
        "lagoon" to listOf("#22d3ee", "#3b82f6"),
        "blaze" to listOf("#f97316", "#ef4444"),
        "orchid" to listOf("#c084fc", "#ec4899"),
        "matcha" to listOf("#a3e635", "#22c55e"),
        "sunrise" to listOf("#fbbf24", "#f472b6"),
        "glacier" to listOf("#a5f3fc", "#818cf8"),
        "candy" to listOf("#f9a8d4", "#a78bfa", "#67e8f9"),
        "toxic" to listOf("#bef264", "#10b981", "#0ea5e9"),
        "royal" to listOf("#6366f1", "#a855f7"),
        "ember" to listOf("#fde047", "#f97316", "#dc2626"),
        "gold" to listOf("#fde68a", "#f59e0b"),
        "arcade" to listOf("#f0abfc", "#22d3ee", "#a3e635"),
    )

    /** The colours a name is painted in: valid `#rrggbb` only, at most three; empty means the usual name colour. */
    fun nameColors(style: ProfileStyleDto?): List<Long> = style?.nameColors.orEmpty().mapNotNull(::argb).take(MAX_NAME_COLORS)
}

/** [PersonLook] to and from `users.lookJson` (decoded once per distinct value: rows draw it often). */
object PersonLooks {
    private val cache = object : LinkedHashMap<String, PersonLook>(LOOK_CACHE, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PersonLook>?) = size > LOOK_CACHE
    }

    fun encode(look: PersonLook): String? = if (look.isEmpty) null else com.meldiq.android.data.api.GriipJson.encodeToString(PersonLook.serializer(), look)

    fun of(json: String?): PersonLook? {
        if (json.isNullOrEmpty()) return null
        synchronized(cache) { cache[json] }?.let { return it }
        val look = runCatching { com.meldiq.android.data.api.GriipJson.decodeFromString(PersonLook.serializer(), json) }.getOrNull() ?: return null
        synchronized(cache) { cache[json] = look }
        return look
    }

    private const val LOOK_CACHE = 256
}
