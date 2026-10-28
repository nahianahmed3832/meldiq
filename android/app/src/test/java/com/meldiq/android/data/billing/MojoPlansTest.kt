package com.meldiq.android.data.billing

import com.meldiq.android.data.billing.MojoPlans.Counter
import com.meldiq.android.data.billing.MojoPlans.PlanAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Meldiq Mojo's client rules (docs/MOJO_ANDROID.md): what each plan card offers, counting, limits and product ids. */
class MojoPlansTest {
    private fun ent(plan: String?, standing: String = "entitled", provider: String? = null) = Entitlements(
        personal = PersonalEntitlement(
            plan = plan?.let { PlanRef(it, it) },
            standing = standing,
            subscription = provider?.let { SubscriptionView(status = "active", provider = it) },
        ),
    )

    private val catalog = MojoCatalog(
        plans = listOf(
            PlanPerks("free", "Free", messageChars = 1000, uploadBytes = 50 * MojoPlans.MB, screen = listOf("720p30")),
            PlanPerks("go", "Mojo Go", 99, 2000, 200 * MojoPlans.MB, listOf("720p60", "1080p30"), sparks = 1),
            PlanPerks("plus", "Mojo Plus", 399, 5000, 2 * MojoPlans.GB, listOf("1080p60", "1440p30"), sparks = 2, check = true),
        ),
        screenPresets = listOf(
            ScreenPreset("720p30", "720p 30 fps", 1280, 720, 30),
            ScreenPreset("720p60", "720p 60 fps", 1280, 720, 60),
            ScreenPreset("1080p30", "1080p 30 fps", 1920, 1080, 30),
            ScreenPreset("1080p60", "1080p 60 fps", 1920, 1080, 60),
            ScreenPreset("1440p30", "2K 30 fps", 2560, 1440, 30),
        ),
        spark = SparkCatalog(
            99, levels = listOf(
                SparkLevel(0, 0, 50, voiceKbps = 48),
                SparkLevel(1, 1, 100, uploadBytes = 50 * MojoPlans.MB, voiceKbps = 128, screen = listOf("720p30")),
                SparkLevel(2, 2, 200, uploadBytes = 200 * MojoPlans.MB, voiceKbps = 256, screen = listOf("1080p60")),
                SparkLevel(3, 3, 500, uploadBytes = 2 * MojoPlans.GB, voiceKbps = 384, screen = listOf("1080p60", "1440p30")),
            ),
        ),
    )

    @Test
    fun `nothing applies without an entitled or grace standing`() {
        assertEquals("free", MojoPlans.currentKey(null))
        assertEquals("free", MojoPlans.currentKey(ent("plus", standing = "grace_ended")))
        assertEquals("plus", MojoPlans.currentKey(ent("plus", standing = "grace")))
    }

    @Test
    fun `free person can buy either plan only when Google Play has the product`() {
        assertEquals(PlanAction.Buy(upgrade = true, replacing = null), MojoPlans.action("plus", ent(null, "none"), offerAvailable = true))
        assertEquals(PlanAction.Unavailable, MojoPlans.action("go", ent(null, "none"), offerAvailable = false))
        assertEquals(PlanAction.Current, MojoPlans.action("free", ent(null, "none"), offerAvailable = true))
    }

    @Test
    fun `a Play subscriber changes plan by replacing their subscription and cancels in Google Play`() {
        val e = ent("go", provider = "google_play")
        assertEquals(PlanAction.Buy(upgrade = true, replacing = "mojo_go"), MojoPlans.action("plus", e, true))
        assertEquals(PlanAction.CancelInPlay, MojoPlans.action("free", e, true))
        assertEquals(PlanAction.Buy(upgrade = false, replacing = "mojo_plus"), MojoPlans.action("go", ent("plus", provider = "google_play"), true))
    }

    @Test
    fun `a plan billed on the website is never offered again on Android`() {
        val e = ent("go", provider = "stripe")
        assertEquals(PlanAction.ManagedElsewhere, MojoPlans.action("plus", e, true))
        assertEquals(PlanAction.ManagedElsewhere, MojoPlans.action("free", e, true))
    }

    @Test
    fun `a trial or gift without a subscription can be followed by a purchase`() {
        val e = ent("plus")
        assertEquals(PlanAction.Included, MojoPlans.action("free", e, true))
        assertEquals(PlanAction.Buy(upgrade = false, replacing = null), MojoPlans.action("go", e, true))
    }

    @Test
    fun `characters are counted as people see them`() {
        assertEquals(0, MojoPlans.characters(""))
        assertEquals(5, MojoPlans.characters("hello"))
        assertEquals(1, MojoPlans.characters("👍🏽"))
        assertEquals(1, MojoPlans.characters("🇧🇩"))
        assertEquals(1, MojoPlans.characters("é"))
        assertEquals(3, MojoPlans.characters("你好!"))
        // Bengali vowel signs and the anusvara join their letter: বাং is one, বাংলা two.
        assertEquals(2, MojoPlans.characters("বাংলা"))
    }

    @Test
    fun `the counter appears near the limit and blocks over it`() {
        assertEquals(Counter.Hidden, MojoPlans.counter("a".repeat(799), 1000))
        assertEquals(Counter.Near(200), MojoPlans.counter("a".repeat(800), 1000))
        assertEquals(Counter.Near(0), MojoPlans.counter("a".repeat(1000), 1000))
        assertEquals(Counter.Over(1), MojoPlans.counter("a".repeat(1001), 1000))
    }

    @Test
    fun `a server's level never lowers a person's own plan`() {
        val plus = catalog.plan("plus")
        val level1 = catalog.spark.levelFor(1)
        assertEquals(2 * MojoPlans.GB, MojoPlans.uploadLimit(plus, level1))
        assertEquals(200 * MojoPlans.MB, MojoPlans.uploadLimit(catalog.plan("free"), catalog.spark.levelFor(2)))
        assertEquals(listOf("720p30", "1080p60", "1440p30"), MojoPlans.screenPresets(catalog, catalog.plan("free"), catalog.spark.levelFor(3)).map { it.id })
        assertEquals(listOf("1080p60", "1440p30"), MojoPlans.screenPresets(catalog, plus, level1).map { it.id }.filter { it != "720p30" })
    }

    @Test
    fun `levels stop at three`() {
        assertEquals(0, catalog.spark.levelFor(0)?.level)
        assertEquals(3, catalog.spark.levelFor(3)?.level)
        assertEquals(3, catalog.spark.levelFor(12)?.level)
    }

    @Test
    fun `sizes read in decimal units`() {
        assertEquals("50 MB", MojoPlans.size(50 * MojoPlans.MB))
        assertEquals("2 GB", MojoPlans.size(2 * MojoPlans.GB))
        assertEquals("1.5 GB", MojoPlans.size(1_500_000_000))
    }

    @Test
    fun `Play product ids map both ways`() {
        assertEquals("gift_plus_12m", PlayProducts.gift("plus", 12))
        assertNull(PlayProducts.gift("plus", 2))
        assertNull(PlayProducts.gift("free", 1))
        assertEquals("go", PlayProducts.planFor("mojo_go"))
        assertEquals(3, PlayProducts.sparkQuantity("spark_3"))
        assertEquals(6, PlayProducts.ONE_TIME.size)
        assertEquals(
            "https://play.google.com/store/account/subscriptions?sku=mojo_plus&package=com.meldiq.android",
            PlayProducts.manageUrl("com.meldiq.android", "mojo_plus"),
        )
    }

    @Test
    fun `held Sparks are the plan's included ones plus the paid ones`() {
        assertEquals(0, MojoPlans.sparksHeld(catalog.plan("free"), 0))
        assertEquals(4, MojoPlans.sparksHeld(catalog.plan("plus"), 2))
    }

    @Test
    fun `taking a Spark back can lower a server's level`() {
        val levels = catalog.spark.levels
        assertEquals(3, MojoPlans.levelWith(levels, 4))
        assertEquals(3, MojoPlans.levelWith(levels, 3))
        assertEquals(2, MojoPlans.levelWith(levels, 2))
        assertEquals(0, MojoPlans.levelWith(levels, 0))
        assertEquals(0, MojoPlans.levelWith(levels, -1))
    }

    @Test
    fun `starting a gift overlaps only a paid subscription to the same or a higher plan`() {
        assertEquals(true, MojoPlans.giftOverlaps(ent("plus", provider = "google_play"), "go"))
        assertEquals(true, MojoPlans.giftOverlaps(ent("go", provider = "stripe"), "go"))
        assertEquals(false, MojoPlans.giftOverlaps(ent("go", provider = "stripe"), "plus"))
        assertEquals(false, MojoPlans.giftOverlaps(ent("plus"), "plus"))
        assertEquals(false, MojoPlans.giftOverlaps(ent(null, "none"), "go"))
    }
}
