package com.meldiq.android.ui.scan

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** T4.2: the in-app scanner accepts only Griip invite codes, and decodes the QR codes the invite screen draws. */
class InviteScanTest {
    @Test
    fun acceptsTheInviteLinkTheSharedTextAndABareCode() {
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("griip://invite/ABCD-EFGH-JK23"))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("GRIIP://INVITE/abcdefghjk23"))
        assertEquals(
            "ABCD-EFGH-JK23",
            InviteCodes.fromScan("Join Acme on Griip Message with invite code ABCD-EFGH-JK23 (griip://invite/ABCD-EFGH-JK23)"),
        )
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("  abcd-efgh-jk23\n"))
    }

    @Test
    fun drawsMeldiqLinksAndStillReadsTheOlderOnes() {
        // Shared links are web links to web.meldiq.app (as Meldiq Web), which open the app when it's installed.
        assertEquals("https://web.meldiq.app/invite/ABCD-EFGH-JK23", InviteCodes.link("ABCD-EFGH-JK23"))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("https://web.meldiq.app/invite/abcd-efgh-jk23"))
        assertEquals(true, InviteCodes.isInviteLink("https", "web.meldiq.app", "/invite/ABCD-EFGH-JK23"))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("https://www.meldiq.app/invite/abcd-efgh-jk23"))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("meldiq://invite/ABCD-EFGH-JK23"))
        assertNull(InviteCodes.fromScan("https://evil.example/invite/ABCD-EFGH-JK23"))
        assertNull(InviteCodes.fromScan("https://meldiq.app.evil.example/invite/ABCD-EFGH-JK23"))
        assertEquals(true, InviteCodes.isInviteLink("https", "meldiq.app", "/invite/ABCD-EFGH-JK23"))
        assertEquals(false, InviteCodes.isInviteLink("https", "meldiq.app", "/settings"))
        assertEquals(false, InviteCodes.isInviteLink("http", "meldiq.app", "/invite/ABCD-EFGH-JK23"))
        assertEquals(true, InviteCodes.isInviteLink("meldiq", "invite", "/ABCD-EFGH-JK23"))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan(InviteCodes.link("ABCD-EFGH-JK23")))
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("MELDIQ://INVITE/abcdefghjk23"))
        assertEquals(
            "ABCD-EFGH-JK23",
            InviteCodes.extract("Join Acme on Meldiq with invite code ABCD-EFGH-JK23 (meldiq://invite/ABCD-EFGH-JK23)"),
        )
        // Invitations from Orbit and Griip Message keep working.
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan("griip://invite/ABCD-EFGH-JK23"))
        assertEquals(setOf("meldiq", "griip"), InviteCodes.LINK_SCHEMES)
        assertNull(InviteCodes.fromScan("orbit://invite/ABCD-EFGH-JK23"))
    }

    @Test
    fun refusesAnythingThatIsNotAGriipInvite() {
        for (s in listOf(
            "https://example.com/invite/ABCD-EFGH-JK23", // a web link is never followed
            "http://griip.invalid/ABCDEFGHJK23",
            "griip://invite/ABC", // too short
            "WIFI:S:office;T:WPA;P:secret;;",
            "hello world",
            "",
        )) assertNull(s, InviteCodes.fromScan(s))
    }

    @Test
    fun decodesTheQrCodeTheInviteScreenDraws() {
        val text = "griip://invite/ABCD-EFGH-JK23"
        val (lum, w, h) = render(text, scale = 4, quiet = 40)
        val decoded = QrDecoder.decode(lum, w, w, h)
        assertEquals(text, decoded)
        assertEquals("ABCD-EFGH-JK23", InviteCodes.fromScan(decoded!!))
    }

    @Test
    fun decodesFromAPaddedCameraRow() {
        // Camera planes often have a row stride wider than the image.
        val (lum, w, h) = render("griip://invite/WXYZ-2345-6789", scale = 3, quiet = 30)
        val stride = w + 64
        val padded = ByteArray(stride * h) { 0x7F }
        for (y in 0 until h) System.arraycopy(lum, y * w, padded, y * stride, w)
        assertEquals("griip://invite/WXYZ-2345-6789", QrDecoder.decode(padded, stride, w, h))
    }

    @Test
    fun aFrameWithoutACodeGivesNull() {
        assertNull(QrDecoder.decode(ByteArray(320 * 240) { (it % 251).toByte() }, 320, 320, 240))
    }

    @Test
    fun pastedMessagesAndLinksYieldTheirCode() {
        // The invite screen's share text, pasted whole into the code field (physical-device report).
        assertEquals("KXPN-52PW-EGYX", InviteCodes.extract("Join GriipBuddy on Griip Message with invite code KXPN-52PW-EGYX (griip://invite/KXPN-52PW-EGYX)"))
        assertEquals("KXPN-52PW-EGYX", InviteCodes.extract("my code is kxpn-52pw-egyx thanks"))
        // Orbit's share text: same link, so codes shared by either app work in both.
        assertEquals("KXPN-52PW-EGYX", InviteCodes.extract("Join GriipBuddy on Orbit with invite code KXPN-52PW-EGYX (griip://invite/KXPN-52PW-EGYX)"))
        assertNull(InviteCodes.extract("two codes ABCD-EFGH-JK23 and WXYZ-2345-6789")) // ambiguous: ask, don't guess
        assertNull(InviteCodes.extract("https://evil.example/ABCD-EFGH-JK23/x")) // part of a web link
    }

    @Test
    fun typedCodesAreNormalisedButNeverReinterpreted() {
        assertEquals(InviteCodes.Typed.Ok("XFG6-3KAJ-EQ3J"), InviteCodes.check("XFG6-3KAJ-EQ3J"))
        assertEquals(InviteCodes.Typed.Ok("XFG6-3KAJ-EQ3J"), InviteCodes.check(" xfg6 3kaj eq3j "))
        assertEquals(InviteCodes.Typed.Ok("XFG6-3KAJ-EQ3J"), InviteCodes.check("xfg63kajeq3j"))
        assertEquals(InviteCodes.Typed.Incomplete, InviteCodes.check("XFG6-3KA"))
        assertEquals(InviteCodes.Typed.Incomplete, InviteCodes.check(""))
        // O, 0, I, 1 and L never occur in codes: report them instead of silently swapping letters and digits.
        val wrong = InviteCodes.check("XFG6-3KAJ-EQ30") as InviteCodes.Typed.Invalid
        assertTrue(wrong.reason.contains("0"))
        assertTrue(InviteCodes.check("XFG6-3KAJ-EQ3JX") is InviteCodes.Typed.Invalid) // 13 characters
    }

    @Test
    fun decodesAnInviteQrFromAScreenshotsPixels() {
        // Gallery import: ARGB pixels of a screenshot (dark-on-light), and a light-on-dark rendering.
        val text = "griip://invite/XFG6-3KAJ-EQ3J"
        val (lum, w, h) = render(text, scale = 6, quiet = 48)
        val argb = IntArray(w * h) { val v = lum[it].toInt() and 0xFF; (0xFF shl 24) or (v shl 16) or (v shl 8) or v }
        assertEquals(text, QrDecoder.decodeArgb(argb, w, h))
        val inverted = IntArray(w * h) { argb[it] xor 0x00FFFFFF }
        assertEquals(text, QrDecoder.decodeArgb(inverted, w, h))
        assertEquals("XFG6-3KAJ-EQ3J", InviteCodes.fromScan(QrDecoder.decodeArgb(argb, w, h)!!))
    }

    @Test
    fun aPictureWithoutACodeOrWithAWebLinkIsRefused() {
        assertNull(QrDecoder.decodeArgb(IntArray(300 * 200) { 0xFF336699.toInt() }, 300, 200))
        val (lum, w, h) = render("https://example.com/invite/XFG6-3KAJ-EQ3J", scale = 5, quiet = 40)
        val argb = IntArray(w * h) { val v = lum[it].toInt() and 0xFF; (0xFF shl 24) or (v shl 16) or (v shl 8) or v }
        val decoded = QrDecoder.decodeArgb(argb, w, h)!!
        assertNull(InviteCodes.fromScan(decoded)) // a QR code, but not an invite: never opened
    }

    /** Renders [text] as a QR code into an 8-bit luminance image (dark = 0, light = 255). */
    private fun render(text: String, scale: Int, quiet: Int): Triple<ByteArray, Int, Int> {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0)
        val w = m.width * scale + 2 * quiet
        val h = m.height * scale + 2 * quiet
        val out = ByteArray(w * h) { 0xFF.toByte() }
        for (y in 0 until m.height) for (x in 0 until m.width) if (m[x, y]) {
            for (dy in 0 until scale) for (dx in 0 until scale) out[(quiet + y * scale + dy) * w + quiet + x * scale + dx] = 0
        }
        return Triple(out, w, h)
    }
}
