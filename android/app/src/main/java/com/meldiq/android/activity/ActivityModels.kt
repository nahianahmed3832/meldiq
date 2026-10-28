package com.meldiq.android.activity

import com.meldiq.android.data.api.SendNulls
import kotlinx.serialization.Serializable

/**
 * Activity status (API 0.56.0, docs/ACTIVITY_STATUS.md): "Playing PUBG Mobile" since [startedAt], as the server shows
 * it to the people who may see someone's presence. [kind] is "playing" today; other kinds are ignored by this app.
 */
@Serializable data class ActivityDto(
    val kind: String = KIND_PLAYING,
    val name: String,
    val packageId: String? = null,
    val startedAt: Long = 0,
)

/** What this phone reports: always a package and a start, so no null reaches the server's strict schema. */
@Serializable data class ActivityInput(val kind: String, val name: String, val packageId: String, val startedAt: Long)

/** PUT /v2/me/activity; a null [activity] clears it, so nulls are sent. */
@SendNulls @Serializable data class ActivityReq(val activity: ActivityInput?)

@Serializable data class ActivityRes(val activity: ActivityDto? = null)

const val KIND_PLAYING = "playing"

/** A game this phone recognised: its package and the name shown for it. */
data class Game(val packageId: String, val name: String)
