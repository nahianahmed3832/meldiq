package com.meldiq.android.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/** API 0.48.0 (as Meldiq Web v4): categories keep their saved order before the category list has loaded. */
class ChannelOrderTest {
    private data class Ch(val id: String, val name: String, val category: String?, val categoryName: String?, val categoryPosition: Int?)

    private fun order(items: List<Ch>) = ChannelTree.sections(
        items, emptyList(), ref = { ChannelRef(it.id, it.name, it.category, 0) }, categoryName = { it.categoryName }, categoryPosition = { it.categoryPosition },
    ).map { it.title }

    @Test
    fun `without the category list, categories follow their position, not their name`() {
        val items = listOf(
            Ch("c1", "general", "cat_b", "Alpha talk", 2),
            Ch("c2", "rules", "cat_a", "Zeta start", 0),
            Ch("c3", "lounge", "cat_c", "Middle", 1),
        )
        assertEquals(listOf("Zeta start", "Middle", "Alpha talk"), order(items))
    }

    @Test
    fun `an older server without positions still groups by name`() {
        val items = listOf(Ch("c1", "a", "cat_b", "Beta", null), Ch("c2", "b", "cat_a", "Alpha", null))
        assertEquals(listOf("Alpha", "Beta"), order(items))
    }
}
