package com.meldiq.android.data.billing

import kotlinx.serialization.Serializable

/**
 * Meldiq Mojo's catalog as the server publishes it (GET /v2/mojo/catalog, server billing/perks.ts). Every limit the app
 * shows comes from here; the app keeps no plan table of its own. Units are decimal (1 MB = 1,000,000 bytes).
 */
@Serializable
data class MojoCatalog(
    val version: String = "",
    val plans: List<PlanPerks> = emptyList(),
    val screenPresets: List<ScreenPreset> = emptyList(),
    val spark: SparkCatalog = SparkCatalog(),
    val gifts: GiftCatalog = GiftCatalog(),
    /** What the server sells right now (on the website); Android sells through Google Play's own catalog. */
    val onSale: OnSale = OnSale(),
) {
    fun plan(key: String?): PlanPerks? = plans.firstOrNull { it.key == (key ?: MojoPlans.FREE) }
    fun preset(id: String): ScreenPreset? = screenPresets.firstOrNull { it.id == id }
}

@Serializable
data class PlanPerks(
    val key: String,
    val name: String,
    /** The list price in US cents. Shown only to explain the plans: what Google Play charges is its own localized price. */
    val listPriceMinor: Int = 0,
    val messageChars: Int = 0,
    val uploadBytes: Long = 0,
    val screen: List<String> = emptyList(),
    val sparks: Int = 0,
    val badge: String? = null,
    /** The Meldiq Check: a membership perk, never identity verification. */
    val check: Boolean = false,
    val customItems: Int = 0,
)

@Serializable
data class ScreenPreset(val id: String, val label: String, val width: Int, val height: Int, val fps: Int)

@Serializable
data class SparkLevel(
    val level: Int,
    val sparks: Int,
    val emojiSlots: Int,
    val stickerSlots: Int = 0,
    /** The largest single file anyone may share in the server; null: each person's own plan. */
    val uploadBytes: Long? = null,
    val voiceKbps: Int,
    val screen: List<String> = emptyList(),
)

@Serializable
data class SparkCatalog(
    val listPriceMinor: Int = 0,
    val interval: String = "month",
    val maxPurchase: Int = 0,
    val levels: List<SparkLevel> = emptyList(),
) {
    /** The level [active] Sparks give, capped at the highest level (more Sparks never make a level 4). */
    fun levelFor(active: Int): SparkLevel? = levels.filter { it.sparks <= active.coerceAtLeast(0) }.maxByOrNull { it.level }
}

@Serializable
data class GiftCatalog(val months: List<Int> = emptyList(), val noteMax: Int = 0)

@Serializable
data class OnSale(val mode: String? = null, val gifts: Boolean = false)

/** GET /v2/mojo/me: the signed-in person's plan, perks, Sparks, badge and gifts. */
@Serializable
data class MojoMe(
    val plan: String = MojoPlans.FREE,
    val perks: PlanPerks? = null,
    val sparks: MySparks = MySparks(),
    val badge: BadgeView = BadgeView(),
    val gifts: MyGifts = MyGifts(),
)

@Serializable
data class MySparks(
    val included: Int = 0,
    val purchased: Int = 0,
    val total: Int = 0,
    /** Held but not given to any server. */
    val free: Int = 0,
    val assignments: List<SparkAssignment> = emptyList(),
    val subscription: SparkSubscription? = null,
)

/** A Spark given to a server. [paused]: more Sparks are given than are held now (oldest count first); it counts again when there is room. */
@Serializable
data class SparkAssignment(
    val id: String,
    val orgId: String,
    val orgName: String? = null,
    val assignedAt: Long = 0,
    val paused: Boolean = false,
    /** Still a member of that server. */
    val member: Boolean = true,
)

@Serializable
data class SparkSubscription(val quantity: Int = 0, val status: String = "", val renews: Boolean = false, val currentPeriodEnd: Long? = null)

@Serializable
data class BadgeView(val kind: String? = null, val check: Boolean = false, val hidden: Boolean = false)

@Serializable
data class MyGifts(val received: List<GiftView> = emptyList(), val sent: List<GiftView> = emptyList())

/** A gift; [person] is who gave it (received) or who it's for (sent). */
@Serializable
data class GiftView(
    val id: String,
    val planKey: String,
    val months: Int,
    /** `pending`, `paid` (ready to start), `redeemed`, `refunded`, `expired`, `failed`. */
    val status: String,
    val note: String? = null,
    val person: GiftPerson = GiftPerson(),
    val paidAt: Long? = null,
    val redeemedAt: Long? = null,
)

@Serializable
data class GiftPerson(val userId: String? = null, val name: String? = null)

/** GET /v1/orgs/:orgId/sparks: a server's level and this member's Sparks there. */
@Serializable
data class OrgSparks(
    val level: Int = 0,
    val active: Int = 0,
    val next: NextLevel? = null,
    val perks: SparkLevel? = null,
    val levels: List<SparkLevel> = emptyList(),
    val mine: List<OrgSparkMine> = emptyList(),
)

@Serializable
data class NextLevel(val level: Int, val needs: Int)

@Serializable
data class OrgSparkMine(val id: String, val assignedAt: Long = 0, val paused: Boolean = false)

@Serializable
data class SparkAssignReq(val orgId: String)

@Serializable
data class SparkAssigned(val id: String, val orgId: String, val assignedAt: Long = 0)

@Serializable
data class BadgeReq(val hidden: Boolean)

@Serializable
data class GiftRedeemed(val startsAt: Long, val endsAt: Long)

/** GET /v2/billing/entitlements: what this account has, computed on the server from verified purchases only. */
@Serializable
data class Entitlements(
    val accountId: String = "",
    val billing: BillingAvailability = BillingAvailability(),
    val personal: PersonalEntitlement = PersonalEntitlement(),
    val revision: String = "",
    val evaluatedAt: Long = 0,
)

@Serializable
data class BillingAvailability(val available: Boolean = false, val mode: String? = null)

@Serializable
data class PlanRef(val key: String, val name: String)

@Serializable
data class PersonalEntitlement(
    val plan: PlanRef? = null,
    /** `none` (free), `entitled`, `grace` (a payment is failing, the plan still applies), `grace_ended`, `not_entitled`. */
    val standing: String = MojoPlans.STANDING_NONE,
    val accessUntil: Long? = null,
    val renews: Boolean? = null,
    val subscription: SubscriptionView? = null,
    val trial: TrialView? = null,
)

@Serializable
data class SubscriptionView(
    val status: String,
    /** Who bills it: `google_play`, `stripe` (the website), `sandbox`. */
    val provider: String,
    val interval: String? = null,
    val currentPeriodEnd: Long? = null,
    val cancelAtPeriodEnd: Boolean = false,
)

/** A free period: `signup`, `invite`, `invite_bonus` or `gift`. */
@Serializable
data class TrialView(val source: String, val endsAt: Long)

/** POST /v2/mojo/play/intent: what the person is about to buy on Google Play. The server records it and answers a reference. */
@Serializable
data class PlayIntentReq(
    val kind: String,
    val productId: String,
    val planKey: String? = null,
    val quantity: Int? = null,
    val giftTo: String? = null,
    val months: Int? = null,
    val note: String? = null,
)

/**
 * [reference] goes to Google Play as the purchase's obfuscated profile id and [accountToken] as its obfuscated account
 * id (an opaque value the server derived: never an email, phone number or account id), so the server can tie the
 * purchase to this account when Google reports it.
 */
@Serializable
data class PlayIntentRes(val reference: String, val accountToken: String)

/** POST /v2/mojo/play/verify: the server checks the token with Google before anything is granted. */
@Serializable
data class PlayVerifyReq(val productId: String, val purchaseToken: String)

/** `granted`, `pending` (Google hasn't been paid yet), `already_linked` (another account owns this purchase) or `invalid`. */
@Serializable
data class PlayVerifyRes(val status: String, val entitlements: Entitlements? = null)
