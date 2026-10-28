package com.meldiq.android.data.billing

import android.app.Activity
import android.content.Context
import android.util.Log
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingFlowParams.ProductDetailsParams.SubscriptionProductReplacementParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/** A Google Play product as Play prices it for this person's account and country. */
data class PlayOffer(
    val productId: String,
    /** Google's localized price ("$3.99", "৳450.00"), the only price the app shows next to a buy button. */
    val price: String,
    /** ISO 8601 billing period ("P1M") for subscriptions; null for a one-time gift. */
    val period: String?,
)

/** What came back from Google Play's purchase sheet. Nothing here grants anything: the server verifies first. */
sealed interface PlayUpdate {
    data class Purchased(val purchases: List<PlayPurchase>) : PlayUpdate
    data object Cancelled : PlayUpdate
    data class Failed(val error: PlayError) : PlayUpdate
}

/** A purchase as the server needs it to verify: the product and Google's token (never logged). */
data class PlayPurchase(val productId: String, val token: String, val pending: Boolean, val acknowledged: Boolean)

enum class PlayError { UNAVAILABLE, NETWORK, ALREADY_OWNED, ITEM_UNAVAILABLE, NOT_SET_UP, OTHER }

/**
 * Google Play Billing (Billing Library 9, docs/MOJO_ANDROID.md). The library reconnects by itself
 * (`enableAutoServiceReconnection`); pending purchases are enabled so a cash or bank payment that clears later still
 * arrives. Acknowledging and consuming happen on the server after it has verified a purchase with Google, so a purchase
 * the server never confirmed is refunded by Google rather than kept.
 */
class PlayBilling(context: Context) : PlayStore {
    private val updatesFlow = MutableSharedFlow<PlayUpdate>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val updates: SharedFlow<PlayUpdate> = updatesFlow

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases -> updatesFlow.tryEmit(toUpdate(result, purchases)) }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
        .enableAutoServiceReconnection()
        .build()

    private val connecting = Mutex()
    private val details = mutableMapOf<String, ProductDetails>()

    /** Connects once (the library keeps the connection afterwards); false when Google Play isn't usable on this phone. */
    suspend fun connect(): Boolean = connecting.withLock {
        if (client.isReady) return true
        suspendCancellableCoroutine { cont ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (cont.isActive) cont.resume(result.responseCode == BillingResponseCode.OK)
                }

                override fun onBillingServiceDisconnected() {
                    if (cont.isActive) cont.resume(false)
                }
            })
        }
    }

    /** Google Play's offers for every Mojo product it has; a product missing here can't be bought (and isn't shown as buyable). */
    override suspend fun offers(): Map<String, PlayOffer> {
        if (!connect()) return emptyMap()
        val subs = query(PlayProducts.SUBSCRIPTIONS, ProductType.SUBS)
        val gifts = query(PlayProducts.ONE_TIME, ProductType.INAPP)
        synchronized(details) {
            details.clear()
            (subs + gifts).forEach { details[it.productId] = it }
        }
        return (subs + gifts).mapNotNull(::offerOf).associateBy { it.productId }
    }

    private suspend fun query(ids: List<String>, type: String): List<ProductDetails> = suspendCancellableCoroutine { cont ->
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(ids.map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build() })
            .build()
        client.queryProductDetailsAsync(params) { result, found ->
            if (result.responseCode != BillingResponseCode.OK) Log.w(TAG, "product details ($type): ${result.responseCode}")
            if (cont.isActive) cont.resume(if (result.responseCode == BillingResponseCode.OK) found.productDetailsList else emptyList())
        }
    }

    /**
     * Opens Google Play's purchase sheet. The launch's account token and reference come from the server (POST
     * /v2/mojo/play/intent) and are opaque: Google echoes them so the server can tie the purchase to this account and to
     * what was chosen. Its `replacing` is the person's current Play subscription when they change plan (Google prorates).
     */
    override fun launch(activity: Activity, launch: PlayLaunch): PlayError? {
        val (productId, accountToken, reference, replacing) = launch
        val pd = synchronized(details) { details[productId] } ?: return PlayError.ITEM_UNAVAILABLE
        val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd)
        subscriptionOffer(pd)?.let { params.setOfferToken(it.offerToken) }
        pd.oneTimePurchaseOfferDetailsList?.firstOrNull()?.offerToken?.let { params.setOfferToken(it) }
        if (replacing != null) {
            params.setSubscriptionProductReplacementParams(
                SubscriptionProductReplacementParams.newBuilder()
                    .setOldProductId(replacing)
                    // Upgrades and downgrades take effect at once; the unused time of the old plan is credited.
                    .setReplacementMode(SubscriptionProductReplacementParams.ReplacementMode.WITH_TIME_PRORATION)
                    .build(),
            )
        }
        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(params.build()))
            .setObfuscatedAccountId(accountToken)
            .setObfuscatedProfileId(reference)
            .build()
        val result = client.launchBillingFlow(activity, flow)
        return if (result.responseCode == BillingResponseCode.OK) null else errorOf(result.responseCode)
    }

    /** Everything this Google account owns for Meldiq (restoring on a new phone, and purchases the app missed). */
    override suspend fun owned(): List<PlayPurchase> {
        if (!connect()) return emptyList()
        return ownedOf(ProductType.SUBS) + ownedOf(ProductType.INAPP)
    }

    private suspend fun ownedOf(type: String): List<PlayPurchase> = suspendCancellableCoroutine { cont ->
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build()) { result, purchases ->
            val list = if (result.responseCode == BillingResponseCode.OK) purchases.flatMap(::purchasesOf) else emptyList()
            if (cont.isActive) cont.resume(list)
        }
    }

    override fun close() {
        runCatching { client.endConnection() }
    }

    private fun toUpdate(result: BillingResult, purchases: List<Purchase>?): PlayUpdate = when (result.responseCode) {
        BillingResponseCode.OK -> PlayUpdate.Purchased(purchases.orEmpty().flatMap(::purchasesOf))
        BillingResponseCode.USER_CANCELED -> PlayUpdate.Cancelled
        else -> PlayUpdate.Failed(errorOf(result.responseCode))
    }

    companion object {
        private const val TAG = "PlayBilling"
        private const val MONTHLY = "P1M"

        /** The monthly base plan's offer (Meldiq has no intro offers; if Play has several, the base plan is the price). */
        private fun subscriptionOffer(pd: ProductDetails): ProductDetails.SubscriptionOfferDetails? {
            val offers = pd.subscriptionOfferDetails ?: return null
            return offers.firstOrNull { it.basePlanId == PlayProducts.MONTHLY_BASE_PLAN && it.offerId == null }
                ?: offers.firstOrNull { it.offerId == null }
        }

        private fun offerOf(pd: ProductDetails): PlayOffer? {
            subscriptionOffer(pd)?.let { offer ->
                val phase = offer.pricingPhases.pricingPhaseList.lastOrNull() ?: return null
                return PlayOffer(pd.productId, phase.formattedPrice, phase.billingPeriod.ifBlank { MONTHLY })
            }
            val once = pd.oneTimePurchaseOfferDetailsList?.firstOrNull() ?: pd.oneTimePurchaseOfferDetails ?: return null
            return PlayOffer(pd.productId, once.formattedPrice, null)
        }

        private fun purchasesOf(p: Purchase): List<PlayPurchase> = p.products.map {
            PlayPurchase(it, p.purchaseToken, p.purchaseState == Purchase.PurchaseState.PENDING, p.isAcknowledged)
        }

        fun errorOf(code: Int): PlayError = when (code) {
            BillingResponseCode.BILLING_UNAVAILABLE, BillingResponseCode.FEATURE_NOT_SUPPORTED -> PlayError.UNAVAILABLE
            BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.NETWORK_ERROR, BillingResponseCode.SERVICE_DISCONNECTED -> PlayError.NETWORK
            BillingResponseCode.ITEM_ALREADY_OWNED -> PlayError.ALREADY_OWNED
            BillingResponseCode.ITEM_UNAVAILABLE -> PlayError.ITEM_UNAVAILABLE
            BillingResponseCode.DEVELOPER_ERROR -> PlayError.NOT_SET_UP
            else -> PlayError.OTHER
        }
    }
}
