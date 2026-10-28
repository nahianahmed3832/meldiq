package com.meldiq.android.data.billing

import android.app.Activity
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.OkRes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The server side of Meldiq Mojo (docs/MOJO_ANDROID.md). An interface so the repository can be tested with a fake. */
interface MojoBackend {
    suspend fun catalog(): MojoCatalog
    suspend fun entitlements(): Entitlements
    suspend fun intent(req: PlayIntentReq): PlayIntentRes
    suspend fun verify(req: PlayVerifyReq): PlayVerifyRes
    // API 0.54.0 (docs/MOJO.md): Sparks, the badge and gifts. Defaults so fakes that don't use them needn't implement them.
    suspend fun me(): MojoMe = throw UnsupportedOperationException("me")
    suspend fun orgSparks(orgId: String): OrgSparks = throw UnsupportedOperationException("orgSparks")
    suspend fun giveSpark(orgId: String): SparkAssigned = throw UnsupportedOperationException("giveSpark")
    suspend fun moveSpark(id: String, orgId: String): SparkAssigned = throw UnsupportedOperationException("moveSpark")
    suspend fun removeSpark(id: String): Unit = throw UnsupportedOperationException("removeSpark")
    suspend fun setBadgeHidden(hidden: Boolean): Unit = throw UnsupportedOperationException("badge")
    suspend fun redeemGift(id: String): GiftRedeemed = throw UnsupportedOperationException("redeem")
}

class HttpMojoBackend(private val api: ApiClient) : MojoBackend {
    override suspend fun catalog(): MojoCatalog = api.get("/v2/mojo/catalog")
    override suspend fun entitlements(): Entitlements = api.get("/v2/billing/entitlements")
    override suspend fun intent(req: PlayIntentReq): PlayIntentRes = api.post("/v2/mojo/play/intent", req)
    override suspend fun verify(req: PlayVerifyReq): PlayVerifyRes = api.post("/v2/mojo/play/verify", req)
    override suspend fun me(): MojoMe = api.get("/v2/mojo/me")
    override suspend fun orgSparks(orgId: String): OrgSparks = api.get("/v1/orgs/${enc(orgId)}/sparks")
    override suspend fun giveSpark(orgId: String): SparkAssigned = api.post("/v2/mojo/sparks", SparkAssignReq(orgId))
    override suspend fun moveSpark(id: String, orgId: String): SparkAssigned = api.post("/v2/mojo/sparks/${enc(id)}/move", SparkAssignReq(orgId))
    override suspend fun removeSpark(id: String) {
        api.delete<OkRes>("/v2/mojo/sparks/${enc(id)}")
    }
    override suspend fun setBadgeHidden(hidden: Boolean) {
        api.put<BadgeReq, BadgeReq>("/v2/mojo/badge", BadgeReq(hidden))
    }
    override suspend fun redeemGift(id: String): GiftRedeemed = api.post("/v2/mojo/gifts/${enc(id)}/redeem")

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
}

/** Google Play as the repository uses it ([PlayBilling]); a fake in tests. */
interface PlayStore {
    val updates: SharedFlow<PlayUpdate>
    suspend fun offers(): Map<String, PlayOffer>
    suspend fun owned(): List<PlayPurchase>
    fun launch(activity: Activity, launch: PlayLaunch): PlayError?
    fun close()
}

/** Everything Google Play's sheet needs for one purchase, prepared with the server first. */
data class PlayLaunch(val productId: String, val accountToken: String, val reference: String, val replacing: String?)

/** What the person is buying. */
sealed interface MojoPurchase {
    val productId: String
    data class Plan(val planKey: String, override val productId: String, val replacing: String?) : MojoPurchase
    data class Sparks(val quantity: Int, override val productId: String) : MojoPurchase
    data class Gift(val planKey: String, val months: Int, val recipientUserId: String, val note: String?, override val productId: String) : MojoPurchase
}

/** The latest purchase outcome, shown once. Only [Confirmed] means something was granted, and only the server says so. */
sealed interface MojoNotice {
    data class Confirmed(val productId: String) : MojoNotice
    data object Pending : MojoNotice
    data object Cancelled : MojoNotice
    data class Failed(val error: PlayError) : MojoNotice
    /** Google took the payment but the server couldn't confirm it yet: it is retried on the next start and resume. */
    data object NotConfirmedYet : MojoNotice
    /** This Google Play purchase already belongs to another Meldiq account. */
    data object OtherAccount : MojoNotice
    data object Rejected : MojoNotice
}

data class MojoState(
    val catalog: MojoCatalog? = null,
    val entitlements: Entitlements? = null,
    /** Sparks, badge and gifts (API 0.54.0); null on an older server. */
    val me: MojoMe? = null,
    val offers: Map<String, PlayOffer> = emptyMap(),
    val loading: Boolean = false,
    /** The server has no Meldiq Mojo (an older or self-hosted server) or couldn't be reached. */
    val unavailable: Boolean = false,
    val busy: String? = null,
    val notice: MojoNotice? = null,
)

/**
 * Meldiq Mojo on Android: the catalog, this account's entitlements and Google Play's offers, and purchases from the
 * sheet to the server's confirmation. Nothing is granted on the phone: a purchase counts once the server has verified it
 * with Google and answers the new entitlements. Purchases the app missed (killed during the sheet, network down) are
 * sent again by [reconcile] at start and on resume; the server's verification is idempotent.
 */
class MojoRepository(private val backend: MojoBackend, private val play: PlayStore, private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow(MojoState())
    val state: StateFlow<MojoState> = mutable.asStateFlow()
    private val verifying = Mutex()

    init {
        scope.launch { play.updates.collect(::onUpdate) }
    }

    suspend fun refresh() {
        mutable.update { it.copy(loading = true) }
        val offers = scope.async { runCatching { play.offers() }.getOrDefault(emptyMap()) }
        val loaded = runCatching { backend.catalog() to backend.entitlements() }
        loaded.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        val me = if (loaded.isSuccess) loadMe() else null
        val o = offers.await()
        mutable.update { s ->
            loaded.fold(
                { (c, e) -> s.copy(catalog = c, entitlements = e, me = me ?: s.me, offers = o, loading = false, unavailable = false) },
                { s.copy(offers = o, loading = false, unavailable = s.catalog == null) },
            )
        }
    }

    /** The server says this account's entitlements changed (realtime `entitlements.changed`): read them again. */
    suspend fun refreshEntitlements() {
        runCatching { backend.entitlements() }.onSuccess { e -> mutable.update { it.copy(entitlements = e) } }
        loadMe()?.let { me -> mutable.update { it.copy(me = me) } }
    }

    private suspend fun loadMe(): MojoMe? = runCatching { backend.me() }.onFailure { if (it is CancellationException) throw it }.getOrNull()

    /** A server's Spark level and this member's Sparks there. */
    suspend fun orgSparks(orgId: String): Result<OrgSparks> = attempt { backend.orgSparks(orgId) }

    /** Gives one of this person's free Sparks to [orgId]; the server checks membership and that one is free. */
    suspend fun giveSpark(orgId: String): Result<Unit> = changing { backend.giveSpark(orgId) }

    suspend fun moveSpark(id: String, orgId: String): Result<Unit> = changing { backend.moveSpark(id, orgId) }

    suspend fun removeSpark(id: String): Result<Unit> = changing { backend.removeSpark(id) }

    /** Hiding the badge changes only what others see, never what the plan gives. */
    suspend fun setBadgeHidden(hidden: Boolean): Result<Unit> = changing { backend.setBadgeHidden(hidden) }

    suspend fun redeemGift(id: String): Result<Unit> = changing { backend.redeemGift(id) }

    /** Runs a change on the server, then reads what this account has again (the server's answer is the truth). */
    private suspend fun changing(block: suspend () -> Any): Result<Unit> = attempt { block() }.map { refreshEntitlements() }

    private suspend fun <T> attempt(block: suspend () -> T): Result<T> = runCatching { block() }.onFailure { if (it is CancellationException) throw it }

    /** Records what is about to be bought and answers the sheet's parameters; null (with a notice) when that failed. */
    suspend fun prepare(purchase: MojoPurchase): PlayLaunch? {
        if (state.value.busy != null) return null
        mutable.update { it.copy(busy = purchase.productId, notice = null) }
        val req = when (purchase) {
            is MojoPurchase.Plan -> PlayIntentReq("plan", purchase.productId, planKey = purchase.planKey)
            is MojoPurchase.Sparks -> PlayIntentReq("spark", purchase.productId, quantity = purchase.quantity)
            is MojoPurchase.Gift -> PlayIntentReq(
                "gift", purchase.productId, planKey = purchase.planKey, giftTo = purchase.recipientUserId, months = purchase.months,
                note = purchase.note?.trim()?.takeIf { it.isNotEmpty() },
            )
        }
        return runCatching { backend.intent(req) }.fold(
            { PlayLaunch(purchase.productId, it.accountToken, it.reference, (purchase as? MojoPurchase.Plan)?.replacing) },
            { e ->
                if (e is CancellationException) throw e
                finish(MojoNotice.Failed(if (e is ApiException && e.status in 400..499) PlayError.NOT_SET_UP else PlayError.NETWORK))
                null
            },
        )
    }

    fun launch(activity: Activity, launch: PlayLaunch) {
        play.launch(activity, launch)?.let { finish(MojoNotice.Failed(it)) }
    }

    fun clearNotice() = mutable.update { it.copy(notice = null) }

    /** Sends the server any purchase it hasn't confirmed (Google leaves those unacknowledged until it does). */
    suspend fun reconcile() {
        val waiting = runCatching { play.owned() }.getOrDefault(emptyList()).filter { !it.acknowledged && !it.pending }
        if (waiting.isEmpty()) return
        verifying.withLock { waiting.forEach { runCatching { backend.verify(PlayVerifyReq(it.productId, it.token)) } } }
        refreshEntitlements()
    }

    private suspend fun onUpdate(update: PlayUpdate) {
        when (update) {
            PlayUpdate.Cancelled -> finish(MojoNotice.Cancelled)
            is PlayUpdate.Failed -> finish(if (update.error == PlayError.ALREADY_OWNED) restoreOwned() else MojoNotice.Failed(update.error))
            is PlayUpdate.Purchased -> finish(confirm(update.purchases))
        }
    }

    /** "Already owned": the purchase exists but this account may not have it yet; verifying it restores it. */
    private suspend fun restoreOwned(): MojoNotice {
        reconcile()
        return MojoNotice.Failed(PlayError.ALREADY_OWNED)
    }

    private suspend fun confirm(purchases: List<PlayPurchase>): MojoNotice {
        if (purchases.isEmpty()) return MojoNotice.NotConfirmedYet
        if (purchases.all { it.pending }) return MojoNotice.Pending
        var notice: MojoNotice = MojoNotice.NotConfirmedYet
        var answered = false
        verifying.withLock {
            for (p in purchases.filterNot { it.pending }) {
                val res = runCatching { backend.verify(PlayVerifyReq(p.productId, p.token)) }
                res.exceptionOrNull()?.let { if (it is CancellationException) throw it }
                val r = res.getOrNull() ?: continue
                r.entitlements?.let { e ->
                    answered = true
                    mutable.update { it.copy(entitlements = e) }
                }
                notice = when (r.status) {
                    STATUS_GRANTED -> MojoNotice.Confirmed(p.productId)
                    STATUS_PENDING -> MojoNotice.Pending
                    STATUS_OTHER_ACCOUNT -> MojoNotice.OtherAccount
                    else -> MojoNotice.Rejected
                }
            }
        }
        // The verification's own answer is the newest; read them again only when it didn't include one.
        if (notice is MojoNotice.Confirmed && !answered) refreshEntitlements()
        return notice
    }

    private fun finish(notice: MojoNotice) = mutable.update { it.copy(busy = null, notice = notice) }

    fun close() = play.close()

    companion object {
        const val STATUS_GRANTED = "granted"
        const val STATUS_PENDING = "pending"
        const val STATUS_OTHER_ACCOUNT = "already_linked"
        /** The realtime frame the server sends an account's devices when what it has changes. */
        const val CHANGED_FRAME = "entitlements.changed"
    }
}
