package com.meldiq.android.activity

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * What the people this account can see are playing (API 0.56.0, docs/ACTIVITY_STATUS.md): from `activity` frames and
 * from the profiles, member lists and presence entries the app loads. Kept in memory only: an activity lasts minutes,
 * and the next list or frame brings it back after a restart.
 */
class PeopleActivity(private val myUserId: () -> String?) {
    private val _all = MutableStateFlow<Map<String, ActivityDto>>(emptyMap())
    val all: StateFlow<Map<String, ActivityDto>> = _all

    fun of(userId: String): ActivityDto? = _all.value[userId]

    /** A live frame, or this phone's own report: [activity] null ends it. Kinds this app doesn't show are dropped. */
    fun apply(userId: String, activity: ActivityDto?) {
        val shown = activity?.takeIf { it.kind == KIND_PLAYING && it.name.isNotBlank() }
        _all.update { if (shown == null) it - userId else it + (userId to shown) }
    }

    /**
     * A profile, member or presence entry: an absent activity means none is shown to this account. Your own is left
     * to frames and this phone's report, because your own profile (GET /v1/users/me) doesn't carry it.
     */
    fun seen(userId: String, activity: ActivityDto?) {
        if (userId == myUserId()) return
        apply(userId, activity)
    }

    /** Signed out or the profile closed. */
    fun clear() = _all.update { emptyMap() }
}
