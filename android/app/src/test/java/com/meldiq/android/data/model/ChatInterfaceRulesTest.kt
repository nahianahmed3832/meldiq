package com.meldiq.android.data.model

import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.screens.home.ActivityRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Batch B5: message links, the channel's thread list, the Unreads view and conversation routes. */
class ChatInterfaceRulesTest {
    @Test
    fun `a message link carries only the two ids and reads back from both forms`() {
        val link = MessageLinks.link("c_abc-1", "0f8e-77aa")
        assertEquals("https://web.meldiq.app/m/c_abc-1/0f8e-77aa", link)
        assertEquals(MessageLinks.Target("c_abc-1", "0f8e-77aa"), MessageLinks.parse(link))
        assertEquals(MessageLinks.Target("c1", "m1"), MessageLinks.parse("meldiq://m/c1/m1"))
        assertEquals(MessageLinks.Target("c1", "m1"), MessageLinks.parse(" https://www.meldiq.app/m/c1/m1/ "))
    }

    @Test
    fun `other links and malformed ids are not message links`() {
        for (s in listOf("https://evil.example/m/c1/m1", "https://meldiq.app/m/c1", "https://meldiq.app/m/c1/m1/x", "https://meldiq.app/m/c1/m%201", "https://meldiq.app/invite/ABCD-EFGH-JKLM", ""))
            assertNull(s, MessageLinks.parse(s))
    }

    @Test
    fun `only sent messages that still exist get a link`() {
        assertTrue(MessageLinks.canLink(deleted = false, status = MessageStatus.SENT))
        assertFalse(MessageLinks.canLink(deleted = true, status = MessageStatus.SENT))
        assertFalse(MessageLinks.canLink(deleted = false, status = MessageStatus.SENDING))
        assertFalse(MessageLinks.canLink(deleted = false, status = MessageStatus.FAILED))
    }

    @Test
    fun `a thread is named by its title, else its first line, else the fallback, and searched by name`() {
        assertEquals("Release plan", ThreadListRules.title(" Release plan ", "ignored", "A file"))
        assertEquals("first line", ThreadListRules.title(null, "\n  first line \nsecond", "A file"))
        assertEquals("A file", ThreadListRules.title("", "  ", "A file"))
        assertEquals(120, ThreadListRules.title(null, "x".repeat(300), "A file").length)
        val rows = listOf(ThreadListRules.Row("a", "Release plan", "u1", false, 3, 10), ThreadListRules.Row("b", "Lunch", "u2", true, 1, 5))
        assertEquals(listOf("a"), ThreadListRules.filter(rows, "  release ").map { it.rootId })
        assertEquals(2, ThreadListRules.filter(rows, " ").size)
    }

    private fun conv(id: String, type: String, unread: Int, orgId: String? = null, at: Long = 0, muted: Boolean = false, removed: Boolean = false, archivedAt: Long? = null) = ConversationEntity(
        id = id, type = type, orgId = orgId, scope = null, scopeId = null, scopeName = orgId?.let { "Org $it" }, kind = null, name = id, topic = null,
        archived = false, memberCount = 2, membersJson = "[]", joined = true, myRole = null, canPost = true, canManage = false,
        activeCallId = null, activeCallVideo = false, serverUpdatedAt = 1, lastMessageAt = at, unreadCount = unread, muted = muted, removed = removed, archivedAt = archivedAt,
    )

    @Test
    fun `unreads leave out muted, archived, left and hidden chats, DMs first, then each community, newest first`() {
        val convs = listOf(
            conv("dm1", "DM", 2, at = 5), conv("g1", "GROUP", 1, at = 9), conv("read", "DM", 0, at = 99),
            conv("ch1", "CHANNEL", 4, orgId = "o1", at = 3), conv("ch2", "CHANNEL", 1, orgId = "o1", at = 7),
            conv("muted", "CHANNEL", 5, orgId = "o1", muted = true), conv("gone", "DM", 1, removed = true),
            conv("arch", "DM", 1, archivedAt = 1), conv("hid", "CHANNEL", 3, orgId = "o2"),
        )
        val groups = ActivityRules.unreads(convs, hidden = setOf("hid"))
        assertEquals(listOf(null, "o1"), groups.map { it.orgId })
        assertEquals(listOf("g1", "dm1"), groups[0].conversations.map { it.id })
        assertEquals(listOf("ch2", "ch1"), groups[1].conversations.map { it.id })
        assertEquals("Org o1", groups[1].name)
    }

    @Test
    fun `the Unreads chip has its own list and All doesn't repeat it`() {
        assertFalse(ActivityRules.shows(ActivityRules.Filter.ALL, ActivityRules.Filter.UNREADS))
        assertTrue(ActivityRules.shows(ActivityRules.Filter.UNREADS, ActivityRules.Filter.UNREADS))
        assertFalse(ActivityRules.shows(ActivityRules.Filter.UNREADS, ActivityRules.Filter.MENTIONS))
        assertTrue(ActivityRules.empty(ActivityRules.Filter.UNREADS, mentions = 2, threads = 1, calls = 1, unreads = 0))
    }

    @Test
    fun `conversation routes add the thread and the message only when given`() {
        assertEquals("conversation/c1", Routes.conversation("c1"))
        assertEquals("conversation/c1?thread=r1", Routes.conversation("c1", "r1"))
        assertEquals("conversation/c1?message=m1", Routes.conversation("c1", message = "m1"))
        assertEquals("conversation/c1?thread=r1&message=m1", Routes.conversation("c1", "r1", "m1"))
    }
}
