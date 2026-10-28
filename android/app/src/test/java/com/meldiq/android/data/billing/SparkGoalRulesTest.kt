package com.meldiq.android.data.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The community Spark goal (floating redesign, 2026-10-28): every threshold comes from the catalog's levels. */
class SparkGoalRulesTest {
    private fun level(n: Int, sparks: Int) = SparkLevel(level = n, sparks = sparks, emojiSlots = 50 * (n + 1), voiceKbps = 64 + 32 * n)

    /** The owner's 2026-10-28 thresholds: Level 1 at 2 active Sparks, Level 2 at 5, Level 3 at 8 (totals). */
    private val current = listOf(level(0, 0), level(1, 2), level(2, 5), level(3, 8))

    @Test
    fun noSparksIsNoLevelWithTheFirstThresholdAhead() {
        val g = SparkGoalRules.goal(current, 0)
        assertEquals(0, g.level)
        assertEquals(1, g.nextLevel)
        assertEquals(2, g.needs)
        assertEquals(0f, g.fraction, 0.001f)
    }

    @Test
    fun oneSparkIsHalfwayToLevelOne() {
        val g = SparkGoalRules.goal(current, 1)
        assertEquals(0, g.level)
        assertEquals(1, g.needs)
        assertEquals(0.5f, g.fraction, 0.001f)
    }

    @Test
    fun progressCountsFromTheLevelReached() {
        val g = SparkGoalRules.goal(current, 6)
        assertEquals(2, g.level)
        assertEquals(3, g.nextLevel)
        assertEquals(8, g.nextAt)
        assertEquals(2, g.needs)
        assertEquals(1f / 3f, g.fraction, 0.001f)
    }

    @Test
    fun exactlyOnAThresholdReachesThatLevel() {
        assertEquals(1, SparkGoalRules.goal(current, 2).level)
        assertEquals(2, SparkGoalRules.goal(current, 5).level)
        assertEquals(3, SparkGoalRules.goal(current, 8).level)
    }

    @Test
    fun theTopLevelIsFullAndNeedsNothing() {
        val g = SparkGoalRules.goal(current, 12)
        assertEquals(3, g.level)
        assertNull(g.nextLevel)
        assertEquals(0, g.needs)
        assertEquals(1f, g.fraction, 0.001f)
    }

    @Test
    fun otherThresholdsFromTheCatalogAreFollowedAsTheyAre() {
        // The earlier 1/2/3 catalog still reads correctly: nothing here is hard-coded.
        val old = listOf(level(1, 1), level(2, 2), level(3, 3))
        assertEquals(1, SparkGoalRules.goal(old, 1).level)
        assertEquals(1, SparkGoalRules.goal(old, 1).needs)
        assertEquals(3, SparkGoalRules.goal(old, 3).level)
    }

    @Test
    fun anEmptyCatalogHasNoGoal() {
        val g = SparkGoalRules.goal(emptyList(), 4)
        assertEquals(0, g.level)
        assertNull(g.nextLevel)
        assertEquals(0f, g.fraction, 0.001f)
    }

    @Test
    fun theServersOwnAnswerWins() {
        val g = SparkGoalRules.of(OrgSparks(level = 1, active = 3, next = NextLevel(level = 2, needs = 2), levels = current))
        assertEquals(1, g.level)
        assertEquals(2, g.nextLevel)
        assertEquals(5, g.nextAt)
        assertEquals(2, g.needs)
        assertEquals(1f / 3f, g.fraction, 0.001f)
        val top = SparkGoalRules.of(OrgSparks(level = 3, active = 9, next = null, levels = current))
        assertNull(top.nextLevel)
        assertEquals(1f, top.fraction, 0.001f)
    }

    @Test
    fun negativeCountsAreTreatedAsNone() {
        assertEquals(0, SparkGoalRules.goal(current, -3).active)
    }
}
