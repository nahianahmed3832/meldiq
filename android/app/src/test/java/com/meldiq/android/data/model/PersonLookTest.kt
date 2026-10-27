package com.meldiq.android.data.model

import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.UserDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PersonLookTest {
    @Test
    fun `a member list entry's look round-trips through the users table`() {
        val u = GriipJson.decodeFromString(
            UserDto.serializer(),
            """{"id":"u1","username":"ada","displayName":"Ada","avatarMedia":{"kind":"gif","rev":3},
               "profileStyle":{"decoration":"aurora","effect":null,"accent":"#22d3ee","nameFont":"pixel","nameColors":["#22d3ee","#3b82f6"],"nameEffect":"glow","tagOrgId":"o1"},
               "tag":{"orgId":"o1","text":"MC","color":"#8b5cf6"}}""",
        )
        val look = PersonLook(u.avatarMedia, u.profileStyle, u.tag)
        val back = PersonLooks.of(PersonLooks.encode(look))
        assertEquals(look, back)
        assertEquals("aurora", back?.style?.decoration)
        assertEquals("MC", back?.tag?.text)
    }

    @Test
    fun `no look is stored as nothing`() {
        assertNull(PersonLooks.encode(PersonLook()))
        assertNull(PersonLooks.of(null))
        assertNull(PersonLooks.of("not json"))
    }

    @Test
    fun `only valid colours paint a name, at most three`() {
        val style = ProfileStyleDto(nameColors = listOf("#ff0000", "red", "#00ff00", "#0000ff", "#ffffff"))
        assertEquals(listOf(0xFFFF0000L, 0xFF00FF00L, 0xFF0000FFL), LookRules.nameColors(style))
    }
}
