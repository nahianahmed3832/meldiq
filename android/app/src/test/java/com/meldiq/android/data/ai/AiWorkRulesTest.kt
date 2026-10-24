package com.meldiq.android.data.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Costs, budgets and the order of a system check's report, as Meldiq Web shows them (API 0.41.0). */
class AiWorkRulesTest {
    @Test
    fun `costs keep their cents fractions when small`() {
        assertEquals("$0", AiWorkRules.cost(0))
        assertEquals("$0.0060", AiWorkRules.cost(6_000))
        assertEquals("$0.050", AiWorkRules.cost(50_000))
        assertEquals("$12.35", AiWorkRules.cost(12_345_678))
    }

    @Test
    fun `a budget in dollars becomes micro-USD and blank is none`() {
        assertEquals(25_500_000L, AiWorkRules.budgetMicro("25.5"))
        assertEquals(2_500_000L, AiWorkRules.budgetMicro("2,50"))
        assertNull(AiWorkRules.budgetMicro(" "))
        assertNull(AiWorkRules.budgetMicro("-1"))
    }

    @Test
    fun `a report groups what needs attention, what wasn't tested and what is healthy`() {
        fun i(k: String, s: String) = AiCheckItem(k, "configuration", k, s)
        val r = AiCheckReport("c", worst = "failed", startedAt = 0, items = listOf(i("a", "healthy"), i("b", "failed"), i("c", "not_tested"), i("d", "warning"), i("e", "not_configured")))
        assertEquals(listOf("b", "d", "e"), AiWorkRules.attention(r).map { it.key })
        assertEquals(listOf("c"), AiWorkRules.untested(r).map { it.key })
        assertEquals(listOf("a"), AiWorkRules.healthy(r).map { it.key })
        assertEquals("meldiq-system-check-1970-01-01T00-00-00Z.json", AiWorkRules.reportName(r))
        assertEquals(3, AiCheckCounts(warning = 3).of("warning"))
    }
}
