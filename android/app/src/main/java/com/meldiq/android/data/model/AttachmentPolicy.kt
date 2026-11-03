package com.meldiq.android.data.model

/**
 * What may be sent, and how files are checked (2026-10-17 batch attachments, docs/ATTACHMENTS.md; unit-tested in
 * `AttachmentPolicyTest`).
 *
 * File bodies are encrypted on the phone before storage. Current v2 server-stored messages carry their keys to the
 * relay, so that path is not E2EE against the server. No malware scanning is implemented. These plaintext checks run
 * on the phone: the real type of a file is
 * read from its first bytes (not trusted from its name or the picker's MIME type), names are made safe to show and save,
 * and files that can install or run software are flagged before sending and before opening.
 */
object AttachmentPolicy {
    /** Photos, videos or files in one message. */
    const val MAX_ITEMS = 10

    /**
     * Files up to this size use the original single-message encryption, which every Meldiq and Orbit version opens; it is also the
     * limit of servers that don't advertise one. Larger files use the chunked format (docs/ATTACHMENTS.md › Large files).
     */
    const val LEGACY_MAX_FILE_BYTES = 25L * 1024 * 1024
    /** The default limit: what servers before the large-file change accept. */
    const val MAX_FILE_BYTES = LEGACY_MAX_FILE_BYTES

    /**
     * The most this app sends in one file, whatever the server allows (also bounded by the phone's free space): Meldiq
     * 1 GB ceiling (1,000,000,000 bytes of the original file).
     */
    const val APP_MAX_FILE_BYTES = 1_000_000_000L

    /**
     * The limit to use with a server. [serverFileMax] is Orbit 2.0's `fileMaxBytes` (the file itself, before encryption);
     * older servers only give [serverMax], their ciphertext limit, used as it is. Neither: a server before large files.
     */
    fun effectiveMax(serverMax: Long?, serverFileMax: Long? = null): Long =
        when {
            serverFileMax != null && serverFileMax >= 0 -> serverFileMax.coerceAtMost(APP_MAX_FILE_BYTES)
            serverMax != null && serverMax > 0 -> (serverMax - 16).coerceIn(0, APP_MAX_FILE_BYTES)
            else -> LEGACY_MAX_FILE_BYTES
        }

    /**
     * Free space a file of [size] bytes needs on the phone before sending: its copy in app storage and its encrypted copy
     * (16 bytes more per MiB), plus a margin so the phone isn't filled to the last byte. Unknown size: the margin only.
     */
    fun spaceNeeded(size: Long): Long = if (size <= 0) SPACE_MARGIN_BYTES else size * 2 + 16 * (size / CHUNK_BYTES + 1) + SPACE_MARGIN_BYTES

    private const val CHUNK_BYTES = 1024L * 1024
    private const val SPACE_MARGIN_BYTES = 64L * 1024 * 1024

    /** "25 MB", "500 MB", "1.5 MB", "1 GB". */
    fun sizeLabel(bytes: Long): String {
        if (bytes == APP_MAX_FILE_BYTES) return "1 GB"
        val mb = bytes / (1024.0 * 1024.0)
        val gb = mb / 1024.0
        return when {
            gb >= 1 -> if (bytes % (1024L * 1024 * 1024) == 0L) "${gb.toLong()} GB" else String.format(java.util.Locale.ROOT, "%.1f GB", gb)
            // Rounded, not cut: a 25 MB limit less a few hundred bytes of encryption overhead read "24 MB" (UI-003).
            mb >= 10 -> "${Math.round(mb)} MB"
            mb >= 1 -> String.format(java.util.Locale.ROOT, "%.1f MB", mb)
            else -> "${(bytes / 1024).coerceAtLeast(1)} KB"
        }
    }

    /** Largest photo or video picked for compression (Standard/HD): it's copied to the phone's app storage first. */
    const val MAX_SOURCE_BYTES = 1024L * 1024 * 1024

    enum class Quality(val label: String, val photoLongEdge: Int, val jpegQuality: Int, val videoShortSide: Int, val videoBitrate: Int) {
        STANDARD("Standard", 1600, 82, 720, 2_000_000),
        HD("HD", 4096, 92, 1080, 5_000_000),
        ORIGINAL("Original", 0, 0, 0, 0),
    }

    /** The real type of a file, from its first bytes. */
    enum class Sniffed(val visual: Kind?) {
        JPEG(Kind.PHOTO), PNG(Kind.PHOTO), GIF(Kind.PHOTO), WEBP(Kind.PHOTO), AVIF(Kind.PHOTO), HEIF(Kind.PHOTO), BMP(Kind.PHOTO),
        MP4(Kind.VIDEO), WEBM(Kind.VIDEO),
        PDF(null), ZIP(null),
        /** Windows program (MZ), Linux program (ELF), macOS program (Mach-O), or a script starting with `#!`. */
        EXECUTABLE(null),
    }

    enum class Kind { PHOTO, VIDEO, FILE }

    /** Reads [head] (the first 32 bytes or more of a file). Null: none of the types above. */
    fun sniff(head: ByteArray): Sniffed? {
        fun at(i: Int, vararg b: Int) = head.size >= i + b.size && b.indices.all { (head[i + it].toInt() and 0xFF) == b[it] }
        fun ascii(i: Int, s: String) = head.size >= i + s.length && s.indices.all { head[i + it].toInt() == s[it].code }
        return when {
            at(0, 0xFF, 0xD8, 0xFF) -> Sniffed.JPEG
            at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) -> Sniffed.PNG
            ascii(0, "GIF87a") || ascii(0, "GIF89a") -> Sniffed.GIF
            ascii(0, "RIFF") && ascii(8, "WEBP") -> Sniffed.WEBP
            ascii(0, "BM") && head.size >= 14 -> Sniffed.BMP
            ascii(4, "ftyp") -> {
                val brand = if (head.size >= 12) String(head, 8, 4, Charsets.ISO_8859_1) else ""
                if (brand in setOf("avif", "avis")) Sniffed.AVIF else if (brand in HEIF_BRANDS) Sniffed.HEIF else Sniffed.MP4
            }
            at(0, 0x1A, 0x45, 0xDF, 0xA3) -> Sniffed.WEBM // Matroska/WebM
            ascii(0, "%PDF-") -> Sniffed.PDF
            at(0, 0x50, 0x4B, 0x03, 0x04) -> Sniffed.ZIP
            ascii(0, "MZ") || at(0, 0x7F, 0x45, 0x4C, 0x46) || at(0, 0xFE, 0xED, 0xFA, 0xCE) || at(0, 0xFE, 0xED, 0xFA, 0xCF) ||
                at(0, 0xCE, 0xFA, 0xED, 0xFE) || at(0, 0xCF, 0xFA, 0xED, 0xFE) || at(0, 0xCA, 0xFE, 0xBA, 0xBE) || ascii(0, "#!") -> Sniffed.EXECUTABLE
            else -> null
        }
    }

    private val HEIF_BRANDS = setOf("heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis")

    /** File types that install or run software when opened. Sending is allowed after a warning; so is opening. */
    private val RISKY_EXTENSIONS = setOf(
        "apk", "apks", "apkm", "xapk", "aab", "exe", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "pif", "cpl", "ps1", "psm1",
        "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "jar", "sh", "bash", "command", "app", "dmg", "pkg", "deb", "rpm",
        "run", "bin", "elf", "dll", "so", "lnk", "reg", "inf", "scf", "msp", "gadget", "iso", "img", "vhd", "vhdx",
        "docm", "xlsm", "pptm", "dotm", "xltm",
    )

    /** Why a file can run software, or null. Looks at the real content and at the name (including a hidden second extension). */
    fun risk(name: String, mime: String, sniffed: Sniffed?): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        val mimeL = mime.lowercase()
        return when {
            sniffed == Sniffed.EXECUTABLE -> "This file is a program or script."
            ext in setOf("apk", "apks", "apkm", "xapk", "aab") || mimeL == "application/vnd.android.package-archive" -> "This file installs an Android app."
            ext in setOf("docm", "xlsm", "pptm", "dotm", "xltm") -> "This document contains macros, which can run code."
            ext in RISKY_EXTENSIONS -> "Files ending in .$ext can run software."
            else -> null
        }
    }

    /**
     * How a file is sent and shown: a photo or video only if its bytes really are one (a program named "photo.jpg" is sent
     * as a plain file), otherwise a file.
     */
    fun kind(mime: String, sniffed: Sniffed?): Kind {
        val visual = sniffed?.visual ?: return Kind.FILE
        val m = mime.lowercase()
        return when {
            visual == Kind.PHOTO && (m.startsWith("image/") || m == "application/octet-stream" || m.isEmpty()) -> Kind.PHOTO
            visual == Kind.VIDEO && (m.startsWith("video/") || m == "application/octet-stream" || m.isEmpty()) -> Kind.VIDEO
            else -> Kind.FILE
        }
    }

    /** The MIME type to send: the real type for photos and videos, and never an image/video type for anything else. */
    fun sendMime(mime: String, kind: Kind, sniffed: Sniffed?): String = when (kind) {
        Kind.PHOTO -> when (sniffed) {
            Sniffed.JPEG -> "image/jpeg"
            Sniffed.PNG -> "image/png"
            Sniffed.GIF -> "image/gif"
            Sniffed.WEBP -> "image/webp"
            Sniffed.AVIF -> "image/avif"
            Sniffed.HEIF -> "image/heic"
            Sniffed.BMP -> "image/bmp"
            else -> mime
        }
        Kind.VIDEO -> if (sniffed == Sniffed.WEBM) "video/webm" else if (mime.lowercase().startsWith("video/")) mime else "video/mp4"
        Kind.FILE -> {
            val m = mime.lowercase()
            if (m.startsWith("image/") || m.startsWith("video/") || m.isBlank() || '/' !in m) "application/octet-stream" else m
        }
    }

    /** Characters that can disguise a name: controls, bidirectional overrides (e.g. "gpj.exe" shown as "exe.jpg"), zero-width. */
    private val HIDDEN = Regex("[\\p{Cc}\\p{Cf}\\u2028\\u2029]")
    private val RESERVED = Regex("[\\\\/:*?\"<>|]")

    /** A name that is safe to show and to save: no folders, hidden or reserved characters, at most 120 characters. */
    fun safeName(raw: String?, fallback: String = "file"): String {
        var n = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
        n = HIDDEN.replace(n, "")
        n = RESERVED.replace(n, "_").trim().trimStart('.').trim()
        if (n.isEmpty()) n = fallback
        if (n.length > 120) {
            val ext = n.substringAfterLast('.', "").take(10)
            val base = n.substringBeforeLast('.').take(120 - ext.length - 1)
            n = if (ext.isEmpty()) n.take(120) else "$base.$ext"
        }
        return n
    }

    /** [name] with its extension replaced (after compression changes the format). */
    fun withExtension(name: String, ext: String): String {
        val base = name.substringBeforeLast('.', name).ifEmpty { "file" }
        return "$base.$ext"
    }

    sealed interface Verdict {
        data object Ok : Verdict
        /**
         * Can be sent, but compressing it will probably not bring it under the server's limit (from the video's length and
         * the quality's bitrate, so an estimate): the person is told before a long compression, not after it (UI-003).
         */
        data class MayBeTooLarge(val reason: String) : Verdict
        data class TooLarge(val reason: String) : Verdict

        val sendable: Boolean get() = this !is TooLarge
    }

    /**
     * Whether a picked file of [size] bytes can be sent at [quality] (compression happens later, on the phone). A negative
     * [size] means the picker didn't say: the limit is then enforced while the file is copied. [durationMs] (videos)
     * lets a compressed video's size be estimated against [maxFile].
     */
    fun check(kind: Kind, sniffed: Sniffed?, size: Long, quality: Quality, maxFile: Long = MAX_FILE_BYTES, durationMs: Long? = null): Verdict {
        val compresses = quality != Quality.ORIGINAL && compressible(kind, sniffed)
        return when {
            size < 0L -> Verdict.Ok
            size == 0L -> Verdict.TooLarge("This file is empty.")
            compresses && size > MAX_SOURCE_BYTES -> Verdict.TooLarge("Too large to compress on this phone (over 1 GB).")
            !compresses && size > maxFile -> Verdict.TooLarge("Over ${sizeLabel(maxFile)}. Files up to ${sizeLabel(maxFile)} can be sent.")
            compresses -> compressedVerdict(kind, sniffed, size, durationMs, quality, maxFile)
            else -> Verdict.Ok
        }
    }

    /** A compressed video whose estimate is over [maxFile]: which smaller choice would probably fit, if any. */
    private fun compressedVerdict(kind: Kind, sniffed: Sniffed?, size: Long, durationMs: Long?, quality: Quality, maxFile: Long): Verdict {
        if (kind == Kind.VIDEO && durationMs == null) return Verdict.Ok // length unknown: no estimate, checked after compressing
        val estimate = estimate(kind, sniffed, size, durationMs, quality) ?: return Verdict.Ok
        if (estimate <= maxFile) return Verdict.Ok
        val smaller = (estimate(kind, sniffed, size, durationMs, Quality.STANDARD) ?: Long.MAX_VALUE) <= maxFile
        val hint = if (quality == Quality.HD && smaller) "Compress (720p) should fit." else "Try a shorter video."
        return Verdict.MayBeTooLarge("About ${sizeLabel(estimate)} after compressing, over the ${sizeLabel(maxFile)} limit. $hint")
    }

    /**
     * About how large the file will be when sent ([size] when it's sent as it is). An estimate for the preview, not a
     * promise: compression depends on the content. Null when it can't be told (an unknown size).
     */
    fun estimate(kind: Kind, sniffed: Sniffed?, size: Long, durationMs: Long?, quality: Quality): Long? {
        if (size < 0) return null
        if (quality == Quality.ORIGINAL || !compressible(kind, sniffed)) return size
        return when (kind) {
            Kind.PHOTO -> minOf(size, if (quality == Quality.HD) 1_800_000L else 450_000L)
            Kind.VIDEO -> durationMs?.let { minOf(size, it / 1000 * (quality.videoBitrate + 128_000) / 8) } ?: size
            Kind.FILE -> size
        }
    }

    /** Only known static photos are re-encoded; GIF, PNG, WebP and HEIF/AVIF may contain animation. */
    fun compressible(kind: Kind, sniffed: Sniffed?): Boolean = when (kind) {
        Kind.PHOTO -> sniffed == Sniffed.JPEG || sniffed == Sniffed.BMP
        Kind.VIDEO -> sniffed == Sniffed.MP4 // MP4/MOV/3GP; WebM is sent as it is
        Kind.FILE -> false
    }

    /** A received attachment's kind from its declared type (for previews only; showing it checks the real bytes). */
    fun kindOfMime(mime: String): Kind = mime.lowercase().let {
        when {
            it.startsWith("image/") -> Kind.PHOTO
            it.startsWith("video/") -> Kind.VIDEO
            else -> Kind.FILE
        }
    }

    /** The chat-list preview for a message with these attachments. */
    fun preview(kinds: List<Kind>): String {
        val photos = kinds.count { it == Kind.PHOTO }
        val videos = kinds.count { it == Kind.VIDEO }
        val files = kinds.size - photos - videos
        fun n(k: Int, one: String, many: String) = if (k == 1) "1 $one" else "$k $many"
        return when {
            kinds.isEmpty() -> "📎 Attachment"
            files == 0 && videos == 0 -> "📷 " + (if (photos == 1) "Photo" else n(photos, "photo", "photos"))
            files == 0 && photos == 0 -> "🎬 " + (if (videos == 1) "Video" else n(videos, "video", "videos"))
            files == 0 -> "📷 ${n(photos, "photo", "photos")} and ${n(videos, "video", "videos")}"
            photos + videos == 0 -> "📎 " + n(files, "file", "files")
            else -> "📎 ${kinds.size} attachments"
        }
    }
}
