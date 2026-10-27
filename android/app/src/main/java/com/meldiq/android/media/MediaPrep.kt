package com.meldiq.android.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.meldiq.android.data.model.AttachmentPolicy
import com.meldiq.android.data.model.AttachmentPolicy.Quality
import com.meldiq.android.ui.media.MediaGallery
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Standard and HD quality for photos and videos (2026-10-17, docs/ATTACHMENTS.md), done on the phone before the file is
 * encrypted. Photos are decoded upright, scaled down to the quality's longest edge and saved as JPEG (PNG when they have
 * transparency): the camera's metadata, including any location, is not carried over. Videos are re-encoded as H.264/AAC
 * MP4 at the quality's resolution and bitrate (HDR is tone-mapped to SDR so every phone can play it). Original sends the
 * file untouched.
 */
object MediaPrep {
    /** The prepared file's name and type (they change when the format does). */
    data class Prepared(val name: String, val mime: String)

    /** The quality names match the send preview's chips ("Compress (720p)"), so the advice can be followed (UI-003). */
    class TooLargeAfterCompression(name: String, maxBytes: Long) :
        Exception("“$name” is still over ${AttachmentPolicy.sizeLabel(maxBytes)} after compressing, this server's limit. Try Compress (720p), or a shorter video.")

    /** The phone's encoder couldn't re-encode this video (the cause is logged by class name only). */
    class CompressionFailed(name: String, cause: Throwable) :
        java.io.IOException("“$name” couldn't be compressed on this phone. Try the other quality, or Original if it fits.", cause)

    /** Photo at [q] from [src] into [out]. */
    suspend fun photo(src: File, out: File, name: String, q: Quality): Prepared = withContext(Dispatchers.IO) {
        val bmp = try {
            decodeUpright(src, q.photoLongEdge)
        } catch (e: OutOfMemoryError) {
            decodeUpright(src, minOf(q.photoLongEdge, 2048)) // a very large photo on a phone with little memory
        } ?: throw java.io.IOException("This photo couldn't be read")
        try {
            val png = bmp.hasAlpha()
            out.outputStream().use { o -> bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, q.jpegQuality, o) }
            if (png) Prepared(AttachmentPolicy.withExtension(name, "png"), "image/png")
            else Prepared(AttachmentPolicy.withExtension(name, "jpg"), "image/jpeg")
        } finally {
            bmp.recycle()
        }
    }

    /**
     * Decoded with its EXIF rotation applied, longest edge at most [maxEdge], in a software bitmap that can be re-encoded.
     * The framework ExifInterface is only used on Android 8 and 8.1, to read the orientation tag.
     */
    @android.annotation.SuppressLint("ExifInterface")
    private fun decodeUpright(file: File, maxEdge: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= 28) {
            // ImageDecoder applies the EXIF orientation itself.
            return runCatching {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    val long = maxOf(info.size.width, info.size.height)
                    if (long > maxEdge) {
                        val f = maxEdge.toFloat() / long
                        decoder.setTargetSize((info.size.width * f).toInt().coerceAtLeast(1), (info.size.height * f).toInt().coerceAtLeast(1))
                    }
                }
            }.getOrNull()
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val sampled = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = MediaGallery.sampleSize(bounds.outWidth, bounds.outHeight, maxEdge) })
            ?: return null
        val long = maxOf(sampled.width, sampled.height)
        val scale = if (long > maxEdge) maxEdge.toFloat() / long else 1f
        val degrees = runCatching {
            when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        }.getOrDefault(0f)
        if (scale == 1f && degrees == 0f) return sampled
        val m = Matrix().apply { postScale(scale, scale); postRotate(degrees) }
        return Bitmap.createBitmap(sampled, 0, 0, sampled.width, sampled.height, m, true).also { if (it !== sampled) sampled.recycle() }
    }

    /**
     * A profile photo from a picked image: upright, centre-cropped to a square, 512 px, JPEG 85 (about 60 KB). Re-encoding
     * drops the camera's metadata, including location, before the photo leaves the phone.
     */
    suspend fun profilePhoto(context: Context, uri: Uri): ByteArray = withContext(Dispatchers.IO) {
        val tmp = File(context.cacheDir, "profile-src-${System.nanoTime()}")
        try {
            context.contentResolver.openInputStream(uri)?.use { i -> tmp.outputStream().use { o -> i.copyTo(o) } } ?: throw java.io.IOException("can't read")
            val src = decodeUpright(tmp, 1024) ?: throw java.io.IOException("This image couldn't be read")
            val side = minOf(src.width, src.height)
            val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
            val out = if (side > 512) Bitmap.createScaledBitmap(square, 512, 512, true) else square
            val bytes = java.io.ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
            listOf(src, square, out).distinct().forEach { it.recycle() }
            bytes
        } finally {
            tmp.delete()
        }
    }

    /**
     * A banner from a picked still image (profiles and communities, API 0.44.0–0.45.0): upright, centre-cropped to 5:2,
     * [BANNER_WIDTH] × [BANNER_HEIGHT], JPEG (as Meldiq Web sends), stepped down in quality until it fits the server's
     * 1 MB. Re-encoding drops the camera's metadata.
     */
    suspend fun bannerJpeg(context: Context, uri: Uri): ByteArray = withContext(Dispatchers.IO) {
        val tmp = File(context.cacheDir, "banner-src-${System.nanoTime()}")
        try {
            context.contentResolver.openInputStream(uri)?.use { i -> tmp.outputStream().use { o -> i.copyTo(o) } } ?: throw java.io.IOException("can't read")
            val src = decodeUpright(tmp, 2048) ?: throw java.io.IOException("This image couldn't be read")
            val ratio = BANNER_WIDTH.toFloat() / BANNER_HEIGHT
            val w = minOf(src.width, (src.height * ratio).toInt()).coerceAtLeast(1)
            val h = (w / ratio).toInt().coerceAtLeast(1)
            val cropped = Bitmap.createBitmap(src, (src.width - w) / 2, (src.height - h) / 2, w, h)
            val out = Bitmap.createScaledBitmap(cropped, BANNER_WIDTH, BANNER_HEIGHT, true)
            var quality = 88
            var bytes: ByteArray
            do {
                bytes = java.io.ByteArrayOutputStream().also { out.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                quality -= 8
            } while (bytes.size > BANNER_MAX_BYTES && quality > 40)
            listOf(src, cropped, out).distinct().forEach { it.recycle() }
            bytes
        } finally {
            tmp.delete()
        }
    }

    /** A picked file's bytes as they are (an animated GIF or WebP, a short clip), refused past [maxBytes]. */
    suspend fun rawBytes(context: Context, uri: Uri, maxBytes: Long): ByteArray = withContext(Dispatchers.IO) {
        val size = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        if (size > maxBytes) throw java.io.IOException("too_large")
        context.contentResolver.openInputStream(uri)?.use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
                if (total > maxBytes) throw java.io.IOException("too_large")
                out.write(buf, 0, n)
            }
            out.toByteArray()
        } ?: throw java.io.IOException("can't read")
    }

    const val BANNER_WIDTH = 1200
    const val BANNER_HEIGHT = 480
    /** The server's limit for a still banner. */
    const val BANNER_MAX_BYTES = 1_000_000

    data class VideoInfo(val width: Int, val height: Int, val bitrate: Int)

    fun videoInfo(file: File): VideoInfo? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(file.path)
            val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return null
            val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return null
            VideoInfo(w, h, r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull() ?: 0)
        } catch (e: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }

    /**
     * Whether a video already fits [q]: no bigger than its resolution and no more than a little above its bitrate. Such a
     * video is sent as it is (re-encoding would only lose quality).
     */
    fun videoFits(info: VideoInfo, q: Quality): Boolean =
        minOf(info.width, info.height) <= q.videoShortSide && info.bitrate in 1..(q.videoBitrate * 6 / 5)

    /**
     * Video at [q] from [src] into [out] (MP4), reporting progress 0..1. Returns null when the video already fits [q]
     * (the caller sends [src] as it is). Cancelling the coroutine stops the export.
     */
    @OptIn(UnstableApi::class)
    suspend fun video(context: Context, src: File, out: File, name: String, q: Quality, maxBytes: Long, onProgress: (Float) -> Unit): Prepared? {
        val info = withContext(Dispatchers.IO) { videoInfo(src) } ?: throw java.io.IOException("This video couldn't be read")
        if (videoFits(info, q)) return null
        out.delete()
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine { cont ->
                val main = Handler(Looper.getMainLooper())
                val holder = ProgressHolder()
                lateinit var poll: Runnable
                val transformer = Transformer.Builder(context)
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(
                        DefaultEncoderFactory.Builder(context)
                            .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(q.videoBitrate).build())
                            .setEnableFallback(true)
                            .build(),
                    )
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                            main.removeCallbacks(poll)
                            if (cont.isActive) cont.resume(Unit)
                        }

                        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                            main.removeCallbacks(poll)
                            if (cont.isActive) cont.resumeWithException(CompressionFailed(name, exportException))
                        }
                    })
                    .build()
                val shrink = minOf(info.width, info.height) > q.videoShortSide
                val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(src)))
                    .setEffects(Effects(emptyList(), if (shrink) listOf(Presentation.createForShortSide(q.videoShortSide)) else emptyList()))
                    .build()
                val composition = Composition.Builder(EditedMediaItemSequence.Builder(item).build())
                    .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
                    .build()
                poll = Runnable {
                    if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress / 100f)
                    main.postDelayed(poll, 400)
                }
                transformer.start(composition, out.path)
                main.postDelayed(poll, 400)
                cont.invokeOnCancellation {
                    main.post {
                        main.removeCallbacks(poll)
                        transformer.cancel()
                        out.delete()
                    }
                }
            }
        }
        if (out.length() > maxBytes) {
            out.delete()
            throw TooLargeAfterCompression(name, maxBytes)
        }
        return Prepared(AttachmentPolicy.withExtension(name, "mp4"), "video/mp4")
    }
}
