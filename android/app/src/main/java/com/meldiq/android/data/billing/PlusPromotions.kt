package com.meldiq.android.data.billing

import com.meldiq.android.data.api.ApiClient
import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable data class PlusPromotion(val id: String, val campaignId: String, val presentation: String, val heading: String, val description: String, val cta: String, val amountMinor: Int, val currency: String, val interval: String, val expiresAt: Long)
@Serializable data class RenewalNotice(val id: String, val autoRenew: Boolean, val endsAt: Long, val amountMinor: Int? = null, val currency: String? = null, val months: Int? = null, val expiresAt: Long)
@Serializable data class RenewalResponse(val notice: RenewalNotice? = null)
@Serializable data class RenewalRequest(val sessionId: String, val claim: Boolean)
@Serializable data class PromotionClaim(val promotion: PlusPromotion? = null)
@Serializable data class PromotionCurrent(val active: Boolean, val expiresAt: Long? = null)
@Serializable data class PromotionActivity(val sessionId: String, val onboardingComplete: Boolean = true, val active: Boolean = true)
@Serializable data class PromotionContext(val sessionId: String, val trigger: String = "consistent_usage", val screen: String = "home", val safe: Boolean = true)
@Serializable data class PromotionFeedback(val sessionId: String, val impressionId: String, val event: String)
@Serializable data class PromotionPreference(val optOut: Boolean)
@Serializable data class PromotionAck(val recorded: Boolean = false, val ok: Boolean = false, val optOut: Boolean = false)

/** The existing billing API owns eligibility, frequency, preference and cross-device synchronization. */
class PlusPromotions(private val api: ApiClient) {
    val sessionId: String = UUID.randomUUID().toString()
    suspend fun renewal(claim: Boolean): RenewalNotice? = api.post<RenewalRequest, RenewalResponse>("/v2/billing/reminders/renewal", RenewalRequest(sessionId, claim)).notice
    suspend fun activity() { api.post<PromotionActivity, PromotionAck>("/v2/billing/promotions/activity", PromotionActivity(sessionId)) }
    suspend fun claim(): PlusPromotion? = api.post<PromotionContext, PromotionClaim>("/v2/billing/promotions/claim", PromotionContext(sessionId)).promotion
    suspend fun current(id: String): PromotionCurrent = api.get("/v2/billing/promotions/$id")
    suspend fun feedback(id: String, event: String) { api.post<PromotionFeedback, PromotionAck>("/v2/billing/promotions/events", PromotionFeedback(sessionId, id, event)) }
    suspend fun optOut() { api.put<PromotionPreference, PromotionAck>("/v2/billing/promotions/preference", PromotionPreference(true)) }
}
