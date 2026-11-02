package com.meldiq.android.data.account

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** Staged Supabase session transport. Messaging device proof and the existing account UI stay separate. */
@Serializable
data class SupabaseSession(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_at") val expiresAtSeconds: Long,
    val user: SupabaseUser,
) {
    override fun toString(): String = "SupabaseSession(user=${user.id}, expiresAt=$expiresAtSeconds, tokens=[REDACTED])"
}

@Serializable
data class SupabaseUser(val id: String)

interface SupabaseSessionVault {
    fun load(): SupabaseSession?
    fun save(session: SupabaseSession?)
}

class SupabaseAuthException(val status: Int) : Exception("Account authentication could not be completed")

class SupabaseAuthClient(
    projectUrl: String,
    private val publishableKey: String,
    private val vault: SupabaseSessionVault,
    private val expectedAuthUserId: () -> String?,
) {
    private val origin = projectUrl.toHttpUrl()
    private val renewal = Mutex()
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS).build()

    init {
        require(origin.isHttps && origin.encodedPath == "/" && origin.query == null && origin.fragment == null)
        require(origin.username.isEmpty() && origin.password.isEmpty() && origin.host.endsWith(".supabase.co"))
        require(publishableKey.matches(Regex("sb_publishable_[A-Za-z0-9_-]+")))
    }

    suspend fun signIn(email: String, password: String): SupabaseSession = renewal.withLock {
        val body = buildJsonObject { put("email", email); put("password", password) }.toString()
        val session = token("password", body)
        acceptOwner(session)
        vault.save(session)
        session
    }

    /** A request queued behind a successful renewal reuses its new access token. */
    suspend fun refresh(rejectedAccessToken: String): SupabaseSession = renewal.withLock {
        val current = vault.load() ?: throw SupabaseAuthException(401)
        if (current.accessToken != rejectedAccessToken) {
            acceptOwner(current)
            return@withLock current
        }
        val body = buildJsonObject { put("refresh_token", current.refreshToken) }.toString()
        val session = token("refresh_token", body)
        acceptOwner(session)
        vault.save(session)
        session
    }

    /** Remote revocation must succeed before claiming server logout. Keys and offline work are preserved. */
    suspend fun signOut(): Unit = renewal.withLock {
        val current = vault.load() ?: return@withLock
        withContext(Dispatchers.IO) {
            val endpoint = origin.newBuilder().addPathSegments("auth/v1/logout").addQueryParameter("scope", "local").build()
            val request = Request.Builder().url(endpoint).header("apikey", publishableKey)
                .header("Authorization", "Bearer ${current.accessToken}")
                .post("{}".toRequestBody("application/json".toMediaType())).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw SupabaseAuthException(response.code)
            }
        }
        vault.save(null)
    }

    private fun acceptOwner(session: SupabaseSession) {
        val expected = expectedAuthUserId()
        require(expected == null || expected == session.user.id) { "Another account owns this device profile" }
        require(session.user.id.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")))
        require(session.expiresAtSeconds > 0 && session.expiresAtSeconds <= Long.MAX_VALUE / 1000)
        require(session.accessToken.isNotBlank() && session.refreshToken.isNotBlank())
    }

    private suspend fun token(grant: String, body: String): SupabaseSession = withContext(Dispatchers.IO) {
        val endpoint = origin.newBuilder().addPathSegments("auth/v1/token").addQueryParameter("grant_type", grant).build()
        val request = Request.Builder().url(endpoint).header("apikey", publishableKey)
            .post(body.toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw SupabaseAuthException(response.code)
            val source = response.body?.source() ?: throw SupabaseAuthException(502)
            if (source.request(128 * 1024L + 1)) throw SupabaseAuthException(502)
            val value = source.readUtf8()
            decodeSession(value)
        }
    }

    companion object {
        /** GoTrue can return expires_in without the SDK-computed expires_at. Persist a normalized absolute expiry. */
        internal fun decodeSession(value: String, nowSeconds: Long = System.currentTimeMillis() / 1000): SupabaseSession = try {
            val data = Json.parseToJsonElement(value).jsonObject
            fun text(name: String): String = data[name]?.jsonPrimitive?.takeIf { it.isString }?.content ?: throw SupabaseAuthException(502)
            val expiresAt = data["expires_at"]?.jsonPrimitive?.longOrNull ?: run {
                val remaining = data["expires_in"]?.jsonPrimitive?.longOrNull ?: throw SupabaseAuthException(502)
                if (remaining <= 0) throw SupabaseAuthException(502)
                Math.addExact(nowSeconds, remaining)
            }
            if (expiresAt <= 0 || expiresAt > Long.MAX_VALUE / 1000) throw SupabaseAuthException(502)
            val user = data["user"]?.jsonObject?.get("id")?.jsonPrimitive?.takeIf { it.isString }?.content ?: throw SupabaseAuthException(502)
            SupabaseSession(text("access_token"), text("refresh_token"), expiresAt, SupabaseUser(user))
        } catch (_: Exception) { throw SupabaseAuthException(502) }
    }
}
