package com.meldiq.android

import com.meldiq.android.data.account.ExistingMeldiqOwner
import com.meldiq.android.data.account.SupabaseDeviceMigration
import com.meldiq.android.data.account.SupabaseMigrationException
import com.meldiq.android.data.account.SupabaseSession
import com.meldiq.android.data.account.SupabaseUser
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.concurrent.TimeUnit

class SupabaseDeviceMigrationTest {
    private val authUser = "10000000-0000-4000-8000-000000000001"
    private val providerSession = "20000000-0000-4000-8000-000000000001"
    private val owner = ExistingMeldiqOwner("account_original", "user_original", "device_original")
    private val nonce = "synthetic_one_use_nonce_12345678"
    private val signature = Base64.getEncoder().encodeToString(ByteArray(64) { 1 })
    private val claims = """{"sub":"$authUser","session_id":"$providerSession","user_metadata":{"userId":"forged"}}"""
    private val token = "header.${Base64.getUrlEncoder().withoutPadding().encodeToString(claims.toByteArray())}.signature"
    private val session = SupabaseSession(token, "synthetic_refresh", 9999999999, SupabaseUser(authUser))
    private fun response(body: String, status: Int = 200) = MockResponse().setResponseCode(status).addHeader("Content-Type", "application/json").setBody(body)
    private fun challenge() = response("""{"nonce":"$nonce","expiresAt":${System.currentTimeMillis() + 120000}}""")
    private fun mapped(user: String = owner.userId) = response("""{"authUserId":"$authUser","accountId":"${owner.accountId}","userId":"$user"}""")

    @Test fun bindsOnlyTheOriginalOwnerAndSignsTheExactDeviceContext() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(challenge()); server.enqueue(response("""{"ok":true}""")); server.enqueue(mapped())
            var signed: String? = null
            val prepared = SupabaseDeviceMigration(server.url("/").toString()).prepareLegacyLink(session, owner, "synthetic_legacy_access_token", {
                signed = it; signature
            }, password = "synthetic password", totpCode = "123456")
            assertEquals("meldiq-supabase-device-v1\n$authUser\n$providerSession\n${owner.deviceId}\n$nonce", signed)
            assertEquals(owner, prepared.owner); assertEquals(providerSession, prepared.providerSessionId)
            assertFalse(prepared.toString().contains(token)); assertFalse(prepared.toString().contains("synthetic password"))
            val first = server.takeRequest(); val second = server.takeRequest(); val third = server.takeRequest()
            for (request in listOf(first, second, third)) {
                assertEquals("Bearer $token", request.getHeader("Authorization")); assertEquals("no-store", request.getHeader("Cache-Control"))
                assertNull(request.getHeader("Cookie")); assertFalse(request.path!!.contains("synthetic_legacy_access_token"))
            }
            val body = Json.parseToJsonElement(second.body.readUtf8()).jsonObject
            assertEquals("/v3/auth/legacy-link", second.path)
            assertEquals("synthetic_legacy_access_token", body["legacyAccessToken"]!!.jsonPrimitive.content)
            assertEquals("123456", body["totpCode"]!!.jsonPrimitive.content)
        }
    }

    @Test fun refusesAConflictingInternalOwnerWithoutAlteringTheSession() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(challenge()); server.enqueue(response("""{"ok":true}""")); server.enqueue(mapped("someone_else"))
            try {
                SupabaseDeviceMigration(server.url("/").toString()).prepareDevice(session, owner, { signature })
                fail("Expected ownership refusal")
            } catch (e: SupabaseMigrationException) {assertEquals("identity_mismatch", e.code)}
            assertEquals(token, session.accessToken); assertEquals("synthetic_refresh", session.refreshToken)
        }
    }

    @Test fun laterBindingDoesNotResendLegacyCredentials() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(challenge()); server.enqueue(response("""{"ok":true}""")); server.enqueue(mapped())
            SupabaseDeviceMigration(server.url("/").toString()).prepareDevice(session, owner, { signature })
            server.takeRequest(); val binding = server.takeRequest()
            assertEquals("/v3/auth/device", binding.path)
            val body = Json.parseToJsonElement(binding.body.readUtf8()).jsonObject
            assertFalse(body.containsKey("legacyAccessToken")); assertFalse(body.containsKey("password"))
        }
    }

    @Test fun refusesCredentialRedirects() = runBlocking {
        MockWebServer().use { server -> MockWebServer().use { destination ->
            server.start(); destination.start(); server.enqueue(challenge())
            server.enqueue(response("{}", 307).addHeader("Location", destination.url("/steal")))
            try {
                SupabaseDeviceMigration(server.url("/").toString()).prepareLegacyLink(session, owner, "synthetic_legacy_access_token", { signature })
                fail("Expected redirect refusal")
            } catch (e: SupabaseMigrationException) {assertEquals(307, e.status)}
            assertNull(destination.takeRequest(250, TimeUnit.MILLISECONDS))
        } }
    }

    @Test fun refusesInsecureOrCredentialBearingOrigins() {
        for (url in listOf("http://api.example.test", "https://user:password@api.example.test", "https://api.example.test/path", "https://api.example.test/?redirect=evil")) {
            assertThrows(SupabaseMigrationException::class.java) {SupabaseDeviceMigration(url)}
        }
    }

    @Test fun untrustedErrorsDoNotExposeCredentialsOrArbitraryServerCodes() = runBlocking {
        MockWebServer().use { server ->
            server.start(); server.enqueue(response("""{"error":{"code":"secret_password","message":"$token synthetic password"}}""", 401))
            try {
                SupabaseDeviceMigration(server.url("/").toString()).prepareDevice(session, owner, { signature })
                fail("Expected authentication refusal")
            } catch (e: SupabaseMigrationException) {
                assertEquals(401, e.status); assertEquals("migration_request_failed", e.code)
                assertFalse(e.toString().contains(token)); assertFalse(e.toString().contains("synthetic password"))
            }
        }
    }
}
