package com.meldiq.android.data.billing

/**
 * A community's Spark goal (the floating redesign, 2026-10-28, like a server boost bar): its level, its active Sparks and
 * how far the next level is. Every threshold comes from the server's catalog (`GET /v2/mojo/catalog` ›
 * `spark.levels[].sparks`, 2/5/8 total since 2026-10-28); nothing here assumes a number.
 */
object SparkGoalRules {
    data class Goal(
        val level: Int,
        val active: Int,
        /** The next level and the Sparks it needs in total; null at the top level. */
        val nextLevel: Int?,
        val nextAt: Int?,
        /** Sparks still needed for [nextLevel] (0 at the top). */
        val needs: Int,
        /** Active Sparks over the next level's total, 0..1 (1 at the top): "2/5" fills 40% (the owner, 2026-10-29). */
        val fraction: Float,
    )

    fun goal(levels: List<SparkLevel>, active: Int): Goal {
        val sparks = active.coerceAtLeast(0)
        val ladder = levels.filter { it.level > 0 }.sortedBy { it.sparks }
        val reached = ladder.lastOrNull { it.sparks <= sparks }
        val next = ladder.firstOrNull { it.sparks > sparks }
        val level = reached?.level ?: 0
        if (next == null) return Goal(level, sparks, null, null, 0, if (ladder.isEmpty()) 0f else 1f)
        return Goal(level, sparks, next.level, next.sparks, next.sparks - sparks, share(sparks, next.sparks))
    }

    /** The goal from the server's own answer for one community: its level and next step win over a local count. */
    fun of(org: OrgSparks): Goal {
        val local = goal(org.levels, org.active)
        val next = org.next
        if (next == null) return local.copy(level = org.level, nextLevel = null, nextAt = null, needs = 0, fraction = 1f)
        val nextAt = org.active + next.needs
        return Goal(org.level, org.active, next.level, nextAt, next.needs, share(org.active, nextAt))
    }

    private fun share(active: Int, total: Int): Float = (active.toFloat() / total.coerceAtLeast(1)).coerceIn(0f, 1f)
}
