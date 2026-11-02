package com.meldiq.android.data.billing

/**
 * The Google Play Console catalog Meldiq Mojo expects (docs/MOJO_ANDROID.md › Play Console products). These are the ids
 * the owner creates in Play Console; the server keeps the same mapping (it verifies the product of every purchase).
 * Product ids aren't secret. Prices are never here: the app shows what Google Play returns for the person's country.
 */
object PlayProducts {
    /** Auto-renewing subscriptions, each with one monthly base plan. */
    const val MOJO_GO = "mojo_go"
    const val MOJO_PLUS = "mojo_plus"
    const val MOJO_PLUS_QUARTERLY = "mojo_plus_quarterly"
    const val MOJO_PLUS_YEARLY = "mojo_plus_yearly"
    fun plusProduct(months: Int): String? = when (months) { 1 -> MOJO_PLUS; 3 -> MOJO_PLUS_QUARTERLY; 12 -> MOJO_PLUS_YEARLY; else -> null }
    fun plusMonths(productId: String): Int? = when (productId) { MOJO_PLUS -> 1; MOJO_PLUS_QUARTERLY -> 3; MOJO_PLUS_YEARLY -> 12; else -> null }
    const val MONTHLY_BASE_PLAN = "monthly"

    /**
     * Extra Sparks. Google Play can't sell one subscription in any quantity (multi-quantity subscriptions are early
     * access only, 2026-09), so each pack is its own monthly subscription at its number of Sparks × the Spark price.
     */
    val SPARK_PACKS: Map<Int, String> = linkedMapOf(1 to "spark_1", 2 to "spark_2", 3 to "spark_3", 5 to "spark_5")

    /** Gifts: one payment, never renewing, for a friend's Mojo Go or Plus. */
    val GIFT_MONTHS = listOf(1, 3, 12)

    fun gift(planKey: String, months: Int): String? =
        if (planKey == MojoPlans.PLUS && months in GIFT_MONTHS) "gift_${planKey}_${months}m" else null

    fun subscriptionFor(planKey: String): String? = when (planKey) {
        MojoPlans.GO -> MOJO_GO
        MojoPlans.PLUS -> MOJO_PLUS
        else -> null
    }

    fun planFor(productId: String): String? = when (productId) {
        MOJO_GO -> MojoPlans.GO
        MOJO_PLUS, MOJO_PLUS_QUARTERLY, MOJO_PLUS_YEARLY -> MojoPlans.PLUS
        else -> null
    }

    fun sparkQuantity(productId: String): Int? = SPARK_PACKS.entries.firstOrNull { it.value == productId }?.key

    val SUBSCRIPTIONS: List<String> = listOf(MOJO_PLUS, MOJO_PLUS_QUARTERLY, MOJO_PLUS_YEARLY) + SPARK_PACKS.values
    val ONE_TIME: List<String> = listOf(MojoPlans.PLUS).flatMap { p -> GIFT_MONTHS.mapNotNull { gift(p, it) } }

    /** Google Play's own page for managing (and cancelling) a subscription: the documented deep link. */
    fun manageUrl(packageName: String, productId: String?): String =
        if (productId == null) "https://play.google.com/store/account/subscriptions"
        else "https://play.google.com/store/account/subscriptions?sku=$productId&package=$packageName"
}
