package com.meldiq.android.activity

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONObject

/** Activity privacy for one server profile: off until the person turns it on, and games they chose to never show. */
data class ActivityPrefs(
    val share: Boolean = false,
    /** Packages never reported. */
    val hidden: Set<String> = emptySet(),
    /** Games this phone noticed (package → name), newest first, so they can be hidden later. */
    val seen: Map<String, String> = emptyMap(),
)

/**
 * Kept on this phone only (docs/ACTIVITY_STATUS.md), per server profile, apart from SettingsStore: the server never
 * learns which games are hidden or which ones the phone noticed.
 */
class ActivitySettings(context: Context, profileId: String) {
    private val prefs = context.getSharedPreferences("meldiq_activity_$profileId", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(load())
    val state: StateFlow<ActivityPrefs> = _state

    fun setShare(on: Boolean) = save { it.copy(share = on) }

    fun setHidden(packageId: String, hidden: Boolean) = save { it.copy(hidden = if (hidden) it.hidden + packageId else it.hidden - packageId) }

    /** Remembers a game the phone noticed (at most [MAX_SEEN], the newest kept). */
    fun noticed(game: Game) {
        if (_state.value.seen.keys.firstOrNull() == game.packageId) return
        save { p -> p.copy(seen = (mapOf(game.packageId to game.name) + (p.seen - game.packageId)).entries.take(MAX_SEEN).associate { it.key to it.value }) }
    }

    private fun save(change: (ActivityPrefs) -> ActivityPrefs) {
        _state.update(change)
        val p = _state.value
        prefs.edit()
            .putBoolean(KEY_SHARE, p.share)
            .putStringSet(KEY_HIDDEN, p.hidden)
            .putString(KEY_SEEN, JSONObject(p.seen as Map<*, *>).toString())
            .putString(KEY_SEEN_ORDER, p.seen.keys.joinToString("\n"))
            .apply()
    }

    private fun load(): ActivityPrefs {
        val names = runCatching { JSONObject(prefs.getString(KEY_SEEN, null) ?: "{}") }.getOrNull()
        val order = prefs.getString(KEY_SEEN_ORDER, null)?.split("\n")?.filter { it.isNotBlank() }.orEmpty()
        val seen = order.mapNotNull { pkg -> names?.optString(pkg)?.takeIf { it.isNotBlank() }?.let { pkg to it } }.toMap()
        return ActivityPrefs(
            share = prefs.getBoolean(KEY_SHARE, false),
            hidden = prefs.getStringSet(KEY_HIDDEN, emptySet()).orEmpty().toSet(),
            seen = seen,
        )
    }

    private companion object {
        const val KEY_SHARE = "share"
        const val KEY_HIDDEN = "hidden"
        const val KEY_SEEN = "seen"
        const val KEY_SEEN_ORDER = "seen_order"
        const val MAX_SEEN = 20
    }
}
