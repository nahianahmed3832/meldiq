package com.meldiq.android.activity

import android.util.Log
import com.meldiq.android.data.api.ApiClient
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.withContext

/**
 * Tells the server which game the person is playing (docs/ACTIVITY_STATUS.md), only after they turned on "Share what
 * I'm playing" and allowed Usage access. It runs in the app's process while the relay connection is up, which "Stay
 * connected in background" keeps alive while a game is in front: no service of its own. It looks every
 * [ReportPolicy.POLL_MS] while the screen is on, and sends only games ([GameDetector.gameOf]) the person didn't hide.
 */
class ActivityReporter(
    private val detector: GameDetector,
    private val settings: ActivitySettings,
    private val api: ApiClient,
    private val people: PeopleActivity,
    private val myUserId: () -> String?,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _front = MutableStateFlow<Game?>(null)
    /** The game in front now, for Activity privacy (null: none, or not looking). */
    val front: StateFlow<Game?> = _front

    /** Watches while [active] is true; stops (and clears what it reported) when it turns false. */
    suspend fun run(active: Flow<Boolean>) {
        active.distinctUntilChanged().collectLatest { on -> if (on) watch() }
    }

    private suspend fun watch() {
        var front = Foreground.NONE
        var lookedAt = clock() - LOOKBACK_MS
        var reported: Reported? = null
        var lastInFront = 0L
        try {
            while (true) {
                val now = clock()
                if (!detector.hasUsageAccess()) {
                    // Usage access was taken away in system settings: nothing can be known, so nothing is shown.
                    if (reported != null && send(null)) reported = null
                    _front.value = null
                    delay(ReportPolicy.POLL_MS)
                    continue
                }
                front = if (detector.screenOn()) front.after(detector.events(lookedAt, now)) else Foreground(null, now)
                lookedAt = now
                val hidden = settings.state.value.hidden
                val game = front.packageId?.let(detector::gameOf)?.takeIf { it.packageId !in hidden }
                _front.value = game
                game?.let(settings::noticed)
                val current = reported
                if (current != null && current.game.packageId in hidden) {
                    if (send(null)) reported = null
                } else {
                    if (current != null && game?.packageId == current.game.packageId) lastInFront = now
                    when (val step = ReportPolicy.next(now, game?.let { it to front.since }, current, lastInFront)) {
                        is ReportPolicy.Step.Send -> if (send(ActivityInput(KIND_PLAYING, step.game.name, step.game.packageId, step.startedAt))) {
                            if (current?.game?.packageId != step.game.packageId) lastInFront = now
                            reported = Reported(step.game, step.startedAt, now)
                        }
                        ReportPolicy.Step.Clear -> if (send(null)) reported = null
                        ReportPolicy.Step.Keep -> Unit
                    }
                }
                delay(ReportPolicy.POLL_MS)
            }
        } finally {
            _front.value = null
            // Turned off or disconnected: end it now (a server that lost the connection ends it on its own anyway).
            if (reported != null) withContext(NonCancellable) { send(null) }
        }
    }

    /** One PUT /v2/me/activity; false when it didn't reach the server (tried again at the next look). */
    private suspend fun send(input: ActivityInput?): Boolean = runCatching {
        val res = api.put<ActivityReq, ActivityRes>("/v2/me/activity", ActivityReq(input))
        myUserId()?.let { people.apply(it, res.activity) }
    }.onFailure { Log.w(TAG, "activity not sent: ${it.javaClass.simpleName}") }.isSuccess

    private companion object {
        const val TAG = "MeldiqActivity"
        /** How far back the first look reads, to find a game that was already in front. */
        const val LOOKBACK_MS = 15 * 60_000L
    }
}
