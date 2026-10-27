package com.meldiq.android.data.account

/**
 * Two-step sign-in codes (API 0.46.0, docs/ACCOUNT_SAFETY.md): six digits from an authenticator app, or one of the ten
 * backup codes shown when it was turned on (`ABCDE-FGHJK`). The server decides whether a code is right; this only
 * decides when the button can be pressed.
 */
object TwoStepRules {
    const val APP_CODE_DIGITS = 6
    const val BACKUP_CODE_LENGTH = 10

    /** What is sent: spaces removed, a backup code upper-cased with its dash kept where it was typed. */
    fun clean(code: String): String = code.replace(Regex("\\s"), "").uppercase()

    fun isCode(code: String): Boolean {
        val c = clean(code)
        if (c.length == APP_CODE_DIGITS && c.all(Char::isDigit)) return true
        val letters = c.replace("-", "")
        return letters.length == BACKUP_CODE_LENGTH && letters.all(Char::isLetterOrDigit)
    }
}
