package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Direct uploads (2026-10-17) against a mock server playing both the Meldiq API and S3: what reaches "S3" must be the
 * exact ciphertext with the signed headers and no Meldiq credentials; failures are retried part by part; servers
 * without direct uploads get the original upload.
 */
class AttachmentUploaderTest {
    private lateinit var server: MockWebServer
    private val stored = ConcurrentHashMap<String, ByteArray>()
    private val parts = ConcurrentHashMap<Int, ByteArray>()
    private val log = CopyOnWriteArrayList<String>()
    private val s3Requests = CopyOnWriteArrayList<RecordedRequest>()
    private var features = """["direct-upload"]"""
    private var partSize = 0L
    private var expireFirstPut = false
    private var dropPart = -1
    private var failComplete = false
    private var stallPut = false
    private var completed: String? = null

    private fun sha(b: ByteArray) = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(b))
    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)
    private fun presigned(path: String, extra: String) =
        """{"method":"PUT","url":"${server.url(path)}?X-Amz-Signature=abc","headers":{"content-type":"application/octet-stream",$extra},"expiresAt":${System.currentTimeMillis() + 3_600_000}}"""

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                log += "${request.method} $path"
                when {
                    path == "/v1/server-info" -> return json("""{"name":"t","version":"1","calling":false,"queueTtlSeconds":1,"attachmentMaxBytes":1,"attachmentTtlSeconds":1,"encryption":"x","features":$features}""")
                    path == "/v1/attachments/uploads" && request.method == "POST" -> {
                        val body = request.body.readUtf8()
                        val size = Regex("\"size\":(\\d+)").find(body)!!.groupValues[1].toLong()
                        val sha = Regex("\"sha256\":\"([^\"]+)\"").find(body)!!.groupValues[1]
                        return if (partSize > 0 && size > partSize) {
                            json("""{"uploadId":"a_up","mode":"multipart","expiresAt":${System.currentTimeMillis() + 3_600_000},"partSize":$partSize,"partCount":${(size + partSize - 1) / partSize}}""")
                        } else {
                            json("""{"uploadId":"a_up","mode":"single","expiresAt":${System.currentTimeMillis() + 3_600_000},"upload":${presigned("/s3/a_up", "\"x-amz-checksum-sha256\":\"$sha\",\"if-none-match\":\"*\"")}}""")
                        }
                    }
                    path == "/v1/attachments/uploads/a_up/url" -> {
                        val sha = sha(stored["expected"] ?: ByteArray(0))
                        return json("""{"upload":${presigned("/s3/a_up", "\"x-amz-checksum-sha256\":\"$sha\",\"if-none-match\":\"*\"")}}""")
                    }
                    path == "/v1/attachments/uploads/a_up/parts" && request.method == "POST" -> {
                        val list = Regex("\\{\"n\":(\\d+),\"size\":(\\d+),\"sha256\":\"([^\"]+)\"\\}").findAll(request.body.readUtf8()).map {
                            """{"n":${it.groupValues[1]},"upload":${presigned("/s3/a_up/part${it.groupValues[1]}", "\"x-amz-checksum-sha256\":\"${it.groupValues[3]}\"")}}"""
                        }
                        return json("""{"parts":[${list.joinToString(",")}]}""")
                    }
                    path == "/v1/attachments/uploads/a_up/parts" && request.method == "GET" -> {
                        val have = parts.entries.sortedBy { it.key }.joinToString(",") { (n, b) -> """{"n":$n,"etag":"\"e$n\"","size":${b.size},"sha256":"${sha(b)}"}""" }
                        return json("""{"parts":[$have]}""")
                    }
                    path == "/v1/attachments/uploads/a_up/complete" -> {
                        if (failComplete) return json("""{"error":{"code":"upload_incomplete","message":"no"}}""", 409)
                        completed = request.body.readUtf8()
                        return json("""{"id":"a_up","size":1,"expiresAt":2}""")
                    }
                    path == "/v1/attachments/uploads/a_up" && request.method == "DELETE" -> return json("""{"ok":true}""")
                    path == "/v1/attachments" && request.method == "POST" -> {
                        stored["legacy"] = request.body.readByteArray()
                        return json("""{"id":"a_legacy","size":1,"expiresAt":2}""")
                    }
                    path.startsWith("/s3/") -> {
                        s3Requests += request
                        if (stallPut) return MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                        val body = request.body.readByteArray()
                        val n = Regex("part(\\d+)").find(path)?.groupValues?.get(1)?.toInt()
                        if (expireFirstPut) {
                            expireFirstPut = false
                            return MockResponse().setResponseCode(403).setBody("<Error><Code>AccessDenied</Code></Error>")
                        }
                        if (request.getHeader("x-amz-checksum-sha256") != sha(body)) return MockResponse().setResponseCode(400).setBody("<Error><Code>BadDigest</Code></Error>")
                        if (n != null) {
                            parts[n] = body
                            return MockResponse().setHeader("ETag", "\"e$n\"")
                        }
                        stored["a_up"] = body
                        return MockResponse().setHeader("ETag", "\"whole\"")
                    }
                }
                return MockResponse().setResponseCode(404).setBody("""{"message":"Route ${request.method}:$path not found","error":"Not Found","statusCode":404}""")
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun api() = ApiClient({ server.url("/").toString().trimEnd('/') }, { "meldiq-session-token" }, { false })
    private fun uploader(api: ApiClient = api()) = AttachmentUploader(api, ServerFeatures(api))
    private fun file(bytes: ByteArray) = File.createTempFile("enc", ".bin").apply { writeBytes(bytes); deleteOnExit() }

    @Test
    fun aSingleUploadGoesStraightToTheStoreWithItsSignedHeadersAndNoMeldiqCredentials() = runBlocking {
        val bytes = ByteArray(70_000) { (it * 7).toByte() }
        var last = 0f
        val res = uploader().upload("c_1", file(bytes), sha(bytes)) { last = it }
        assertEquals("a_up", res.id)
        assertArrayEquals(bytes, stored["a_up"])
        val put = s3Requests.single()
        assertNull("the Meldiq session must never reach the store", put.getHeader("Authorization"))
        assertEquals("*", put.getHeader("If-None-Match"))
        assertEquals("application/octet-stream", put.getHeader("Content-Type"))
        assertEquals(bytes.size.toString(), put.getHeader("Content-Length"))
        assertEquals(1f, last, 0.001f)
        assertFalse(log.any { it == "POST /v1/attachments" }) // not the original upload
    }

    @Test
    fun anExpiredUploadLinkIsRenewedOnce() = runBlocking {
        val bytes = ByteArray(1000) { 3 }
        stored["expected"] = bytes
        expireFirstPut = true
        assertEquals("a_up", uploader().upload("c_1", file(bytes), sha(bytes)) {}.id)
        assertTrue(log.contains("POST /v1/attachments/uploads/a_up/url"))
        assertArrayEquals(bytes, stored["a_up"])
    }

    @Test
    fun largeFilesGoInPartsWithTheirOwnHashesAndADroppedPartIsSentAgain() = runBlocking {
        partSize = 40_000
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        server.dispatcher.let { d ->
            // Part 2's first attempt loses its connection half-way.
            server.dispatcher = object : Dispatcher() {
                var dropped = false
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (!dropped && request.requestUrl!!.encodedPath.endsWith("/part2")) {
                        dropped = true
                        return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY)
                    }
                    return d.dispatch(request)
                }
            }
        }
        assertEquals("a_up", uploader().upload("c_1", file(bytes), sha(bytes)) {}.id)
        assertEquals(setOf(1, 2, 3), parts.keys)
        assertArrayEquals(bytes, parts[1]!! + parts[2]!! + parts[3]!!)
        assertEquals(20_000, parts[3]!!.size)
        val sent = completed!!
        for (n in 1..3) assertTrue(sent.contains("\"n\":$n,\"etag\":\"\\\"e$n\\\"\",\"sha256\":\"${sha(parts[n]!!)}\""))
        assertTrue(s3Requests.none { it.getHeader("Authorization") != null })
    }

    @Test
    fun partsTheStoreAlreadyHasAreNotSentAgain() = runBlocking {
        partSize = 40_000
        val bytes = ByteArray(100_000) { (it % 13).toByte() }
        parts[1] = bytes.copyOfRange(0, 40_000) // from an earlier, interrupted attempt
        uploader().upload("c_1", file(bytes), sha(bytes)) {}
        assertTrue(s3Requests.none { it.requestUrl!!.encodedPath.endsWith("/part1") })
        assertEquals(2, s3Requests.size)
    }

    @Test
    fun aFailedUploadIsCancelledOnTheServer() = runBlocking {
        partSize = 40_000
        failComplete = true
        val bytes = ByteArray(90_000) { 1 }
        try {
            uploader().upload("c_1", file(bytes), sha(bytes)) {}
            fail("expected a failure")
        } catch (e: ApiException) {
            assertEquals("upload_incomplete", e.code)
        }
        assertTrue(log.contains("DELETE /v1/attachments/uploads/a_up"))
    }

    @Test
    fun serversWithoutDirectUploadsGetTheOriginalUpload() = runBlocking {
        features = """["profiles"]"""
        val bytes = ByteArray(5000) { 9 }
        assertEquals("a_legacy", uploader().upload("c_1", file(bytes), sha(bytes)) {}.id)
        assertArrayEquals(bytes, stored["legacy"])
        assertTrue(s3Requests.isEmpty())
        // Servers from before 2026-10-17 (no features at all) too.
        features = "null"
        stored.remove("legacy")
        assertEquals("a_legacy", uploader().upload("c_1", file(bytes), sha(bytes)) {}.id)
    }

    @Test
    fun completedMultipartCheckpointSurvivesANewUploaderWithoutSendingBytesAgain() = runBlocking {
        partSize = 40_000
        val bytes = ByteArray(90_000) { 6 }
        val directory = java.nio.file.Files.createTempDirectory("meldiq-upload-checkpoint-").toFile()
        try {
            val client = api()
            AttachmentUploader(client, ServerFeatures(client), directory).upload("c_1", file(bytes), sha(bytes)) {}
            val before = log.count { it == "POST /v1/attachments/uploads" }
            s3Requests.clear()
            val ready = AttachmentUploader(client, ServerFeatures(client), directory).upload("c_1", file(bytes), sha(bytes)) {}
            assertEquals("a_up", ready.id)
            assertTrue(s3Requests.isEmpty())
            assertEquals(before, log.count { it == "POST /v1/attachments/uploads" })
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun cancellingStopsTheRequestAndAbandonsTheDirectSession() = runBlocking {
        partSize = 40_000
        stallPut = true
        val bytes = ByteArray(90_000) { 4 }
        val transfer = launch { uploader().upload("c_1", file(bytes), sha(bytes)) {} }
        withTimeout(5_000) { while (s3Requests.isEmpty()) delay(10) }
        transfer.cancelAndJoin()
        assertTrue(log.contains("DELETE /v1/attachments/uploads/a_up"))
    }

    @Test
    fun partHashesAreComputedOverExactlyTheirBytes() {
        val bytes = ByteArray(10_000) { (it % 97).toByte() }
        val f = file(bytes)
        assertEquals(sha(bytes.copyOfRange(4000, 7000)), AttachmentUploader.sha256Of(f, 4000, 3000))
        assertEquals(sha(bytes), AttachmentUploader.sha256Of(f, 0, bytes.size.toLong()))
    }
}
