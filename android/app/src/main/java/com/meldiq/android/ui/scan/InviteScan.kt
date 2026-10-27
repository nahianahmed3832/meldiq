package com.meldiq.android.ui.scan

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * What a scanned QR code may contain (T4.2). Only invite codes are accepted: the link the invite
 * screen draws (`https://web.meldiq.app/invite/CODE` since 2026-10-28, as Meldiq Web; `https://meldiq.app/invite/CODE`
 * from batch B4b; `meldiq://invite/CODE`, or `griip://invite/CODE` from Orbit and Griip Message), the shared invite text
 * that contains it, or a bare code. Anything else, other web
 * links included, is refused, so a QR code can never make the app open a URL.
 */
object InviteCodes {
    private val LINK = Regex("""(?:(?:meldiq|griip)://invite/|https://(?:www\.|web\.)?meldiq\.app/invite/|https://web\.griipbuddy\.cloud/invite/)([A-Za-z0-9-]{1,40})""", RegexOption.IGNORE_CASE)

    /** Schemes whose invite links open this app (the older one only for invitations made before Meldiq). */
    val LINK_SCHEMES = setOf("meldiq", "griip")

    /**
     * The web address invite links use (2026-10-28, as Meldiq Web): its invitation page loads in any browser, and opens
     * this app when installed (Android App Links). `meldiq.app` itself has no web server, so links made there didn't open.
     */
    const val WEB_HOST = "web.meldiq.app"

    /** Hosts whose `/invite/…` links this app opens: the web app's, and the older meldiq.app ones still in circulation. */
    val WEB_HOSTS = setOf(WEB_HOST, "meldiq.app", "www.meldiq.app")

    /** The link the invite screen draws and shares: a web link, tappable in any app, that opens Meldiq when installed. */
    fun link(code: String) = "https://$WEB_HOST/invite/$code"

    /** Whether [scheme]/[host]/[path] is an invite link this app opens (the old app scheme or a Meldiq web page). */
    fun isInviteLink(scheme: String?, host: String?, path: String?): Boolean =
        (scheme in LINK_SCHEMES && host == "invite") ||
            (scheme == "https" && host in WEB_HOSTS && path.orEmpty().startsWith("/invite/"))
    private val BARE = Regex("""[A-Za-z0-9]{4}(-?[A-Za-z0-9]{4}){2,4}""")

    /** A code inside longer text, e.g. the shared invite message pasted into the code field; never part of a web address. */
    private val EMBEDDED = Regex("""(?<![A-Za-z0-9/.])[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){0,2}(?![A-Za-z0-9/-])""")

    /** The characters the server draws codes from (server `CODE_ALPHABET`): no I, L, O, 0 or 1, which look alike. */
    const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    /** The invite code in [scanned], formatted `XXXX-XXXX-XXXX`, or null if it isn't a Griip invite. */
    fun fromScan(scanned: String): String? {
        val text = scanned.trim()
        val raw = LINK.find(text)?.groupValues?.get(1) ?: text.takeIf { BARE.matches(it) } ?: return null
        val code = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
        if (code.length !in 12..20) return null
        return code.chunked(4).joinToString("-")
    }

    /**
     * The code in pasted or typed text: the invite link, a whole code, or a dashed code inside a longer message
     * ("Join … with invite code ABCD-EFGH-JK23"). Null when there isn't exactly one recognisable code.
     */
    fun extract(text: String): String? = fromScan(text) ?: EMBEDDED.findAll(text).map { it.value.uppercase() }.distinct().singleOrNull()?.let { fromScan(it) }

    /** What the code field holds, checked before anything is sent to the server. */
    sealed interface Typed {
        /** Not enough characters yet: say nothing. */
        data object Incomplete : Typed
        /** Can't be a Griip code, with the reason to show. */
        data class Invalid(val reason: String) : Typed
        /** Well-formed: [code] is normalised (`XXXX-XXXX-XXXX`) and may be previewed. */
        data class Ok(val code: String) : Typed
    }

    /**
     * Normalises what was typed (case, spaces and dashes don't matter) without changing which code it is: characters
     * outside [ALPHABET] are reported, not guessed (an O is not silently turned into a 0, which the server never uses).
     */
    fun check(input: String): Typed {
        val chars = input.uppercase().filter { it.isLetterOrDigit() }
        if (chars.isEmpty()) return Typed.Incomplete
        val wrong = chars.filter { it !in ALPHABET }.toSet()
        if (wrong.isNotEmpty()) {
            return Typed.Invalid("Invite codes never contain ${wrong.sorted().joinToString(", ")}. Check the code with whoever sent it.")
        }
        if (chars.length < 12) return Typed.Incomplete
        if (chars.length > 20 || chars.length % 4 != 0) return Typed.Invalid("That doesn't look like a whole invite code (XXXX-XXXX-XXXX).")
        return Typed.Ok(chars.chunked(4).joinToString("-"))
    }
}

/** Decodes a QR code from a camera frame's luminance (Y) plane. Pure zxing, so it runs on the JVM too. */
object QrDecoder {
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)

    fun decode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? = try {
        val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (_: ReaderException) {
        null // no code in this frame, or it couldn't be read
    }

    /**
     * Decodes a QR code from a still image's ARGB pixels (a screenshot or photo picked from the gallery). Tries both
     * binarizers and the inverted image (light-on-dark codes), since a picked image gets only one attempt.
     */
    fun decodeArgb(pixels: IntArray, width: Int, height: Int): String? {
        val source: LuminanceSource = RGBLuminanceSource(width, height, pixels)
        for (src in listOf(source, source.invert())) {
            for (bin in listOf(HybridBinarizer(src), GlobalHistogramBinarizer(src))) {
                try {
                    return QRCodeReader().decode(BinaryBitmap(bin), hints).text
                } catch (_: ReaderException) {
                    // try the next way of reading it
                }
            }
        }
        return null
    }
}
