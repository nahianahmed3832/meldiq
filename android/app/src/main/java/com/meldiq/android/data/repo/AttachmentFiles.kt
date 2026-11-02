package com.meldiq.android.data.repo

import com.meldiq.android.data.model.AttachmentRef
import java.io.File

/**
 * Decrypted attachment files in app-private storage (`filesDir/attachments`). File names are built
 * from attachment refs that arrive inside other people's messages, so ids and names are reduced to
 * safe characters and every path must resolve directly inside [dir]: nothing here can read, write or
 * delete anything outside the attachments folder.
 */
class AttachmentFiles(private val dir: File) {
    private val root: File get() = dir.apply { mkdirs() }.canonicalFile

    /** Where an attachment's decrypted copy lives (whether or not it exists yet). */
    fun fileFor(id: String, name: String): File = File(root, "${safeId(id)}-${safeName(name)}")

    /** A plain file name directly inside the folder, or null for anything that could escape it. */
    fun child(name: String): File? {
        if (name.isBlank() || name.contains('/') || name.contains('\\') || name == "." || name == "..") return null
        return File(root, name).canonicalFile.takeIf { it.parentFile == root }
    }

    /**
     * Deletes the local copies of [refs], the attachments of message [messageId]: downloaded or sent
     * files, and a pending upload's file that never got a server id. Other files are left alone.
     * Returns how many files were deleted.
     */
    fun deleteFor(messageId: String, refs: List<AttachmentRef>): Int {
        var deleted = 0
        for (r in refs.flatMap { ref -> listOfNotNull(ref, ref.thumbnail?.asAttachment()) }) {
            val names = buildSet {
                add(fileFor(r.id, r.name).name)
                add(fileFor(messageId, r.name).name)
                if (r.id == PENDING) add(r.sha256) // a pending placeholder keeps its local file name here
            }
            for (n in names) {
                val f = child(n) ?: continue
                if (f.isFile && f.delete()) deleted++
            }
        }
        return deleted
    }

    companion object {
        const val PENDING = "pending"
        fun safeName(n: String) = n.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
        private fun safeId(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(80)
    }
}
