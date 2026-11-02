package com.meldiq.android.data.model

import com.meldiq.android.data.api.GriipJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AttachmentThumbnailTest {
    @Test fun legacyReferencesAndSeparatePreviewsRoundTrip() {
        val ref = AttachmentRef("original", "photo.png", "image/png", 100, "key", "nonce", "hash")
        val legacy = GriipJson.decodeFromString(AttachmentRef.serializer(), GriipJson.encodeToString(AttachmentRef.serializer(), ref))
        assertNull(legacy.thumbnail)
        val thumb = AttachmentThumbnail("preview", "preview.webp", "image/webp", 50, "preview-key", "preview-nonce", "preview-hash")
        val decoded = GriipJson.decodeFromString(AttachmentRef.serializer(), GriipJson.encodeToString(AttachmentRef.serializer(), ref.copy(thumbnail = thumb)))
        assertEquals("preview", decoded.thumbnail?.asAttachment()?.id)
        assertEquals("original", decoded.id)
        assertNull(thumb.copy(size = 131073).asAttachment())
        assertNull(thumb.copy(mime = "image/svg+xml").asAttachment())
    }
}
