package com.meldiq.android.data.billing

import java.text.BreakIterator

/**
 * Meldiq Mojo's rules as the app applies them (docs/MOJO_ANDROID.md). They only shape what the app shows and offers:
 * the server enforces every limit again and decides every entitlement. Unit-tested in `MojoPlansTest`.
 */
object MojoPlans {
    const val FREE = "free"
    const val GO = "go"
    const val PLUS = "plus"
    private val RANK = mapOf(FREE to 0, GO to 1, PLUS to 2)
    fun rank(key: String?): Int = RANK[key ?: FREE] ?: 0

    const val STANDING_NONE = "none"
    const val STANDING_ENTITLED = "entitled"
    const val STANDING_GRACE = "grace"

    const val PROVIDER_PLAY = "google_play"

    /** The plan that applies now (Free when nothing does). */
    fun currentKey(e: Entitlements?): String {
        val p = e?.personal ?: return FREE
        val applies = p.standing == STANDING_ENTITLED || p.standing == STANDING_GRACE
        return if (applies) p.plan?.key ?: FREE else FREE
    }

    /** Who bills the current plan, when a subscription does (a trial or a gift has none). */
    fun billedBy(e: Entitlements?): String? = e?.personal?.subscription?.provider?.takeIf { currentKey(e) != FREE }

    /** What a plan's card offers, from the plan that applies now, who bills it, and whether Google Play has the product. */
    sealed interface PlanAction {
        data object Current : PlanAction
        /** Billed on another platform (the website): manage it there; Android offers no second purchase. */
        data object ManagedElsewhere : PlanAction
        /** Google Play has no product for it (not set up, or not in this country): nothing to buy. */
        data object Unavailable : PlanAction
        /** Free, from a Play subscription: cancelling happens in Google Play. */
        data object CancelInPlay : PlanAction
        /** Free, from a trial or gift: it simply ends. */
        data object Included : PlanAction
        data class Buy(val upgrade: Boolean, val replacing: String?) : PlanAction
    }

    fun action(target: String, e: Entitlements?, offerAvailable: Boolean): PlanAction {
        val current = currentKey(e)
        val billedBy = billedBy(e)
        if (target == current) return PlanAction.Current
        if (billedBy != null && billedBy != PROVIDER_PLAY) return PlanAction.ManagedElsewhere
        if (target == FREE) return if (billedBy == PROVIDER_PLAY) PlanAction.CancelInPlay else PlanAction.Included
        if (!offerAvailable) return PlanAction.Unavailable
        val replacing = if (billedBy == PROVIDER_PLAY) PlayProducts.subscriptionFor(current) else null
        return PlanAction.Buy(upgrade = rank(target) > rank(current), replacing = replacing)
    }

    /**
     * Characters as people count them (grapheme clusters: an emoji with skin tone or a flag is one, so is a letter with
     * its accents), the same rule the server and Meldiq Web use (Intl.Segmenter).
     */
    fun characters(text: String): Int {
        if (text.isEmpty()) return 0
        val it = BreakIterator.getCharacterInstance()
        it.setText(text)
        var n = 0
        while (it.next() != BreakIterator.DONE) n++
        return n
    }

    /** How close a draft is to the plan's limit: nothing to show until 80%, then a counter; over: can't send. */
    sealed interface Counter {
        data object Hidden : Counter
        data class Near(val left: Int) : Counter
        data class Over(val by: Int) : Counter
    }

    private const val COUNTER_FROM = 0.8

    fun counter(text: String, limit: Int): Counter {
        if (limit <= 0) return Counter.Hidden
        val n = characters(text)
        return when {
            n > limit -> Counter.Over(n - limit)
            n >= limit * COUNTER_FROM -> Counter.Near(limit - n)
            else -> Counter.Hidden
        }
    }

    /** The largest file someone may share: their plan's, or the server's Spark level's when that is higher. */
    fun uploadLimit(plan: PlanPerks?, serverLevel: SparkLevel?): Long =
        maxOf(plan?.uploadBytes ?: 0L, serverLevel?.uploadBytes ?: 0L)

    /** Screen-share ceilings: the person's plan's and the server's level's together (a server never lowers a plan). */
    fun screenPresets(catalog: MojoCatalog, plan: PlanPerks?, serverLevel: SparkLevel?): List<ScreenPreset> {
        val ids = (plan?.screen.orEmpty() + serverLevel?.screen.orEmpty()).toSet()
        return catalog.screenPresets.filter { it.id in ids }
    }

    /** Sizes as the catalog defines them (decimal): "50 MB", "2 GB". */
    fun size(bytes: Long): String = when {
        bytes >= GB && bytes % GB == 0L -> "${bytes / GB} GB"
        bytes >= GB -> "%.1f GB".format(bytes.toDouble() / GB)
        else -> "${bytes / MB} MB"
    }

    const val MB = 1_000_000L
    const val GB = 1_000_000_000L

    /** A server's level with [active] Sparks (capped at the highest level). */
    fun levelWith(levels: List<SparkLevel>, active: Int): Int =
        levels.filter { it.sparks <= active.coerceAtLeast(0) }.maxOfOrNull { it.level } ?: 0

    /** Whether starting a gift of [giftPlan] now overlaps a subscription this person already pays for. */
    fun giftOverlaps(e: Entitlements?, giftPlan: String): Boolean = billedBy(e) != null && rank(currentKey(e)) >= rank(giftPlan)

    /** Who bills a person's Spark pack, and which pack: a pack bought on the website isn't changed here. */
    sealed interface PackState {
        data object None : PackState
        data class OnPlay(val productId: String?, val quantity: Int) : PackState
        data object Elsewhere : PackState
    }

    fun packState(me: MojoMe?): PackState {
        val sub = me?.sparks?.subscription ?: return PackState.None
        if (sub.status in ENDED) return PackState.None
        return if (sub.provider == null || sub.provider == PROVIDER_PLAY) PackState.OnPlay(PlayProducts.SPARK_PACKS[sub.quantity], sub.quantity) else PackState.Elsewhere
    }

    private val ENDED = setOf("canceled", "incomplete_expired")

    /** Sparks a person holds: their plan's included ones (while it applies) plus the ones they pay for separately. */
    fun sparksHeld(plan: PlanPerks?, paid: Int): Int = (plan?.sparks ?: 0) + paid.coerceAtLeast(0)
}
