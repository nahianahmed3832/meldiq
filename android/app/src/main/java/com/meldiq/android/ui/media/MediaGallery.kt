package com.meldiq.android.ui.media

import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.voice.VoiceNote

/** Photos and videos shown in the in-app viewer; every other attachment stays a file the person opens explicitly. */
enum class MediaKind { Image, Video }

/** One photo or video in a conversation, as the viewer pages through them. */
data class MediaItem(val messageId: String, val ref: AttachmentRef, val senderUserId: String, val outgoing: Boolean, val sentAt: Long)

/**
 * Pure rules for the media viewer and for saving (unit-tested in `MediaGalleryTest`). Physical-device defect
 * (2026-10-16): tapping a photo opened Android's "Open with" chooser (Gallery, Music, OCR apps…) instead of a viewer.
 */
object MediaGallery {
    /** Raster formats Android decodes itself; SVG and unknown image types stay files. */
    private val IMAGES = setOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/bmp", "image/avif")

    /** Photo or video by its declared type, including one still being sent (for the album grid); voice notes are neither. */
    fun visualKind(ref: AttachmentRef): MediaKind? = when {
        VoiceNote.isVoice(ref) -> null
        ref.mime.lowercase() in IMAGES -> MediaKind.Image
        ref.mime.lowercase().startsWith("video/") -> MediaKind.Video
        else -> null
    }

    /**
     * Batch B14: the shape a photo or video takes in a message, width over height: its own, but no taller than 3:4 and no
     * wider than 16:9, so a phone screenshot doesn't fill the screen and a panorama doesn't shrink to a strip (cropped).
     */
    fun previewRatio(width: Int, height: Int): Float =
        if (width <= 0 || height <= 0) 1f else (width.toFloat() / height).coerceIn(PREVIEW_TALLEST, PREVIEW_WIDEST)

    const val PREVIEW_TALLEST = 0.75f
    const val PREVIEW_WIDEST = 16f / 9f

    /** Whether received photos download on their own (Settings › Chats), given whether the network is unmetered. */
    fun autoDownloadAllowed(mode: com.meldiq.android.data.repo.AutoDownload, unmetered: Boolean): Boolean = when (mode) {
        com.meldiq.android.data.repo.AutoDownload.ALWAYS -> true
        com.meldiq.android.data.repo.AutoDownload.WIFI -> unmetered
        com.meldiq.android.data.repo.AutoDownload.NEVER -> false
    }

    /** The largest received photo that downloads by itself; bigger ones, videos and files wait for a tap. */
    const val AUTO_DOWNLOAD_MAX_BYTES = 10L * 1024 * 1024

    /** Of a received message's files, the ones that download by themselves once the message is on screen. */
    fun autoDownloadable(refs: List<AttachmentRef>): List<AttachmentRef> =
        refs.mapNotNull { ref ->
            if (kindOf(ref) == null) null
            else ref.thumbnail?.asAttachment() ?: ref.takeIf { kindOf(it) == MediaKind.Image && it.size <= AUTO_DOWNLOAD_MAX_BYTES }
        }

    fun kindOf(ref: AttachmentRef): MediaKind? = when {
        ref.id == "pending" || VoiceNote.isVoice(ref) -> null
        ref.mime.lowercase() in IMAGES -> MediaKind.Image
        ref.mime.lowercase().startsWith("video/") -> MediaKind.Video
        else -> null
    }

    /** Filters one bounded collection page; it does not claim to search the whole conversation. */
    fun matches(ref: AttachmentRef, kind: MediaKind?, filename: String): Boolean =
        (kind == null || kindOf(ref) == kind) && ref.name.contains(filename.trim(), ignoreCase = true)

    /**
     * Every photo and video in [messages] (any order in), oldest first, the order the viewer swipes through. Deleted and
     * undecryptable messages contribute nothing, so a deleted photo can't be reopened or saved from the viewer.
     */
    fun items(messages: List<MessageEntity>, attachmentsOf: (MessageEntity) -> List<AttachmentRef>): List<MediaItem> =
        messages.asSequence()
            .filter { !it.deleted && it.kind == "text" }
            .sortedWith(compareBy({ it.sortTs }, { it.id }))
            .flatMap { m -> attachmentsOf(m).filter { kindOf(it) != null }.map { MediaItem(m.id, it, m.senderUserId, m.outgoing, m.sortTs) } }
            .toList()

    /** A file name safe to hand to MediaStore or a document provider: no folders, controls or reserved characters, right extension. */
    fun safeName(name: String, mime: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
            .map { if (it.code < 32 || it in "<>:\"|?*") '_' else it }.joinToString("")
            .trim().trimStart('.').take(120)
        val ext = extensionFor(mime)
        val stem = base.ifEmpty { "meldiq-" + (if (mime.startsWith("video/")) "video" else "photo") }
        return if (ext == null || stem.lowercase().endsWith(".$ext") || (ext == "jpg" && stem.lowercase().endsWith(".jpeg"))) stem else "$stem.$ext"
    }

    fun extensionFor(mime: String): String? = when (mime.lowercase()) {
        "image/jpeg" -> "jpg"; "image/png" -> "png"; "image/webp" -> "webp"; "image/gif" -> "gif"
        "image/heic" -> "heic"; "image/heif" -> "heif"; "image/bmp" -> "bmp"; "image/avif" -> "avif"
        "video/mp4" -> "mp4"; "video/3gpp" -> "3gp"; "video/webm" -> "webm"; "video/quicktime" -> "mov"; "video/x-matroska" -> "mkv"
        else -> null
    }

    /** Where "Save to Gallery" puts it (MediaStore relative path on Android 10+). */
    fun galleryFolder(mime: String): String = if (mime.lowercase().startsWith("video/")) "Movies/Meldiq" else "Pictures/Meldiq"

    /** Android 9 and older need the legacy storage permission to add to the gallery; 10+ need none. */
    fun needsStoragePermission(sdk: Int): Boolean = sdk < 29

    /** The sample size that keeps a decoded image's long edge at or under [maxEdge] (powers of two, as BitmapFactory wants). */
    fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
        var s = 1
        while (maxOf(width, height) / s > maxEdge) s *= 2
        return s
    }
}
