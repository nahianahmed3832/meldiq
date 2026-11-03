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
    private val plus = Entitlements(personal = PersonalEntitlement(plan = PlanRef("plus", "Meldiq Plus"), standing = "entitled"), revision = "2")

    private class FakeBackend(var ent: Entitlements) : MojoBackend {
        val verified = mutableListOf<PlayVerifyReq>()
        val intents = mutableListOf<PlayIntentReq>()
        var verifyAnswer: (PlayVerifyReq) -> PlayVerifyRes = { PlayVerifyRes("granted") }
        var intentFails: Exception? = null
        var catalogFails = false
        override suspend fun catalog(): MojoCatalog = if (catalogFails) throw ApiException(404, "not_found", "no") else MojoCatalog(version = "1", plusTerms = listOf(PlusTerm("monthly",1,499,"USD","month",1), PlusTerm("quarterly",3,1299,"USD","month",3), PlusTerm("yearly",12,4999,"USD","year",1)), plans = listOf(PlanPerks("plus", "Meldiq Plus", listPriceMinor = 499)))
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
        var prices = mapOf("mojo_plus" to PlayOffer("mojo_plus", "$4.99", "P1M", "USD", 4_990_000), "mojo_plus_quarterly" to PlayOffer("mojo_plus_quarterly", "$12.99", "P3M", "USD", 12_990_000), "mojo_plus_yearly" to PlayOffer("mojo_plus_yearly", "$49.99", "P1Y", "USD", 49_990_000), "gift_plus_3m" to PlayOffer("gift_plus_3m", "$12.99", null, "USD", 12_990_000))
        var offerQueries = 0
        override suspend fun offers() = run { offerQueries++; prices }
        override suspend fun owned() = owned
        override fun launch(activity: Activity, launch: PlayLaunch): PlayError? = null
        override fun close() {}
    }

    private fun TestScope.repo(backend: FakeBackend, play: FakePlay) = MojoRepository(backend, play, backgroundScope)

    @Test
    fun `approved recurring terms use their native product and exact USD store price`() = runTest(UnconfinedTestDispatcher()) {
        for (product in listOf("mojo_plus", "mojo_plus_quarterly", "mojo_plus_yearly")) {
            val b = FakeBackend(free)
            val r = repo(b, FakePlay())
            r.refresh()
            assertEquals(product, r.prepare(MojoPurchase.Plan("plus", product, null))?.productId)
            assertEquals(product, b.intents.single().productId)
        }
    }

    @Test
    fun `a mismatched store price or cadence cannot start a quarterly subscription`() = runTest(UnconfinedTestDispatcher()) {
        for (offer in listOf(PlayOffer("mojo_plus_quarterly", "$14.97", "P3M", "USD", 14_970_000), PlayOffer("mojo_plus_quarterly", "$12.99", "P1M", "USD", 12_990_000))) {
            val b = FakeBackend(free)
            val store = FakePlay().apply { prices = prices + (offer.productId to offer) }
            val r = repo(b, store)
            r.refresh()
            assertNull(r.prepare(MojoPurchase.Plan("plus", offer.productId, null)))
            assertTrue(b.intents.isEmpty())
        }
    }

    @Test
    fun `refresh loads the catalog, entitlements and Google's offers`() = runTest(UnconfinedTestDispatcher()) {
        val r = repo(FakeBackend(free), FakePlay())
        r.refresh()
        assertEquals("1", r.state.value.catalog?.version)
        assertEquals("$4.99", r.state.value.offers["mojo_plus"]?.price)
        assertEquals(false, r.state.value.unavailable)
    }

    @Test
    fun `media preflight refreshes entitlements without querying Play offers`() = runTest(UnconfinedTestDispatcher()) {
        val play = FakePlay()
        val r = repo(FakeBackend(plus), play)
        r.refreshUploadLimits()
        assertEquals("1", r.state.value.catalog?.version)
        assertEquals("plus", MojoPlans.currentKey(r.state.value.entitlements))
        assertEquals(0, play.offerQueries)
        assertTrue(r.state.value.offers.isEmpty())
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
        r.refresh()
        val launch = r.prepare(MojoPurchase.Gift("plus", 3, "u_friend", "  happy birthday ", "gift_plus_3m"))
        assertEquals(PlayLaunch("gift_plus_3m", "acct_tok", "chk_1", null), launch)
        assertEquals(PlayIntentReq("gift", "gift_plus_3m", planKey = "plus", giftTo = "u_friend", months = 3, note = "happy birthday"), b.intents.single())
        assertEquals("gift_plus_3m", r.state.value.busy)
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
        r.refresh()
        assertNull(r.prepare(MojoPurchase.Plan("plus", "mojo_plus", null)))
        assertEquals(MojoNotice.Failed(PlayError.NOT_SET_UP), r.state.value.notice)
        b.intentFails = java.io.IOException("offline")
        assertNull(r.prepare(MojoPurchase.Plan("plus", "mojo_plus", null)))
        assertEquals(MojoNotice.Failed(PlayError.NETWORK), r.state.value.notice)
    }
}
