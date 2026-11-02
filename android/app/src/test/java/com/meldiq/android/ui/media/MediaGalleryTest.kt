package com.meldiq.android.ui.media

import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.AttachmentRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Physical-device defect (2026-10-16): tapping a photo opened Android's "Open with" chooser. Photos and videos now open
 * the in-app viewer; these rules decide what the viewer shows and how saved files are named.
 */
class MediaGalleryTest {
    private fun ref(id: String, mime: String, name: String = "file", voice: Boolean? = null) = AttachmentRef(id, name, mime, 10, "k", "n", "h", voice = voice)
    private fun msg(id: String, ts: Long, vararg refs: AttachmentRef, deleted: Boolean = false, kind: String = "text") =
        MessageEntity(id, "c_1", "u_peer", "d_1", false, kind, "", sentAt = ts, sortTs = ts, status = "RECEIVED", deleted = deleted) to refs.toList()

    @Test
    fun `only photos up to 10 MB download by themselves once on screen`() {
        val photo = ref("p", "image/jpeg")
        val big = photo.copy(id = "b", size = MediaGallery.AUTO_DOWNLOAD_MAX_BYTES + 1)
        val video = ref("v", "video/mp4")
        val voice = ref("a", "audio/mp4", voice = true)
        val pdf = ref("f", "application/pdf")
        val pending = ref("pending", "image/jpeg")
        assertEquals(listOf(photo), MediaGallery.autoDownloadable(listOf(photo, big, video, voice, pdf, pending)))
        assertEquals(emptyList<AttachmentRef>(), MediaGallery.autoDownloadable(emptyList()))
    }

    @Test
    fun photosAndVideosOpenTheViewerEverythingElseStaysAFile() {
        assertEquals(MediaKind.Image, MediaGallery.kindOf(ref("a", "image/jpeg")))
        assertEquals(MediaKind.Image, MediaGallery.kindOf(ref("a", "IMAGE/PNG")))
        assertEquals(MediaKind.Video, MediaGallery.kindOf(ref("a", "video/mp4")))
        assertNull(MediaGallery.kindOf(ref("a", "image/svg+xml"))) // not a raster Android decodes safely
        assertNull(MediaGallery.kindOf(ref("a", "application/pdf")))
        assertNull(MediaGallery.kindOf(ref("a", "audio/mp4", voice = true))) // voice messages play in the bubble
        assertNull(MediaGallery.kindOf(ref("pending", "image/jpeg"))) // still uploading: nothing to view yet
    }

    @Test
    fun theViewerPagesOldestFirstAndSkipsDeletedAndUndecryptableMessages() {
        val all = listOf(
            msg("m3", 300, ref("a3", "video/mp4")),
            msg("m1", 100, ref("a1", "image/jpeg"), ref("doc", "application/pdf")),
            msg("m2", 200, ref("a2", "image/png"), deleted = true),
            msg("m4", 400, ref("a4", "image/webp"), kind = "undecryptable"),
            msg("m5", 500, ref("a5", "image/gif")),
        )
        val byId = all.associate { it.first.id to it.second }
        val items = MediaGallery.items(all.map { it.first }) { byId.getValue(it.id) }
        assertEquals(listOf("a1", "a3", "a5"), items.map { it.ref.id })
        assertEquals(listOf("m1", "m3", "m5"), items.map { it.messageId })
        assertFalse(items.any { it.ref.id == "doc" })
    }

    @Test
    fun collectionPageCanFilterPhotosVideosAndFilenamesWithoutChangingOriginalRefs() {
        val photo = ref("p", "image/jpeg", "Summer.JPG")
        val video = ref("v", "video/mp4", "Summer.mp4")
        assertTrue(MediaGallery.matches(photo, MediaKind.Image, " summer "))
        assertFalse(MediaGallery.matches(video, MediaKind.Image, "Summer"))
        assertTrue(MediaGallery.matches(video, MediaKind.Video, ".MP4"))
        assertTrue(MediaGallery.matches(photo, null, ""))
        assertFalse(MediaGallery.matches(photo, null, "winter"))
    }

    @Test
    fun savedFilesGetSafeNamesWithTheRightExtension() {
        assertEquals("holiday.jpg", MediaGallery.safeName("holiday.jpg", "image/jpeg"))
        assertEquals("holiday.jpeg", MediaGallery.safeName("holiday.jpeg", "image/jpeg"))
        assertEquals("IMG_1.png", MediaGallery.safeName("IMG_1", "image/png"))
        assertEquals("passwd.mp4", MediaGallery.safeName("../../etc/passwd", "video/mp4")) // no folders from a peer's name
        assertEquals("a_b_c.jpg", MediaGallery.safeName("a:b?c", "image/jpeg"))
        assertEquals("meldiq-photo.jpg", MediaGallery.safeName("..", "image/jpeg"))
        assertEquals("meldiq-video.mp4", MediaGallery.safeName("", "video/mp4"))
        assertTrue(MediaGallery.safeName("x".repeat(500), "image/png").length <= 124)
    }

    @Test
    fun galleryFoldersPermissionsAndSampling() {
        assertEquals("Pictures/Meldiq", MediaGallery.galleryFolder("image/jpeg"))
        assertEquals("Movies/Meldiq", MediaGallery.galleryFolder("video/mp4"))
        assertTrue(MediaGallery.needsStoragePermission(28))
        assertFalse(MediaGallery.needsStoragePermission(29))
        assertEquals(1, MediaGallery.sampleSize(1080, 1920, 2048))
        assertEquals(4, MediaGallery.sampleSize(4000, 6000, 2048)) // a 24 MP photo never decodes at full size
    }
}
