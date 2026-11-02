package com.meldiq.android.data.account

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Base64
import java.util.concurrent.TimeUnit

data class ExistingMeldiqOwner(val accountId: String, val userId: String, val deviceId: String)
data class PreparedSupabaseBinding(val owner: ExistingMeldiqOwner, val authUserId: String, val providerSessionId: String)
class SupabaseMigrationException(val status: Int = 0, val code: String = "migration_failed") : Exception("Account migration could not be completed")

/** Opt-in preparation only. Never modifies active auth, the Keystore vault, device keys or offline queues. */
class SupabaseDeviceMigration(apiOrigin: String) {
    private val origin = runCatching { apiOrigin.toHttpUrl() }.getOrElse { throw SupabaseMigrationException(code = "invalid_api_origin") }
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(20, TimeUnit.SECONDS).build()

    init {
        val loopback = origin.host in setOf("localhost", "127.0.0.1", "::1")
        if ((!origin.isHttps && !loopback) || origin.username.isNotEmpty() || origin.password.isNotEmpty() || origin.encodedPath != "/" || origin.query != null || origin.fragment != null) throw SupabaseMigrationException(code = "invalid_api_origin")
    }

    suspend fun prepareLegacyLink(
        session: SupabaseSession, owner: ExistingMeldiqOwner, legacyAccessToken: String,
        signDeviceProof: suspend (String) -> String, password: String? = null, totpCode: String? = null,
    ): PreparedSupabaseBinding {
        if (legacyAccessToken.length !in 20..200) throw SupabaseMigrationException(code = "invalid_legacy_session")
        return prepare(session, owner, signDeviceProof, legacyAccessToken, password, totpCode)
    }

    suspend fun prepareDevice(
        session: SupabaseSession, owner: ExistingMeldiqOwner, signDeviceProof: suspend (String) -> String, totpCode: String? = null,
    ): PreparedSupabaseBinding = prepare(session, owner, signDeviceProof, null, null, totpCode)

    private suspend fun prepare(
        session: SupabaseSession, owner: ExistingMeldiqOwner, signer: suspend (String) -> String,
        legacyAccessToken: String?, password: String?, totpCode: String?,
    ): PreparedSupabaseBinding {
        if (!listOf(owner.accountId, owner.userId, owner.deviceId).all { ID.matches(it) }) throw SupabaseMigrationException(code = "invalid_existing_owner")
        val providerSessionId = providerSessionId(session)
        val challenge = request("POST", "v1/auth/challenge", session.accessToken)
        val nonce = challenge["nonce"]?.jsonPrimitive?.contentOrNull
        val expiresAt = challenge["expiresAt"]?.jsonPrimitive?.longOrNull
        if (nonce == null || !NONCE.matches(nonce) || expiresAt == null || expiresAt <= System.currentTimeMillis()) throw SupabaseMigrationException(code = "invalid_device_challenge")
        val signature = signer(proofMessage(session.user.id, providerSessionId, owner.deviceId, nonce))
        if (!SIGNATURE.matches(signature)) throw SupabaseMigrationException(code = "invalid_device_signature")
        val body = buildJsonObject {
            put("deviceId", owner.deviceId); put("nonce", nonce); put("signature", signature)
            if (totpCode != null) put("totpCode", totpCode)
            if (legacyAccessToken != null) put("legacyAccessToken", legacyAccessToken)
            if (password != null) put("password", password)
        }.toString()
        val bound = request("POST", if (legacyAccessToken == null) "v3/auth/device" else "v3/auth/legacy-link", session.accessToken, body)
        if (bound["ok"]?.toString() != "true") throw SupabaseMigrationException(code = "invalid_server_response")
        val mapped = request("GET", "v3/auth/me", session.accessToken)
        if (mapped["authUserId"]?.jsonPrimitive?.contentOrNull != session.user.id || mapped["accountId"]?.jsonPrimitive?.contentOrNull != owner.accountId || mapped["userId"]?.jsonPrimitive?.contentOrNull != owner.userId) throw SupabaseMigrationException(code = "identity_mismatch")
        // The caller must fence the current SDK session before activating this receipt.
        return PreparedSupabaseBinding(owner, session.user.id, providerSessionId)
    }

    private fun providerSessionId(session: SupabaseSession): String = try {
        if (!UUID.matches(session.user.id) || session.accessToken.length > 16384) throw SupabaseMigrationException(code = "invalid_provider_session")
        val parts = session.accessToken.split('.')
        if (parts.size != 3) throw SupabaseMigrationException(code = "invalid_provider_session")
        val claims = json.parseToJsonElement(String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)).jsonObject
        val id = claims["session_id"]?.jsonPrimitive?.contentOrNull
        if (claims["sub"]?.jsonPrimitive?.contentOrNull != session.user.id || id == null || !UUID.matches(id)) throw SupabaseMigrationException(code = "invalid_provider_session")
        // Parsed values provide signature context only; the API verifies signature, ownership and live provider state.
        id
    } catch (_: Exception) { throw SupabaseMigrationException(code = "invalid_provider_session") }

    private suspend fun request(method: String, path: String, accessToken: String, body: String? = null): JsonObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(origin.newBuilder().addPathSegments(path).build())
            .header("Authorization", "Bearer $accessToken").header("Cache-Control", "no-store")
            .method(method, if (method == "GET") null else (body ?: "{}").toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).execute().use { response ->
            val source = response.body?.source() ?: throw SupabaseMigrationException(response.code)
            if (source.request(128 * 1024L + 1)) throw SupabaseMigrationException(502)
            val value = runCatching { json.parseToJsonElement(source.readUtf8()).jsonObject }.getOrElse { throw SupabaseMigrationException(response.code, "invalid_server_response") }
            if (!response.isSuccessful) {
                val code = runCatching { value["error"]?.jsonObject?.get("code")?.jsonPrimitive?.contentOrNull }.getOrNull()
                throw SupabaseMigrationException(response.code, code?.takeIf { it in FAILURE_CODES } ?: "migration_request_failed")
            }
            value
        }
    }

    companion object {
        private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        private val ID = Regex("[A-Za-z0-9_-]{1,64}")
        private val NONCE = Regex("[A-Za-z0-9_-]{16,128}")
        private val SIGNATURE = Regex("[A-Za-z0-9+/]{86}==")
        private val FAILURE_CODES = setOf("unauthorized", "invalid_credentials", "fresh_auth_required", "totp_required", "totp_invalid", "totp_locked", "invalid_code", "invalid_proof", "device_revoked", "account_disabled", "session_expired", "session_revoked", "conflict", "rate_limited", "bad_request", "unavailable", "internal", "device_required")
        fun proofMessage(authUserId: String, sessionId: String, deviceId: String, nonce: String): String =
            "meldiq-supabase-device-v1\n$authUserId\n$sessionId\n$deviceId\n$nonce"
    }
}
