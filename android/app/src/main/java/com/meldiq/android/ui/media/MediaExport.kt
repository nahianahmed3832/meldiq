package com.meldiq.android.ui.media

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.Drawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Decoding and exporting decrypted attachments. The input is always the decrypted copy in app-private storage
 * (`filesDir/attachments`), produced by `MessageRepository.downloadAttachment` after its hash and GCM checks; the
 * encrypted download is never exported. Everything streams: no file is read whole into memory.
 */
object MediaExport {
    /** Keeps GIF/WebP animation when supported, with bounded frames rather than a full-resolution decode. */
    suspend fun decodeDrawable(file: File, maxEdge: Int): Drawable? = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < 28) return@withContext null
        runCatching {
            ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) { decoder, info, _ ->
                val edge = if (info.isAnimated) minOf(maxEdge, 1600) else maxEdge
                val factor = minOf(1f, edge.coerceAtLeast(1).toFloat() / maxOf(info.size.width, info.size.height).coerceAtLeast(1))
                decoder.setTargetSize((info.size.width * factor).toInt().coerceAtLeast(1), (info.size.height * factor).toInt().coerceAtLeast(1))
            }
        }.getOrNull()
    }

    /** Decodes [file] with its long edge at most [maxEdge], applying the photo's EXIF rotation (Android 9+). */
    suspend fun decode(file: File, maxEdge: Int): Bitmap? = withContext(Dispatchers.IO) {
        runCatching {
            if (Build.VERSION.SDK_INT >= 28) {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    val long = maxOf(info.size.width, info.size.height)
                    if (long > maxEdge) {
                        val f = maxEdge.toFloat() / long
                        decoder.setTargetSize((info.size.width * f).toInt().coerceAtLeast(1), (info.size.height * f).toInt().coerceAtLeast(1))
                    }
                }
            } else {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = MediaGallery.sampleSize(bounds.outWidth, bounds.outHeight, maxEdge) })
            }
        }.getOrNull()
    }

    /** A frame from the video for the chat bubble, scaled down; null if the file can't be read as a video. */
    suspend fun videoFrame(file: File, maxEdge: Int): Bitmap? = withContext(Dispatchers.IO) {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(file.path)
            val width = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val height = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val longest = maxOf(width, height)
            val frame = if (Build.VERSION.SDK_INT >= 27 && longest > maxEdge) {
                r.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, (width * maxEdge / longest).coerceAtLeast(1), (height * maxEdge / longest).coerceAtLeast(1))
            } else r.getFrameAtTime(0)
            if (frame == null) return@withContext null
            val long = maxOf(frame.width, frame.height)
            if (long <= maxEdge) frame else Bitmap.createScaledBitmap(frame, frame.width * maxEdge / long, frame.height * maxEdge / long, true).also { frame.recycle() }
        } catch (e: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }

    /**
     * Adds a copy to the phone's gallery (Pictures/Meldiq or Movies/Meldiq). Android 10+ needs no permission; on 9 and older
     * the caller must hold WRITE_EXTERNAL_STORAGE ([MediaGallery.needsStoragePermission]). Returns the folder it went to.
     */
    suspend fun saveToGallery(context: Context, file: File, name: String, mime: String): String = withContext(Dispatchers.IO) {
        val video = mime.lowercase().startsWith("video/")
        val folder = MediaGallery.galleryFolder(mime)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, MediaGallery.safeName(name, mime))
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            } else {
                // Before scoped storage MediaStore needs a real path; the app holds the legacy permission here.
                val dir = File(Environment.getExternalStoragePublicDirectory(if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), "Meldiq").apply { mkdirs() }
                @Suppress("DEPRECATION")
                put(MediaStore.MediaColumns.DATA, uniqueFile(dir, MediaGallery.safeName(name, mime)).path)
            }
        }
        val collection = when {
            video && Build.VERSION.SDK_INT >= 29 -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            video -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            Build.VERSION.SDK_INT >= 29 -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(collection, values) ?: throw java.io.IOException("The gallery refused the file")
        try {
            resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } } ?: throw java.io.IOException("Can't write to the gallery")
            if (Build.VERSION.SDK_INT >= 29) resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) } // never leave a half-written entry in the gallery
            throw e
        }
        folder
    }

    /** Copies [file] into a document the person chose with the system file picker ("Save to Files"). */
    suspend fun saveToDocument(context: Context, file: File, target: Uri) = withContext(Dispatchers.IO) {
        context.contentResolver.openOutputStream(target, "wt")?.use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } }
            ?: throw java.io.IOException("Can't write to that location")
    }

    /**
     * Copies [file] as a new document named [name] into the folder the person picked with the system folder picker
     * ([tree], from OpenDocumentTree). Used by "save several files" (round 7, [BulkSave]); if the folder already has a
     * file by that name, the provider picks a free one. A half-written document is removed.
     */
    suspend fun saveToFolder(context: Context, file: File, tree: Uri, name: String, mime: String): Uri = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val doc = DocumentsContract.createDocument(resolver, parent, mime.ifBlank { "application/octet-stream" }, name)
            ?: throw java.io.IOException("That folder refused the file")
        try {
            resolver.openOutputStream(doc, "w")?.use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } }
                ?: throw java.io.IOException("Can't write to that folder")
        } catch (e: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, doc) }
            throw e
        }
        doc
    }

    /**
     * Opens Android's share sheet for a copy of [file]. Only ever from an explicit "Share" action, never from a tap.
     * Shared copies older than an hour are removed first, so decrypted copies don't pile up in the cache.
     */
    suspend fun shareIntent(context: Context, file: File, name: String, mime: String): Intent = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "shared").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - 3600_000L
        dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        val out = File(dir, MediaGallery.safeName(name, mime))
        file.copyTo(out, overwrite = true)
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", out)
        Intent.createChooser(
            Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            "Share",
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun uniqueFile(dir: File, name: String): File {
        var f = File(dir, name)
        var i = 1
        val stem = name.substringBeforeLast('.')
        val ext = name.substringAfterLast('.', "")
        while (f.exists()) f = File(dir, "$stem ($i)" + if (ext.isNotEmpty()) ".$ext" else "").also { i++ }
        return f
    }
}

/** "Save to Files": the system document picker, titled with the file's name and typed with its MIME type. */
class CreateDocumentFor : androidx.activity.result.contract.ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(input.second).putExtra(Intent.EXTRA_TITLE, input.first)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
}
