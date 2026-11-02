package com.meldiq.android

import com.meldiq.android.data.account.SupabaseAuthClient
import com.meldiq.android.data.account.SupabaseSession
import com.meldiq.android.data.account.SupabaseSessionVault
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
}
