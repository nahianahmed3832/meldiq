package com.meldiq.android

import com.meldiq.android.data.account.SupabaseAuthClient
import com.meldiq.android.data.account.SupabaseSession
import com.meldiq.android.data.account.SupabaseSessionVault
import com.meldiq.android.data.account.SupabaseUser
import com.meldiq.android.data.account.SupabaseAuthException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SupabaseAuthConfigTest {
    private val vault = object : SupabaseSessionVault {
        override fun load(): SupabaseSession? = null
        override fun save(session: SupabaseSession?) = Unit
    }
    @Test fun refusesPrivilegedApiKeys() {
        assertThrows(IllegalArgumentException::class.java) {
            SupabaseAuthClient("https://staging.supabase.co", "sb_secret_never-public", vault) { null }
        }
    }
    @Test fun refusesInsecureOrCredentialBearingOrigins() {
        for (url in listOf("http://staging.supabase.co", "https://name:password@staging.supabase.co", "https://staging.supabase.co/not-an-origin")) {
            assertThrows(IllegalArgumentException::class.java) { SupabaseAuthClient(url, "sb_publishable_fixture", vault) { null } }
        }
    }
    @Test fun normalizesProviderRelativeExpiryWithoutLoggingTokens() {
        val response = """{"access_token":"synthetic_access","refresh_token":"synthetic_refresh","expires_in":3600,"user":{"id":"10000000-0000-4000-8000-000000000001"}}"""
        assertEquals(4600L, SupabaseAuthClient.decodeSession(response, nowSeconds = 1000).expiresAtSeconds)
        assertThrows(SupabaseAuthException::class.java) {SupabaseAuthClient.decodeSession(response.replace("3600", "-1"), nowSeconds = 1000)}
        assertThrows(SupabaseAuthException::class.java) {SupabaseAuthClient.decodeSession("not JSON")}
    }
    @Test fun aQueuedRefreshCannotReturnAnotherProfilesSession() = runBlocking {
        val session = SupabaseSession("synthetic_access", "synthetic_refresh", 9999999999, SupabaseUser("10000000-0000-4000-8000-000000000001"))
        val other = object : SupabaseSessionVault {
            override fun load(): SupabaseSession = session
            override fun save(session: SupabaseSession?) = Unit
        }
        val client = SupabaseAuthClient("https://staging.supabase.co", "sb_publishable_fixture", other) {"10000000-0000-4000-8000-000000000002"}
        try {client.refresh("a_different_rejected_access"); throw AssertionError("Expected owner refusal")}
        catch (_: IllegalArgumentException) { /* No network call or owner switch is permitted. */ }
    }
}
