package com.meldiq.android.data.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.random.Random

/** T2.6: an interrupted download resumes from where it stopped instead of starting over. */
class ResumableDownloadTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer().apply { start() }
    private val api = ApiClient({ server.url("/").toString() }, { "token" }, { false })
    private val blob = Random(7).nextBytes(200_000)

    @After fun stop() = server.shutdown()

    @Test
    fun resumesWithARangeRequestAndAppends() = runBlocking {
        val part = tmp.root.resolve("a.part").apply { writeBytes(blob.copyOfRange(0, 80_000)) } // an earlier, cut-off attempt
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 80000-199999/200000").setBody(Buffer().write(blob.copyOfRange(80_000, blob.size))))
        api.downloadTo("/v1/attachments/a_1", part) {}
        assertEquals("bytes=80000-", server.takeRequest().getHeader("Range"))
        assertArrayEquals(blob, part.readBytes())
    }

    @Test
    fun aServerIgnoringTheRangeRestartsTheFile() = runBlocking {
        val part = tmp.root.resolve("a.part").apply { writeBytes(ByteArray(500) { 1 }) }
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(blob)))
        api.downloadTo("/v1/attachments/a_1", part) {}
        assertArrayEquals(blob, part.readBytes())
    }

    @Test
    fun aFreshDownloadSendsNoRange() = runBlocking {
        val part = tmp.root.resolve("a.part")
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(blob)))
        api.downloadTo("/v1/attachments/a_1", part) {}
        assertNull(server.takeRequest().getHeader("Range"))
        assertArrayEquals(blob, part.readBytes())
    }

    @Test
    fun anExpiredFileIsReportedAsNotFound() {
        server.enqueue(MockResponse().setResponseCode(404))
        val e = assertThrows(ApiException::class.java) { runBlocking { api.downloadTo("/v1/attachments/a_1", tmp.root.resolve("a.part")) {} } }
        assertEquals(404, e.status)
    }

    @Test fun rejectsDeclaredOversizeBeforeWriting() {
        server.enqueue(MockResponse().setBody("123456"))
        val file = tmp.root.resolve("bounded.part")
        val e = assertThrows(ApiException::class.java) { runBlocking { api.downloadToBounded("/v1/gifs/media?src=x", file, 5) } }
        assertEquals(413, e.status)
        assertEquals(false, file.exists())
    }
    @Test fun rejectsUnknownLengthStreamAndDeletesPartial() {
        server.enqueue(MockResponse().setChunkedBody("1234567890", 3))
        val file = tmp.root.resolve("bounded.part")
        val e = assertThrows(ApiException::class.java) { runBlocking { api.downloadToBounded("/v1/gifs/media?src=x", file, 5) } }
        assertEquals(413, e.status)
        assertEquals(false, file.exists())
    }
    @Test fun boundedResumeCountsPreviouslyDownloadedBytes() {
        val file = tmp.root.resolve("bounded.part").apply { writeText("123") }
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 3-5/6").setBody("456"))
        val e = assertThrows(ApiException::class.java) { runBlocking { api.downloadToBounded("/v1/gifs/media?src=x", file, 5) } }
        assertEquals(413, e.status)
        assertEquals(false, file.exists())
    }
    @Test fun refusesMismatchedRangeBeforeAppending() {
        val file = tmp.root.resolve("mismatch.part").apply { writeText("123") }
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 0-2/6").setBody("456"))
        val e = assertThrows(ApiException::class.java) { runBlocking { api.downloadToBounded("/v1/attachments/a", file, 6) } }
        assertEquals("download_range", e.code)
        assertEquals("123", file.readText())
    }
    @Test fun boundedExactLimitSucceeds() = runBlocking {
        server.enqueue(MockResponse().setChunkedBody("12345", 2))
        val file = tmp.root.resolve("bounded.part")
        api.downloadToBounded("/v1/gifs/media?src=x", file, 5)
        assertEquals("12345", file.readText())
    }
}
