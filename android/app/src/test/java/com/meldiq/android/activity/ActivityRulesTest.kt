package com.meldiq.android.activity

import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.RealtimeCodec
import com.meldiq.android.data.api.ServerEvent
import com.meldiq.android.data.api.encodeBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityRulesTest {
    private val pubg = Game("com.tencent.ig", "PUBG Mobile")
    private val freeFire = Game("com.dts.freefireth", "Free Fire")

    @Test
    fun `known games count and keep their names, other apps only when Android says game, never Meldiq`() {
        assertTrue(KnownGames.counts("com.tencent.ig", androidSaysGame = false, ownPackage = "com.meldiq.android"))
        assertEquals("PUBG Mobile", KnownGames.displayName("com.tencent.ig", "PUBG MOBILE"))
        assertEquals("Free Fire", KnownGames.displayName("com.dts.freefireth", null))
        assertFalse(KnownGames.counts("com.whatsapp", androidSaysGame = false, ownPackage = "com.meldiq.android"))
        assertTrue(KnownGames.counts("com.indie.puzzle", androidSaysGame = true, ownPackage = "com.meldiq.android"))
        assertFalse(KnownGames.counts("com.meldiq.android", androidSaysGame = true, ownPackage = "com.meldiq.android"))
        assertEquals("Puzzle", KnownGames.displayName("com.indie.puzzle", "  Puzzle​ "))
        assertEquals(KnownGames.MAX_NAME, KnownGames.displayName("com.indie.long", "x".repeat(100))!!.length)
        assertNull(KnownGames.displayName("com.indie.blank", "  "))
    }

    @Test
    fun `the foreground follows resumes, pauses and the screen turning off`() {
        val resumed = Foreground.NONE.after(listOf(UsageEvent(UsageEvent.Type.RESUMED, "com.tencent.ig", 100)))
        assertEquals(Foreground("com.tencent.ig", 100), resumed)
        // Another activity of the same game doesn't restart the clock.
        assertEquals(resumed, resumed.after(listOf(UsageEvent(UsageEvent.Type.RESUMED, "com.tencent.ig", 200))))
        // Pausing another app changes nothing; pausing the game leaves nothing in front.
        assertEquals(resumed, resumed.after(listOf(UsageEvent(UsageEvent.Type.PAUSED, "com.whatsapp", 300))))
        assertEquals(Foreground(null, 400), resumed.after(listOf(UsageEvent(UsageEvent.Type.PAUSED, "com.tencent.ig", 400))))
        assertEquals(Foreground(null, 500), resumed.after(listOf(UsageEvent(UsageEvent.Type.SCREEN_OFF, null, 500))))
        val switched = resumed.after(listOf(UsageEvent(UsageEvent.Type.PAUSED, "com.tencent.ig", 600), UsageEvent(UsageEvent.Type.RESUMED, "com.dts.freefireth", 610)))
        assertEquals(Foreground("com.dts.freefireth", 610), switched)
    }

    @Test
    fun `a game shows once it settled, refreshes, survives a quick look away and ends after the grace`() {
        val t0 = 1_000_000L
        // Opened just now: not yet.
        assertEquals(ReportPolicy.Step.Keep, ReportPolicy.next(t0 + 5_000, pubg to t0, null, 0))
        // Settled: sent with the time it came to the front.
        assertEquals(ReportPolicy.Step.Send(pubg, t0), ReportPolicy.next(t0 + ReportPolicy.SETTLE_MS, pubg to t0, null, 0))
        val sent = Reported(pubg, t0, t0 + ReportPolicy.SETTLE_MS)
        assertEquals(ReportPolicy.Step.Keep, ReportPolicy.next(sent.sentAt + 60_000, pubg to t0, sent, sent.sentAt + 60_000))
        // Refreshed before the server's 10 minutes, keeping the start.
        assertEquals(ReportPolicy.Step.Send(pubg, t0), ReportPolicy.next(sent.sentAt + ReportPolicy.REFRESH_MS, pubg to t0, sent, sent.sentAt + ReportPolicy.REFRESH_MS))
        // Away to read a message: kept for the grace period, then cleared.
        val left = sent.sentAt + 30_000
        assertEquals(ReportPolicy.Step.Keep, ReportPolicy.next(left + ReportPolicy.GRACE_MS - 1, null, sent, left))
        assertEquals(ReportPolicy.Step.Clear, ReportPolicy.next(left + ReportPolicy.GRACE_MS, null, sent, left))
        // Another game takes over once it settled.
        assertEquals(ReportPolicy.Step.Send(freeFire, left), ReportPolicy.next(left + ReportPolicy.SETTLE_MS, freeFire to left, sent, left))
        assertEquals(ReportPolicy.Step.Keep, ReportPolicy.next(left + 1_000, freeFire to left, sent, left))
    }

    @Test
    fun `elapsed time reads as just started, minutes, then hours and minutes`() {
        assertEquals(ActivityElapsed.Shown.JustStarted, ActivityElapsed.of(0, 59_999))
        assertEquals(ActivityElapsed.Shown.Minutes(12), ActivityElapsed.of(0, 12 * 60_000L + 5))
        assertEquals(ActivityElapsed.Shown.Hours(2, 5), ActivityElapsed.of(0, 125 * 60_000L))
        assertEquals(ActivityElapsed.Shown.JustStarted, ActivityElapsed.of(10_000, 0))
    }

    @Test
    fun `lists update others' activities, never your own, and frames end them`() {
        val people = PeopleActivity { "me" }
        people.seen("ada", ActivityDto(name = "PUBG Mobile", startedAt = 1))
        people.seen("me", null)
        people.apply("me", ActivityDto(name = "Free Fire", startedAt = 2))
        people.seen("me", null)
        assertEquals("PUBG Mobile", people.of("ada")?.name)
        assertEquals("Free Fire", people.of("me")?.name)
        people.seen("ada", null)
        assertNull(people.of("ada"))
        people.apply("bob", ActivityDto(kind = "watching", name = "A film"))
        assertNull(people.of("bob"))
        people.clear()
        assertTrue(people.all.value.isEmpty())
    }

    @Test
    fun `a cleared activity is sent as null and a frame decodes`() {
        assertEquals("""{"activity":null}""", encodeBody(ActivityReq.serializer(), ActivityReq(null)))
        val body = encodeBody(ActivityReq.serializer(), ActivityReq(ActivityInput(KIND_PLAYING, "PUBG Mobile", "com.tencent.ig", 5)))
        assertEquals("""{"activity":{"kind":"playing","name":"PUBG Mobile","packageId":"com.tencent.ig","startedAt":5}}""", body)
        val frame = RealtimeCodec.decode("""{"t":"activity","userId":"u_1","activity":{"kind":"playing","name":"PUBG Mobile","packageId":"com.tencent.ig","startedAt":5}}""") as ServerEvent.Activity
        assertEquals("PUBG Mobile", frame.activity?.name)
        val ended = RealtimeCodec.decode("""{"t":"activity","userId":"u_1","activity":null}""") as ServerEvent.Activity
        assertNull(ended.activity)
        assertNull(GriipJson.decodeFromString(ActivityRes.serializer(), """{"activity":null}""").activity)
    }
}
