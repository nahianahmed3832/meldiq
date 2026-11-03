package com.meldiq.android.data.model

import com.meldiq.android.data.model.AttachmentPolicy.Kind
import com.meldiq.android.data.model.AttachmentPolicy.Quality
import com.meldiq.android.data.model.AttachmentPolicy.Sniffed
import com.meldiq.android.data.model.AttachmentPolicy.Verdict
import com.meldiq.android.ui.screens.conversation.Album
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Batch attachments: what may be sent and how files are checked (2026-10-17, docs/ATTACHMENTS.md). */
class AttachmentPolicyTest {
    private fun bytes(vararg b: Int) = ByteArray(32).also { a -> b.forEachIndexed { i, v -> a[i] = v.toByte() } }
    private fun ascii(at: Int, s: String, base: ByteArray = ByteArray(32)) = base.also { s.forEachIndexed { i, ch -> it[at + i] = ch.code.toByte() } }

    @Test
    fun theRealTypeComesFromTheFirstBytes() {
        assertEquals(Sniffed.JPEG, AttachmentPolicy.sniff(bytes(0xFF, 0xD8, 0xFF, 0xE0)))
        assertEquals(Sniffed.PNG, AttachmentPolicy.sniff(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
        assertEquals(Sniffed.GIF, AttachmentPolicy.sniff(ascii(0, "GIF89a")))
        assertEquals(Sniffed.WEBP, AttachmentPolicy.sniff(ascii(8, "WEBP", ascii(0, "RIFF"))))
        assertEquals(Sniffed.MP4, AttachmentPolicy.sniff(ascii(8, "isom", ascii(4, "ftyp"))))
        assertEquals(Sniffed.MP4, AttachmentPolicy.sniff(ascii(8, "qt  ", ascii(4, "ftyp")))) // iPhone .mov
        assertEquals(Sniffed.HEIF, AttachmentPolicy.sniff(ascii(8, "heic", ascii(4, "ftyp"))))
        assertEquals(Sniffed.PDF, AttachmentPolicy.sniff(ascii(0, "%PDF-1.7")))
        assertEquals(Sniffed.ZIP, AttachmentPolicy.sniff(bytes(0x50, 0x4B, 0x03, 0x04)))
        assertEquals(Sniffed.EXECUTABLE, AttachmentPolicy.sniff(ascii(0, "MZ")))
        assertEquals(Sniffed.EXECUTABLE, AttachmentPolicy.sniff(bytes(0x7F, 0x45, 0x4C, 0x46)))
        assertEquals(Sniffed.EXECUTABLE, AttachmentPolicy.sniff(ascii(0, "#!/bin/sh")))
        assertNull(AttachmentPolicy.sniff(ascii(0, "hello, world")))
        assertNull(AttachmentPolicy.sniff(ByteArray(0)))
        assertNull(AttachmentPolicy.sniff(bytes(0xFF, 0xD8))) // too short to be sure
    }

    @Test
    fun aDisguisedFileIsSentAsAFileNeverAsAPhoto() {
        // A program named and typed as a photo: a plain file, typed as one, and flagged.
        assertEquals(Kind.FILE, AttachmentPolicy.kind("image/jpeg", Sniffed.EXECUTABLE))
        assertEquals("application/octet-stream", AttachmentPolicy.sendMime("image/jpeg", Kind.FILE, Sniffed.EXECUTABLE))
        assertNotNull(AttachmentPolicy.risk("holiday.jpg", "image/jpeg", Sniffed.EXECUTABLE))
        // Real photos and videos keep their kind; the type follows the bytes.
        assertEquals(Kind.PHOTO, AttachmentPolicy.kind("image/jpeg", Sniffed.JPEG))
        assertEquals("image/png", AttachmentPolicy.sendMime("image/jpeg", Kind.PHOTO, Sniffed.PNG))
        assertEquals(Kind.VIDEO, AttachmentPolicy.kind("video/quicktime", Sniffed.MP4))
        assertEquals(Kind.PHOTO, AttachmentPolicy.kind("application/octet-stream", Sniffed.HEIF))
        // A PDF called .jpg is a file; a ZIP-based document keeps its own type.
        assertEquals(Kind.FILE, AttachmentPolicy.kind("image/jpeg", Sniffed.PDF))
        assertEquals("application/pdf", AttachmentPolicy.sendMime("application/pdf", Kind.FILE, Sniffed.PDF))
        assertEquals(Kind.FILE, AttachmentPolicy.kind("video/mp4", null))
    }

    @Test
    fun filesThatRunSoftwareAreFlagged() {
        assertNotNull(AttachmentPolicy.risk("app-release.apk", "application/vnd.android.package-archive", Sniffed.ZIP))
        assertNotNull(AttachmentPolicy.risk("update", "application/vnd.android.package-archive", null))
        assertNotNull(AttachmentPolicy.risk("invoice.pdf.exe", "application/octet-stream", null)) // a hidden second extension
        assertNotNull(AttachmentPolicy.risk("SETUP.MSI", "application/octet-stream", null))
        assertNotNull(AttachmentPolicy.risk("budget.xlsm", "application/vnd.ms-excel", Sniffed.ZIP))
        assertNotNull(AttachmentPolicy.risk("notes.txt", "text/plain", Sniffed.EXECUTABLE)) // content wins over the name
        assertNull(AttachmentPolicy.risk("report.pdf", "application/pdf", Sniffed.PDF))
        assertNull(AttachmentPolicy.risk("budget.xlsx", "application/vnd.ms-excel", Sniffed.ZIP))
        assertNull(AttachmentPolicy.risk("photo.jpg", "image/jpeg", Sniffed.JPEG))
    }

    @Test
    fun namesAreSafeToShowAndSave() {
        assertEquals("report.pdf", AttachmentPolicy.safeName("/storage/emulated/0/Download/report.pdf"))
        assertEquals("file", AttachmentPolicy.safeName(null))
        assertEquals("file", AttachmentPolicy.safeName("..."))
        assertEquals("env", AttachmentPolicy.safeName(".env")) // no hidden files
        assertEquals("a_b_c.txt", AttachmentPolicy.safeName("a:b*c.txt"))
        // A right-to-left override makes "photo‮gpj.exe" look like "photoexe.jpg": the override is removed.
        assertEquals("photogpj.exe", AttachmentPolicy.safeName("photo‮gpj.exe"))
        assertEquals("ab.txt", AttachmentPolicy.safeName("a\u0000b​.txt"))
        val long = AttachmentPolicy.safeName("x".repeat(300) + ".pdf")
        assertEquals(120, long.length)
        assertTrue(long.endsWith(".pdf"))
        assertEquals("IMG_1.jpg", AttachmentPolicy.withExtension("IMG_1.HEIC", "jpg"))
        assertEquals("clip.mp4", AttachmentPolicy.withExtension("clip", "mp4"))
    }

    @Test
    fun sizeLimitsDependOnWhetherTheFileIsCompressed() {
        val mb = 1024L * 1024
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.FILE, Sniffed.PDF, 25 * mb, Quality.STANDARD))
        assertTrue(AttachmentPolicy.check(Kind.FILE, Sniffed.PDF, 25 * mb + 1, Quality.STANDARD) is Verdict.TooLarge)
        // A 300 MB video can be sent at Standard (it's compressed first), not as the original.
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, 300 * mb, Quality.STANDARD))
        assertTrue(AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, 300 * mb, Quality.ORIGINAL) is Verdict.TooLarge)
        assertTrue(AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, 2048 * mb, Quality.HD) is Verdict.TooLarge)
        // GIFs and WebM videos are never re-encoded, so the 25 MB limit applies at every quality.
        assertTrue(AttachmentPolicy.check(Kind.PHOTO, Sniffed.GIF, 30 * mb, Quality.STANDARD) is Verdict.TooLarge)
        assertTrue(AttachmentPolicy.check(Kind.VIDEO, Sniffed.WEBM, 30 * mb, Quality.STANDARD) is Verdict.TooLarge)
        assertTrue(AttachmentPolicy.check(Kind.FILE, null, 0, Quality.STANDARD) is Verdict.TooLarge)
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.FILE, null, -1, Quality.STANDARD)) // size unknown: enforced while copying
        assertFalse(AttachmentPolicy.compressible(Kind.FILE, Sniffed.PDF))
        assertFalse(AttachmentPolicy.compressible(Kind.PHOTO, Sniffed.HEIF))
    }

    @Test
    fun aCompressedVideoThatWontFitIsFlaggedBeforeCompressing() {
        // The owner's report (UI-003): a 283.8 MB, 56 s phone video against production's 25 MB limit.
        val mb = 1024L * 1024
        val size = 283L * mb + 800 * 1024
        val limit = 25 * mb
        // Original can't be sent at all; that's the server's limit, not a bug.
        assertTrue(AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.ORIGINAL, limit, 56_000) is Verdict.TooLarge)
        // 1080p is about 34 MB at 5 Mbit/s: still sendable (it's an estimate) but flagged, pointing at 720p.
        val hd = AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.HD, limit, 56_000)
        assertEquals(Verdict.MayBeTooLarge("About 34 MB after compressing, over the 25 MB limit. Compress (720p) should fit."), hd)
        assertTrue(hd.sendable)
        // 720p is about 14 MB: fine.
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.STANDARD, limit, 56_000))
        // A ten-minute video is over the limit at 720p too: a shorter video is the only suggestion.
        val long = AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, 900 * mb, Quality.STANDARD, limit, 600_000)
        assertTrue((long as Verdict.MayBeTooLarge).reason.endsWith("Try a shorter video."))
        // Length unknown: no guess, checked after compressing as before. With 1 GB allowed, nothing to flag.
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.HD, limit, null))
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.HD, 1024 * mb, 56_000))
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.VIDEO, Sniffed.MP4, size, Quality.ORIGINAL, 1024 * mb, 56_000))
        assertFalse(Verdict.TooLarge("x").sendable)
    }

    @Test
    fun largeFilesFollowTheServersLimitUpToOneDecimalGB() {
        val mb = 1024L * 1024
        val gib = 1024 * mb
        assertEquals(25 * mb, AttachmentPolicy.effectiveMax(null)) // an older server
        assertEquals(1_000_000_000L, AttachmentPolicy.effectiveMax(2048 * mb)) // never more than the app's own limit
        assertEquals(100 * mb - 16, AttachmentPolicy.effectiveMax(100 * mb))
        // Orbit 2.0 servers say the file limit itself (fileMaxBytes), which wins over their ciphertext limit.
        assertEquals(1_000_000_000L, AttachmentPolicy.effectiveMax(gib + mb, 1_073_741_824L))
        assertEquals(26_214_000L, AttachmentPolicy.effectiveMax(25 * mb, 26_214_000L))
        val oneGib = AttachmentPolicy.effectiveMax(gib + mb, gib)
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.FILE, Sniffed.ZIP, 1_000_000_000L, Quality.ORIGINAL, oneGib))
        assertEquals(Verdict.TooLarge("Over 1 GB. Files up to 1 GB can be sent."), AttachmentPolicy.check(Kind.FILE, Sniffed.ZIP, 1_000_000_001L, Quality.ORIGINAL, oneGib))
        assertEquals("1 GB", AttachmentPolicy.sizeLabel(gib))
        assertEquals("1.5 GB", AttachmentPolicy.sizeLabel(gib + gib / 2))
        // Room for the copy and its encrypted copy, plus a margin; unknown sizes need the margin only.
        assertTrue(AttachmentPolicy.spaceNeeded(gib) > 2 * gib)
        assertEquals(AttachmentPolicy.spaceNeeded(-1), AttachmentPolicy.spaceNeeded(0))
        val max = AttachmentPolicy.effectiveMax(500 * mb)
        assertEquals(Verdict.Ok, AttachmentPolicy.check(Kind.FILE, Sniffed.ZIP, 499 * mb, Quality.ORIGINAL, max))
        val tooBig = AttachmentPolicy.check(Kind.FILE, Sniffed.ZIP, 501 * mb, Quality.ORIGINAL, max)
        assertEquals(Verdict.TooLarge("Over 500 MB. Files up to 500 MB can be sent."), tooBig)
        // Estimates: originals as they are; compressed photos and videos smaller.
        assertEquals(12 * mb, AttachmentPolicy.estimate(Kind.FILE, Sniffed.PDF, 12 * mb, null, Quality.STANDARD))
        assertEquals(450_000L, AttachmentPolicy.estimate(Kind.PHOTO, Sniffed.JPEG, 6 * mb, null, Quality.STANDARD))
        assertEquals(60L * (2_000_000 + 128_000) / 8, AttachmentPolicy.estimate(Kind.VIDEO, Sniffed.MP4, 200 * mb, 60_000, Quality.STANDARD))
        assertEquals(null, AttachmentPolicy.estimate(Kind.FILE, null, -1, null, Quality.ORIGINAL))
        assertEquals("500 MB", AttachmentPolicy.sizeLabel(500 * mb))
        assertEquals("1.5 MB", AttachmentPolicy.sizeLabel(mb * 3 / 2))
        // A 25 MB limit less the encryption overhead (what a 0.4.0 server advertises) reads 25 MB, not 24 (UI-003).
        assertEquals("25 MB", AttachmentPolicy.sizeLabel(26_214_000L))
    }

    @Test
    fun animationsAreNeverFlattenedAndAvifIsRecognizedWithoutTrustingMime() {
        for (format in listOf(Sniffed.GIF, Sniffed.PNG, Sniffed.WEBP, Sniffed.HEIF, Sniffed.AVIF)) {
            assertFalse(AttachmentPolicy.compressible(Kind.PHOTO, format))
        }
        val avif = AttachmentPolicy.sniff(ascii(8, "avif", ascii(4, "ftyp")))
        assertEquals(Sniffed.AVIF, avif)
        assertEquals("image/avif", AttachmentPolicy.sendMime("application/octet-stream", Kind.PHOTO, avif))
        assertEquals(0L, AttachmentPolicy.effectiveMax(16, 0))
    }

    @Test
    fun qualitiesAreRealDifferences() {
        assertTrue(Quality.STANDARD.photoLongEdge < Quality.HD.photoLongEdge)
        assertTrue(Quality.STANDARD.videoShortSide < Quality.HD.videoShortSide)
        assertTrue(Quality.STANDARD.videoBitrate < Quality.HD.videoBitrate)
        assertEquals(0, Quality.ORIGINAL.photoLongEdge) // never resized
        assertEquals(10, AttachmentPolicy.MAX_ITEMS)
    }

    @Test
    fun previewsAndAlbumLayout() {
        assertEquals("📷 Photo", AttachmentPolicy.preview(listOf(Kind.PHOTO)))
        assertEquals("📷 3 photos", AttachmentPolicy.preview(List(3) { Kind.PHOTO }))
        assertEquals("🎬 2 videos", AttachmentPolicy.preview(List(2) { Kind.VIDEO }))
        assertEquals("📷 2 photos and 1 video", AttachmentPolicy.preview(listOf(Kind.PHOTO, Kind.VIDEO, Kind.PHOTO)))
        assertEquals("📎 4 files", AttachmentPolicy.preview(List(4) { Kind.FILE }))
        assertEquals("📎 3 attachments", AttachmentPolicy.preview(listOf(Kind.PHOTO, Kind.FILE, Kind.VIDEO)))
        assertEquals(Kind.PHOTO, AttachmentPolicy.kindOfMime("image/heic"))
        assertEquals(listOf(listOf(0, 1)), Album.rows(2))
        assertEquals(listOf(listOf(0), listOf(1, 2)), Album.rows(3))
        assertEquals(listOf(listOf(0, 1), listOf(2, 3)), Album.rows(10))
        assertEquals(6, Album.overflow(10))
        assertEquals(0, Album.overflow(4))
    }
}
