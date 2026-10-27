package com.meldiq.android.data.model

/** Batch B3: a channel's slowmode as the server describes it to this account. */
data class Slowmode(val seconds: Int, val exempt: Boolean, val nextPostAt: Long?)

/** Slowmode rules shared by the edit sheet and the composer (pure, `ChannelControlsRulesTest`). */
object SlowmodeRules {
    /** The intervals the server accepts, in seconds; 0 is off. */
    val STEPS = listOf(0, 5, 10, 30, 60, 300, 900, 3600, 21600)

    /** Seconds left before [s] lets this person post again, or 0. */
    fun secondsLeft(s: Slowmode?, now: Long): Int {
        if (s == null || s.exempt || s.seconds <= 0) return 0
        val next = s.nextPostAt ?: return 0
        return if (next > now) ((next - now + 999) / 1000).toInt() else 0
    }

    /** The server's "post again at" from a slowmode refusal's details ({retryAfter, nextPostAt}). */
    fun nextFrom(details: kotlinx.serialization.json.JsonElement?): Long? =
        (details as? kotlinx.serialization.json.JsonObject)?.get("nextPostAt")
            ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull() }

    /** When the next message may go out after one sent [at]. */
    fun nextAfterPost(s: Slowmode?, at: Long): Long? = if (s == null || s.exempt || s.seconds <= 0) null else at + s.seconds * 1000L

    /** "30 s", "5 min", "1 h": a short form of an interval for chips and notices. */
    fun short(seconds: Int): Pair<Int, Unit> = when {
        seconds >= 3600 -> seconds / 3600 to Unit.HOURS
        seconds >= 60 -> seconds / 60 to Unit.MINUTES
        else -> seconds to Unit.SECONDS
    }

    enum class Unit { SECONDS, MINUTES, HOURS }
}

/** Batch B3: mutes that end by themselves (Discord reference CHAN-CTRL-002). */
object MuteRules {
    private const val MINUTE = 60_000L
    /** 15 minutes, 1 hour, 3 hours, 8 hours, 24 hours; "until I turn it back on" is a mute without an end. */
    val DURATIONS = listOf(15 * MINUTE, 60 * MINUTE, 180 * MINUTE, 480 * MINUTE, 1440 * MINUTE)

    /** When a mute chosen at [now] for [duration] ends; null for one without an end. */
    fun until(duration: Long?, now: Long): Long? = duration?.let { now + it }

    /** The soonest end of a timed mute after [now] across [docs], to look again then. */
    fun nextExpiry(docs: Collection<com.meldiq.android.data.api.NavPrefsDto>, now: Long): Long? =
        docs.flatMap { it.mutedUntil.orEmpty().values + listOfNotNull(it.community?.mutedUntil) }.filter { it > now }.minOrNull()
}
