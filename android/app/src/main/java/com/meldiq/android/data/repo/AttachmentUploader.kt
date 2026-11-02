package com.meldiq.android.data.repo

import com.meldiq.android.crypto.b64
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiErrors
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.AttachmentUploadRes
import com.meldiq.android.data.api.CompleteUploadReq
import com.meldiq.android.data.api.CompletedPart
import com.meldiq.android.data.api.DirectUploadReq
import com.meldiq.android.data.api.DirectUploadRes
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.api.PartReq
import com.meldiq.android.data.api.PartUrlsRes
import com.meldiq.android.data.api.PartsReq
import com.meldiq.android.data.api.PresignedRequestDto
import com.meldiq.android.data.api.StoredPartsRes
import com.meldiq.android.data.api.UploadUrlRes
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * Uploads an encrypted attachment (2026-10-17, docs/STORAGE_AND_DATA.md › Direct uploads). When the server stores files
 * in S3 it presigns the upload and the ciphertext goes straight to S3: one request bound to the file's size and SHA-256,
 * or, above the server's threshold, parts of a fixed size with their own SHA-256 (a dropped connection only re-sends one
 * part). The server checks the stored object before it becomes an attachment. Servers that store files themselves, or
 * that are older, get the original upload (POST /v1/attachments). Either way the result is the same attachment id.
 * Unit-tested in `AttachmentUploaderTest`.
 */
class AttachmentUploader(private val api: ApiClient, private val features: ServerFeatures?, private val checkpointDir: File? = null) {
    @kotlinx.serialization.Serializable
    private data class Checkpoint(val start: DirectUploadRes, val completed: List<CompletedPart>? = null)
    private val checkpoints = java.util.concurrent.ConcurrentHashMap<String, Checkpoint>()
    private fun checkpointKey(cid: String, sha: String, size: Long) = MessageDigest.getInstance("SHA-256").digest("$cid:$sha:$size".toByteArray()).joinToString("") { "%02x".format(it) }
    private fun load(key: String): Checkpoint? = (checkpoints[key] ?: checkpointDir?.resolve(key)?.takeIf { it.isFile }?.let {
        runCatching { com.meldiq.android.data.api.GriipJson.decodeFromString(Checkpoint.serializer(), it.readText()) }.getOrNull()
    })?.takeIf { it.start.expiresAt > System.currentTimeMillis() }
    private fun save(key: String, checkpoint: Checkpoint) {
        checkpoints[key] = checkpoint
        checkpointDir?.let { dir ->
            dir.mkdirs()
            dir.listFiles()?.filter { it.isFile && it.lastModified() < System.currentTimeMillis() - 7 * 86_400_000L }?.forEach { it.delete() }
            val temp = File(dir, "$key.part")
            temp.writeText(com.meldiq.android.data.api.GriipJson.encodeToString(Checkpoint.serializer(), checkpoint.copy(start = checkpoint.start.copy(upload = null))))
            if (!temp.renameTo(File(dir, key))) throw java.io.IOException("Couldn't save upload progress")
        }
    }
    private fun drop(key: String) { checkpoints.remove(key); checkpointDir?.resolve(key)?.delete() }


    /** [sha256] is the base64 SHA-256 of the whole encrypted [file], as it goes into the attachment reference. */
    suspend fun upload(cid: String, file: File, sha256: String, onProgress: (Float) -> Unit): AttachmentUploadRes {
        if (features?.has(ServerFeatures.DIRECT_UPLOAD) == true) {
            try {
                return direct(cid, file, sha256, onProgress)
            } catch (e: ApiException) {
                // The server stopped offering it (configuration changed): the original upload still works.
                if (e.code != "direct_upload_unavailable" && e.code != ApiErrors.UNSUPPORTED) throw e
                features.forget()
            }
        }
        return TransferRetry.run { api.uploadFile("/v1/attachments?conversationId=$cid", file, onProgress) }
    }

    private suspend fun direct(cid: String, file: File, sha256: String, onProgress: (Float) -> Unit, resume: Boolean = true): AttachmentUploadRes {
        val size = file.length()
        val key = checkpointKey(cid, sha256, size)
        val previous = if (resume) load(key) else null
        val start = previous?.start ?: TransferRetry.run { api.post<DirectUploadReq, DirectUploadRes>("/v1/attachments/uploads", DirectUploadReq(cid, size, sha256)) }
        save(key, previous ?: Checkpoint(start))
        val base = "/v1/attachments/uploads/${start.uploadId}"
        try {
            if (previous != null && start.mode == "single") {
                try { return api.post<CompleteUploadReq, AttachmentUploadRes>("$base/complete", CompleteUploadReq(null)) }
                catch (e: ApiException) { if (e.code != "not_uploaded") throw e }
            }
            val parts = previous?.completed ?: if (start.mode == "multipart") multipart(base, file, start, onProgress) else {
                single(base, file, start.upload ?: refreshUrl(base), onProgress)
                null
            }
            save(key, Checkpoint(start, parts))
            val result = TransferRetry.run {
                try {
                    api.post<CompleteUploadReq, AttachmentUploadRes>("$base/complete", CompleteUploadReq(parts))
                } catch (e: ApiException) {
                    // The store hasn't got it after all (it would have refused a mismatch): send it once more.
                    if (e.code != "not_uploaded" || start.mode != "single") throw e
                    single(base, file, refreshUrl(base), onProgress)
                    api.post<CompleteUploadReq, AttachmentUploadRes>("$base/complete", CompleteUploadReq(null))
                }
            }
            // Keep the completed id until the session expires: a process death before Room saves the result can retry it.
            return result
        } catch (e: Exception) {
            if (previous != null && e is ApiException && (e.status == 404 || e.status == 410)) {
                drop(key)
                return direct(cid, file, sha256, onProgress, resume = false)
            }
            // Transient failures retain the same ciphertext/session; explicit cancellation abandons it.
            if (e is ApiException && TransferRetry.isTransient(e)) throw e
            drop(key)
            withContext(NonCancellable) {
                withTimeoutOrNull(5_000) { runCatching { api.delete<OkRes>(base) } }
            }
            throw e
        }
    }

    private suspend fun refreshUrl(base: String): PresignedRequestDto = api.post<UploadUrlRes>("$base/url").upload

    /** One presigned PUT; an expired URL (403) is replaced once, and 412 means the file is already there. */
    private suspend fun single(base: String, file: File, first: PresignedRequestDto, onProgress: (Float) -> Unit) {
        var req = first
        var refreshed = false
        TransferRetry.run {
            try {
                api.putPresigned(req.url, req.headers, file, 0, file.length()) { sent -> onProgress(sent.toFloat() / file.length()) }
            } catch (e: ApiException) {
                when {
                    e.status == 412 -> null // an earlier attempt got through: the store refuses to replace it
                    e.status == 403 && !refreshed -> {
                        refreshed = true
                        req = refreshUrl(base)
                        throw ApiException(0, "network", "Upload link renewed") // retried by TransferRetry
                    }
                    else -> throw e
                }
            }
        }
    }

    /** All parts, each retried on its own; returns them for completion. Parts the store already has are skipped. */
    private suspend fun multipart(base: String, file: File, start: DirectUploadRes, onProgress: (Float) -> Unit): List<CompletedPart> {
        val partSize = start.partSize ?: throw ApiException(0, "decode", "Unexpected server response")
        val count = start.partCount ?: throw ApiException(0, "decode", "Unexpected server response")
        val total = file.length()
        if (partSize <= 0 || count !in 1..10000 || count.toLong() != (total + partSize - 1) / partSize) {
            throw ApiException(0, "decode", "The server returned an invalid multipart layout")
        }
        val specs = withContext(Dispatchers.IO) {
            (1..count).map { n ->
                val offset = (n - 1) * partSize
                val len = minOf(partSize, total - offset)
                PartReq(n, len, sha256Of(file, offset, len))
            }
        }
        val done = HashMap<Int, CompletedPart>()
        var sentBefore = 0L
        // After an interruption, what the store already has (matching size and hash) needn't be sent again.
        runCatching { api.get<StoredPartsRes>("$base/parts").parts }.getOrNull()?.forEach { p ->
            val spec = specs.getOrNull(p.n - 1)
            if (spec != null && p.size == spec.size && p.sha256 == spec.sha256) {
                done[p.n] = CompletedPart(p.n, p.etag, spec.sha256)
                sentBefore += spec.size
            }
        }
        for (batch in specs.filter { it.n !in done }.chunked(8)) {
            var urls = TransferRetry.run { api.post<PartsReq, PartUrlsRes>("$base/parts", PartsReq(batch)) }.parts.associateBy { it.n }
            for (spec in batch) {
                val offset = (spec.n - 1) * partSize
                var renewed = false
                val etag = TransferRetry.run {
                    val url = urls[spec.n]?.upload ?: throw ApiException(0, "decode", "Unexpected server response")
                    try {
                        // S3 confirms every stored part with an ETag; an answer without one was cut off: send the part again.
                        api.putPresigned(url.url, url.headers, file, offset, spec.size) { sent -> onProgress((sentBefore + sent).toFloat() / total) }
                            ?: throw ApiException(0, "network", "The file store didn't confirm a part")
                    } catch (e: ApiException) {
                        if (e.status != 403 || renewed) throw e
                        renewed = true
                        urls = urls + api.post<PartsReq, PartUrlsRes>("$base/parts", PartsReq(listOf(spec))).parts.associateBy { it.n }
                        throw ApiException(0, "network", "Upload link renewed")
                    }
                }
                done[spec.n] = CompletedPart(spec.n, etag, spec.sha256)
                sentBefore += spec.size
            }
        }
        return (1..count).map { done.getValue(it) }
    }

    companion object {
        fun sha256Of(file: File, offset: Long, length: Long): String {
            val md = MessageDigest.getInstance("SHA-256")
            java.io.RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val buf = ByteArray(256 * 1024)
                var left = length
                while (left > 0) {
                    val n = raf.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) break
                    md.update(buf, 0, n)
                    left -= n
                }
            }
            return md.digest().b64()
        }
    }
}
