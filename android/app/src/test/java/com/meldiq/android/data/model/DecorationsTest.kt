package com.meldiq.android.data.model

import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.UserDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DecorationsTest {
    @Test
    fun `classic frames are drawn by the app, other ids are images`() {
        assertTrue(DecorationRules.isClassic("aurora"))
        assertFalse(DecorationRules.isImage("aurora"))
        assertTrue(DecorationRules.isImage("flames"))
        assertTrue(DecorationRules.isImage("c_0123456789abcdef"))
        assertFalse(DecorationRules.isImage("c_short"))
        assertFalse(DecorationRules.isImage("../etc/passwd"))
        assertFalse(DecorationRules.isImage(null))
    }

    @Test
    fun `a profile carries a worn image decoration and the Artist badge`() {
        val u = GriipJson.decodeFromString(
            UserDto.serializer(),
            """{"id":"u1","username":"ada","displayName":"Ada","profileStyle":{"decoration":"c_0123456789abcdef"},"decorationArtist":true}""",
        )
        assertEquals("c_0123456789abcdef", u.profileStyle?.decoration)
        assertTrue(u.decorationArtist)
        assertFalse(GriipJson.decodeFromString(UserDto.serializer(), """{"id":"u2","username":"bo","displayName":"Bo"}""").decorationArtist)
    }

    @Test
    fun `the catalog decodes Meldiq's own and community ones`() {
        val c = GriipJson.decodeFromString(
            DecorationCatalogDto.serializer(),
            """{"decorations":[{"id":"crown","name":"Crown","kind":"meldiq","animated":false,"imageUrl":"/v2/decorations/crown/image","creator":null},
               {"id":"c_0123456789abcdef","name":"Moon ring","kind":"community","animated":true,"imageUrl":"/v2/decorations/c_0123456789abcdef/image",
                "creator":{"userId":"u1","username":"cat","displayName":"Cat"}}],"classic":["aurora"],"templateUrl":"/v2/decorations/template"}""",
        )
        assertEquals(listOf("meldiq", "community"), c.decorations.map { it.kind })
        assertEquals("cat", c.decorations[1].creator?.username)
    }
}
