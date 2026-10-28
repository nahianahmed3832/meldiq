package com.meldiq.android.activity

/** One usage event the tracker reads, in the order Android recorded them. */
data class UsageEvent(val type: Type, val packageId: String?, val at: Long) {
    enum class Type { RESUMED, PAUSED, SCREEN_OFF }
}

/** The app in the foreground ([packageId], null: none or the screen is off) and since when. */
data class Foreground(val packageId: String?, val since: Long) {
    /** The foreground after [events]: an app resumed comes to the front, the front app paused or the screen off leaves none. */
    fun after(events: List<UsageEvent>): Foreground = events.fold(this) { f, e ->
        when (e.type) {
            UsageEvent.Type.RESUMED -> if (e.packageId != null && e.packageId != f.packageId) Foreground(e.packageId, e.at) else f
            UsageEvent.Type.PAUSED -> if (e.packageId == f.packageId) Foreground(null, e.at) else f
            UsageEvent.Type.SCREEN_OFF -> Foreground(null, e.at)
        }
    }

    companion object {
        val NONE = Foreground(null, 0)
    }
}

/** What this phone last told the server: [game] since [startedAt], sent at [sentAt]. */
data class Reported(val game: Game, val startedAt: Long, val sentAt: Long)

/**
 * When to tell the server (docs/ACTIVITY_STATUS.md). A game shows once it stayed in front for [SETTLE_MS] (opening a
 * game by mistake shows nothing); it stays shown for [GRACE_MS] after it left the front (a quick look at a message
 * doesn't end it); while it lasts it's sent again every [REFRESH_MS], well inside the server's 10 minutes.
 */
object ReportPolicy {
    /** How often the phone looks, while the screen is on. */
    const val POLL_MS = 30_000L
    const val SETTLE_MS = 15_000L
    const val GRACE_MS = 2 * 60_000L
    const val REFRESH_MS = 4 * 60_000L

    sealed interface Step {
        data class Send(val game: Game, val startedAt: Long) : Step
        data object Clear : Step
        data object Keep : Step
    }

    /**
     * [front]: the game in front now and since when (null: no game, or a hidden one); [lastInFront]: when the reported
     * game was last seen in front.
     */
    fun next(now: Long, front: Pair<Game, Long>?, reported: Reported?, lastInFront: Long): Step {
        val settled = front?.takeIf { (_, since) -> now - since >= SETTLE_MS }
        if (settled != null) {
            val (game, since) = settled
            return when {
                reported == null || reported.game.packageId != game.packageId -> Step.Send(game, since)
                now - reported.sentAt >= REFRESH_MS -> Step.Send(reported.game, reported.startedAt)
                else -> Step.Keep
            }
        }
        if (reported == null) return Step.Keep
        val stillInFront = front?.first?.packageId == reported.game.packageId
        return when {
            !stillInFront && now - lastInFront >= GRACE_MS -> Step.Clear
            now - reported.sentAt >= REFRESH_MS -> Step.Send(reported.game, reported.startedAt)
            else -> Step.Keep
        }
    }
}

/** How long someone has been playing, as the activity line shows it. */
object ActivityElapsed {
    sealed interface Shown {
        data object JustStarted : Shown
        data class Minutes(val minutes: Long) : Shown
        data class Hours(val hours: Long, val minutes: Long) : Shown
    }

    fun of(startedAt: Long, now: Long): Shown {
        val minutes = ((now - startedAt).coerceAtLeast(0)) / 60_000
        return when {
            minutes < 1 -> Shown.JustStarted
            minutes < 60 -> Shown.Minutes(minutes)
            else -> Shown.Hours(minutes / 60, minutes % 60)
        }
    }
}
