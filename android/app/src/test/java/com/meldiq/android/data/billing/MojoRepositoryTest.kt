package com.meldiq.android.data.billing

import android.app.Activity
import com.meldiq.android.data.api.ApiException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Purchases count only once the server has verified them (docs/MOJO_ANDROID.md). */
@OptIn(ExperimentalCoroutinesApi::class)
class MojoRepositoryTest {
    private val free = Entitlements(personal = PersonalEntitlement())
    private val plus = Entitlements(personal = PersonalEntitlement(plan = PlanRef("plus", "Mojo Plus"), standing = "entitled"), revision = "2")

    private class FakeBackend(var ent: Entitlements) : MojoBackend {
        val verified = mutableListOf<PlayVerifyReq>()
        val intents = mutableListOf<PlayIntentReq>()
        var verifyAnswer: (PlayVerifyReq) -> PlayVerifyRes = { PlayVerifyRes("granted") }
        var intentFails: Exception? = null
        var catalogFails = false
        override suspend fun catalog(): MojoCatalog = if (catalogFails) throw ApiException(404, "not_found", "no") else MojoCatalog(version = "1")
        override suspend fun entitlements(): Entitlements = ent
        override suspend fun intent(req: PlayIntentReq): PlayIntentRes {
            intentFails?.let { throw it }
            intents += req
            return PlayIntentRes("chk_1", "acct_tok")
        }
        override suspend fun verify(req: PlayVerifyReq): PlayVerifyRes {
            verified += req
            return verifyAnswer(req)
        }
    }

    private class FakePlay : PlayStore {
        override val updates = MutableSharedFlow<PlayUpdate>()
        var owned = listOf<PlayPurchase>()
        override suspend fun offers() = mapOf("mojo_plus" to PlayOffer("mojo_plus", "$3.99", "P1M"))
        override suspend fun owned() = owned
        override fun launch(activity: Activity, launch: PlayLaunch): PlayError? = null
        override fun close() {}
    }

    private fun TestScope.repo(backend: FakeBackend, play: FakePlay) = MojoRepository(backend, play, backgroundScope)

    @Test
    fun `refresh loads the catalog, entitlements and Google's offers`() = runTest(UnconfinedTestDispatcher()) {
        val r = repo(FakeBackend(free), FakePlay())
        r.refresh()
        assertEquals("1", r.state.value.catalog?.version)
        assertEquals("$3.99", r.state.value.offers["mojo_plus"]?.price)
        assertEquals(false, r.state.value.unavailable)
    }

    @Test
    fun `a server without Mojo is shown as unavailable`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free).apply { catalogFails = true }
        val r = repo(b, FakePlay())
        r.refresh()
        assertTrue(r.state.value.unavailable)
    }

    @Test
    fun `prepare records the intent and carries the server's opaque ids`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free)
        val r = repo(b, FakePlay())
        val launch = r.prepare(MojoPurchase.Gift("go", 3, "u_friend", "  happy birthday ", "gift_go_3m"))
        assertEquals(PlayLaunch("gift_go_3m", "acct_tok", "chk_1", null), launch)
        assertEquals(PlayIntentReq("gift", "gift_go_3m", planKey = "go", giftTo = "u_friend", months = 3, note = "happy birthday"), b.intents.single())
        assertEquals("gift_go_3m", r.state.value.busy)
    }

    @Test
    fun `a second purchase can't start while one is in progress`() = runTest(UnconfinedTestDispatcher()) {
        val r = repo(FakeBackend(free), FakePlay())
        r.prepare(MojoPurchase.Plan("plus", "mojo_plus", null))
        assertNull(r.prepare(MojoPurchase.Plan("go", "mojo_go", null)))
    }

    @Test
    fun `nothing changes until the server confirms, then the new entitlements apply`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free)
        val play = FakePlay()
        val r = repo(b, play)
        r.refresh()
        r.prepare(MojoPurchase.Plan("plus", "mojo_plus", null))
        b.verifyAnswer = { PlayVerifyRes("granted", plus) }
        play.updates.emit(PlayUpdate.Purchased(listOf(PlayPurchase("mojo_plus", "tok", pending = false, acknowledged = false))))
        assertEquals(PlayVerifyReq("mojo_plus", "tok"), b.verified.single())
        assertEquals(MojoNotice.Confirmed("mojo_plus"), r.state.value.notice)
        assertEquals("plus", MojoPlans.currentKey(r.state.value.entitlements))
        assertNull(r.state.value.busy)
    }

    @Test
    fun `a pending payment grants nothing and isn't sent for verification`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free)
        val play = FakePlay()
        val r = repo(b, play)
        play.updates.emit(PlayUpdate.Purchased(listOf(PlayPurchase("mojo_go", "tok", pending = true, acknowledged = false))))
        assertEquals(MojoNotice.Pending, r.state.value.notice)
        assertTrue(b.verified.isEmpty())
    }

    @Test
    fun `the server's refusals are shown as they are`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free).apply { verifyAnswer = { PlayVerifyRes("already_linked") } }
        val play = FakePlay()
        val r = repo(b, play)
        play.updates.emit(PlayUpdate.Purchased(listOf(PlayPurchase("mojo_go", "tok", pending = false, acknowledged = false))))
        assertEquals(MojoNotice.OtherAccount, r.state.value.notice)
        assertEquals("free", MojoPlans.currentKey(r.state.value.entitlements))
    }

    @Test
    fun `cancelling or a Play error ends the purchase without granting`() = runTest(UnconfinedTestDispatcher()) {
        val play = FakePlay()
        val r = repo(FakeBackend(free), play)
        r.prepare(MojoPurchase.Sparks(2, "spark_2"))
        play.updates.emit(PlayUpdate.Cancelled)
        assertEquals(MojoNotice.Cancelled, r.state.value.notice)
        assertNull(r.state.value.busy)
        play.updates.emit(PlayUpdate.Failed(PlayError.NETWORK))
        assertEquals(MojoNotice.Failed(PlayError.NETWORK), r.state.value.notice)
    }

    @Test
    fun `when the server can't be reached the purchase waits for the next reconcile`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free).apply { verifyAnswer = { throw java.io.IOException("offline") } }
        val play = FakePlay()
        val r = repo(b, play)
        play.updates.emit(PlayUpdate.Purchased(listOf(PlayPurchase("mojo_go", "tok", pending = false, acknowledged = false))))
        assertEquals(MojoNotice.NotConfirmedYet, r.state.value.notice)

        b.verifyAnswer = { PlayVerifyRes("granted") }
        b.ent = plus
        play.owned = listOf(
            PlayPurchase("mojo_go", "tok", pending = false, acknowledged = false),
            PlayPurchase("spark_1", "old", pending = false, acknowledged = true),
            PlayPurchase("gift_go_1m", "wait", pending = true, acknowledged = false),
        )
        r.reconcile()
        assertEquals(listOf("tok", "tok"), b.verified.map { it.purchaseToken })
        assertEquals("plus", MojoPlans.currentKey(r.state.value.entitlements))
    }

    @Test
    fun `an intent the server refuses reads as not set up, a network error as network`() = runTest(UnconfinedTestDispatcher()) {
        val b = FakeBackend(free).apply { intentFails = ApiException(404, "not_found", "no") }
        val r = repo(b, FakePlay())
        assertNull(r.prepare(MojoPurchase.Plan("go", "mojo_go", null)))
        assertEquals(MojoNotice.Failed(PlayError.NOT_SET_UP), r.state.value.notice)
        b.intentFails = java.io.IOException("offline")
        assertNull(r.prepare(MojoPurchase.Plan("go", "mojo_go", null)))
        assertEquals(MojoNotice.Failed(PlayError.NETWORK), r.state.value.notice)
    }
}
