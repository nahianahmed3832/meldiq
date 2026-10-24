package com.meldiq.android.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String, override val message: String, val details: JsonElement? = null) : Exception(message) {
    val isNetwork get() = status == 0
}

val GriipJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}

/** GriipJson that writes nulls, for the [SendNulls] request models. */
private val GriipJsonWithNulls = Json(GriipJson) { explicitNulls = true }

/** A request body as JSON: GriipJson leaves nulls out, except in a [SendNulls] model, where a null clears a value. */
fun <B> encodeBody(ser: KSerializer<B>, body: B): String =
    (if (ser.descriptor.annotations.any { it is SendNulls }) GriipJsonWithNulls else GriipJson).encodeToString(ser, body)

/**
 * REST client. Bearer session token; on 401 it re-authenticates once by signing a fresh server
 * challenge with the device key (never by username/password) and retries.
 */
class ApiClient(
    private val baseUrl: () -> String,
    private val token: () -> String?,
    private val reauth: suspend () -> Boolean,
) {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val json = GriipJson

    /** The server this client talks to right now (a profile's address can change while signing up). */
    fun serverAddress(): String = baseUrl().trimEnd('/')
    private val reauthLock = Mutex()
    private val jsonType = "application/json".toMediaType()

    suspend inline fun <reified T> get(path: String): T = request("GET", path, null, serializer<T>())
    suspend inline fun <reified B, reified T> post(path: String, body: B): T = request("POST", path, encodeBody(serializer<B>(), body), serializer<T>())
    suspend inline fun <reified T> post(path: String): T = request("POST", path, "{}", serializer<T>())
    suspend inline fun <reified B, reified T> put(path: String, body: B): T = request("PUT", path, encodeBody(serializer<B>(), body), serializer<T>())
    suspend inline fun <reified B, reified T> patch(path: String, body: B): T = request("PATCH", path, encodeBody(serializer<B>(), body), serializer<T>())
    suspend inline fun <reified T> delete(path: String): T = request("DELETE", path, null, serializer<T>())
    suspend inline fun <reified B, reified T> delete(path: String, body: B): T = request("DELETE", path, encodeBody(serializer<B>(), body), serializer<T>())

    /** A GET with extra request headers (e.g. what this app supports, `x-meldiq-ai-reader`). */
    suspend inline fun <reified T> get(path: String, headers: Map<String, String>): T = request("GET", path, null, serializer<T>(), headers = headers)

    suspend fun <T> request(method: String, path: String, body: String?, de: kotlinx.serialization.KSerializer<T>, auth: Boolean = true, headers: Map<String, String> = emptyMap()): T {
        val first = execute(method, path, body?.toRequestBody(jsonType), auth, headers)
        val res = if (first.first == 401 && auth && !path.startsWith("/v1/auth/")) {
            val ok = reauthLock.withLock { reauth() }
            if (ok) execute(method, path, body?.toRequestBody(jsonType), auth, headers) else first
        } else first
        return decode(res, de)
    }

    /** Sends raw bytes (a profile photo) with [method]; the reply is JSON. */
    suspend fun <T> sendBytes(method: String, path: String, bytes: ByteArray, de: kotlinx.serialization.KSerializer<T>): T {
        val body = bytes.toRequestBody("application/octet-stream".toMediaType())
        var res = execute(method, path, body, true)
        if (res.first == 401 && reauthLock.withLock { reauth() }) res = execute(method, path, body, true)
        return decode(res, de)
    }

    /** Streams an already-encrypted file to the relay with progress; nothing is held in memory (T2.6). */
    suspend fun uploadFile(path: String, file: File, onProgress: (Float) -> Unit): AttachmentUploadRes =
        uploadStream(path, file, AttachmentUploadRes.serializer(), onProgress)

    /** Streams [file] as the request body (application/octet-stream) with progress; the reply is JSON. */
    suspend fun <T> uploadStream(path: String, file: File, de: kotlinx.serialization.KSerializer<T>, onProgress: (Float) -> Unit): T {
        val total = file.length()
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = total
            override fun writeTo(sink: BufferedSink) {
                file.inputStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    var sent = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        sink.write(buf, 0, n)
                        sent += n
                        onProgress(if (total > 0) sent.toFloat() / total else 1f)
                    }
                }
            }
        }
        var res = execute("POST", path, body, true)
        if (res.first == 401 && reauthLock.withLock { reauth() }) res = execute("POST", path, body, true)
        return decode(res, de)
    }

    /**
     * Sends [length] bytes of [file] from [offset] to a presigned URL (direct uploads to the server's file store),
     * with exactly the signed [headers] and no credentials of ours. Returns the store's ETag. The URL is never logged:
     * it grants access for a few minutes. Failures are [ApiException]s: status 0 for no connection.
     */
    suspend fun putPresigned(url: String, headers: Map<String, String>, file: File, offset: Long, length: Long, onProgress: (Long) -> Unit): String? =
        withContext(Dispatchers.IO) {
            val type = (headers["content-type"] ?: "application/octet-stream").toMediaType()
            val body = object : RequestBody() {
                override fun contentType() = type
                override fun contentLength() = length
                override fun writeTo(sink: BufferedSink) {
                    java.io.RandomAccessFile(file, "r").use { raf ->
                        raf.seek(offset)
                        val buf = ByteArray(64 * 1024)
                        var left = length
                        var sent = 0L
                        while (left > 0) {
                            val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                            if (n < 0) throw IOException("file ended early")
                            sink.write(buf, 0, n)
                            left -= n
                            sent += n
                            onProgress(sent)
                        }
                    }
                }
            }
            val b = Request.Builder().url(url).put(body)
            // Content-Type and Content-Length come from the body; every other signed header is sent as it is.
            for ((k, v) in headers) if (!k.equals("content-type", true) && !k.equals("content-length", true)) b.header(k, v)
            try {
                http.newCall(b.build()).execute().use { r ->
                    if (!r.isSuccessful) {
                        val code = Regex("<Code>([^<]+)</Code>").find(r.body?.string().orEmpty())?.groupValues?.get(1) ?: "http_${r.code}"
                        throw ApiException(r.code, "store_$code", "Upload failed (${r.code})")
                    }
                    r.header("ETag")
                }
            } catch (e: IOException) {
                throw ApiException(0, "network", "Can't reach the server's file storage")
            }
        }

    /**
     * Downloads into [dest], streaming to disk and resuming from what [dest] already holds with an HTTP
     * Range request (T2.6). A server that ignores the range (200) restarts the file; 416 means [dest] is
     * already complete (or wrong; the caller's hash check decides).
     */
    suspend fun downloadTo(path: String, dest: File, onProgress: (Float) -> Unit) = withContext(Dispatchers.IO) {
        fun once(): Int {
            val have = if (dest.exists()) dest.length() else 0L
            val req = Request.Builder().url(baseUrl().trimEnd('/') + path).get().apply {
                token()?.let { header("Authorization", "Bearer $it") }
                if (have > 0) header("Range", "bytes=$have-")
            }.build()
            return try {
                http.newCall(req).execute().use { r ->
                    when {
                        r.code == 416 -> 416
                        !r.isSuccessful -> r.code
                        else -> {
                            val append = r.code == 206
                            val total = (if (append) have else 0L) + (r.body?.contentLength() ?: -1L)
                            var written = if (append) have else 0L
                            FileOutputStream(dest, append).use { out ->
                                val src = r.body!!.byteStream()
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val n = src.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    written += n
                                    if (total > 0) onProgress(written.toFloat() / total)
                                }
                            }
                            200
                        }
                    }
                }
            } catch (e: IOException) {
                0
            }
        }
        var code = once()
        if (code == 401 && reauthLock.withLock { reauth() }) code = once()
        when (code) {
            200, 416 -> Unit
            0 -> throw ApiException(0, "network", "Can't reach the server")
            404 -> throw ApiException(404, "not_found", "This file has expired or you no longer have access")
            else -> throw ApiException(code, "http_$code", "Download failed ($code)")
        }
    }

    private suspend fun execute(method: String, path: String, body: RequestBody?, auth: Boolean, headers: Map<String, String> = emptyMap()): Pair<Int, String> = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(baseUrl().trimEnd('/') + path)
        headers.forEach { (k, v) -> b.header(k, v) }
        if (auth) token()?.let { b.header("Authorization", "Bearer $it") }
        when (method) {
            "GET" -> b.get()
            "DELETE" -> if (body != null) b.delete(body) else b.delete()
            else -> b.method(method, body ?: "{}".toRequestBody(jsonType))
        }
        try {
            http.newCall(b.build()).execute().use { r -> r.code to (r.body?.string() ?: "") }
        } catch (e: IOException) {
            0 to (e.message ?: "network error")
        }
    }

    private fun <T> decode(res: Pair<Int, String>, de: kotlinx.serialization.KSerializer<T>): T {
        val (code, text) = res
        if (code == 0) throw ApiException(0, "network", "Can't reach the server. Check your connection.")
        if (code in 200..299) {
            return try {
                json.decodeFromString(de, text.ifEmpty { "{}" })
            } catch (e: Exception) {
                // Which model field didn't match (never the response body): the invite defect was a missing "slug".
                val field = Regex("Field '([A-Za-z0-9_]+)'").find(e.message.orEmpty())?.groupValues?.get(1)
                if (com.meldiq.android.BuildConfig.DEBUG) runCatching { android.util.Log.w("ApiClient", "decode failed: ${de.descriptor.serialName} ${e.javaClass.simpleName} field=${field ?: "?"}") }
                throw ApiException(code, "decode", "Unexpected server response")
            }
        }
        if (ApiErrors.routeMissing(code, text)) throw ApiException(code, ApiErrors.UNSUPPORTED, ApiErrors.UNSUPPORTED_MESSAGE)
        val err = runCatching { json.decodeFromString(ApiErrorBody.serializer(), text).error }.getOrNull()
        throw ApiException(code, err?.code ?: "http_$code", friendly(code, err?.message), err?.details)
    }

    private fun friendly(code: Int, msg: String?): String = when {
        !msg.isNullOrBlank() && code != 500 -> msg
        code == 401 -> "Your session expired. Reconnecting…"
        code == 403 -> "You don't have permission to do that."
        code == 404 -> "Not found."
        code == 429 -> "Too many requests — please wait a moment."
        code >= 500 -> "The server had a problem. Please try again."
        else -> "Request failed ($code)"
    }
}

/** Unit-tested in `ApiErrorsTest`. */
object ApiErrors {
    const val UNSUPPORTED = "unsupported"
    const val UNSUPPORTED_MESSAGE = "Your server doesn't support this yet. It needs to be updated by whoever runs it."

    /**
     * A 404 for the route itself rather than for something it looked up: the server is older than the app (Fastify's
     * own "Route GET:/v1/… not found" answer). Until 2026-10-17 this showed as a bare "Not found." (changing a profile
     * photo on a server without photo support).
     */
    fun routeMissing(status: Int, body: String): Boolean =
        status == 404 && Regex("\"message\"\\s*:\\s*\"Route [A-Z]+:/[^\"]* not found\"").containsMatchIn(body)
}
