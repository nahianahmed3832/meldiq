package com.meldiq.android.data.account

import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.OkRes
import kotlinx.serialization.Serializable

/** Two-step sign-in's state (GET /v2/account/totp); [available] false: the server can't keep secrets yet. */
@Serializable
data class TotpStatus(val available: Boolean = false, val enabled: Boolean = false, val enabledAt: Long? = null, val backupCodesLeft: Int = 0)

/** Set-up: the secret (base32) and the `otpauth://` address an authenticator app takes. Off until the first code. */
@Serializable
data class TotpSetupRes(val secret: String, val uri: String)

@Serializable
data class TotpBackupCodes(val backupCodes: List<String>)

@Serializable
data class PasswordReq(val password: String)

@Serializable
data class TotpCodeReq(val code: String)

@Serializable
data class TotpDisableReq(val password: String, val code: String)

@Serializable
data class EmailChangeReq(val password: String, val newEmail: String)

@Serializable
data class EmailChangeStarted(val email: String, val expiresAt: Long)

@Serializable
data class EmailChanged(val email: String)

/** A warning from staff, with when it ends. */
@Serializable
data class StandingWarning(val id: String, val reason: String, val createdAt: Long, val expiresAt: Long)

/** Account standing: `good`, `limited`, `very_limited` or `suspended` by the number of active warnings. */
@Serializable
data class Standing(val level: String = StandingRules.GOOD, val warnings: List<StandingWarning> = emptyList())

@Serializable
data class BugReportDto(
    val id: String, val summary: String, val details: String, val page: String? = null, val status: String,
    val staffNote: String? = null, val createdAt: Long, val updatedAt: Long,
)

@Serializable
data class BugReportsRes(val reports: List<BugReportDto> = emptyList(), val bugHunter: Boolean = false)

@Serializable
data class BugReportReq(val summary: String, val details: String, val page: String? = null, val client: String? = null)

@Serializable
data class BugReportRes(val report: BugReportDto)

/**
 * Account safety (API 0.46.0, docs/ACCOUNT_SAFETY.md, as Meldiq Web's My Account): two-step sign-in, changing the email,
 * account standing and bug reports. The server checks every rule again; these only shape the calls.
 */
class AccountSafetyApi(private val api: ApiClient) {
    suspend fun totpStatus(): TotpStatus = api.get("/v2/account/totp")
    suspend fun totpSetup(password: String): TotpSetupRes = api.post("/v2/account/totp/setup", PasswordReq(password))
    suspend fun totpEnable(code: String): TotpBackupCodes = api.post("/v2/account/totp/enable", TotpCodeReq(TwoStepRules.clean(code)))
    suspend fun totpDisable(password: String, code: String) {
        api.post<TotpDisableReq, OkRes>("/v2/account/totp/disable", TotpDisableReq(password, TwoStepRules.clean(code)))
    }

    suspend fun emailChangeStart(password: String, newEmail: String): EmailChangeStarted =
        api.post("/v2/account/email", EmailChangeReq(password, AccountRules.normalizeEmail(newEmail)))
    suspend fun emailChangeConfirm(code: String): EmailChanged = api.post("/v2/account/email/confirm", TotpCodeReq(code.trim()))

    suspend fun standing(): Standing = api.get("/v2/account/standing")

    suspend fun bugReports(): BugReportsRes = api.get("/v1/bug-reports")
    suspend fun reportBug(summary: String, details: String, page: String?, client: String): BugReportDto =
        api.post<BugReportReq, BugReportRes>("/v1/bug-reports", BugReportReq(summary.trim(), details.trim(), page, client)).report
}

/** Limits as the server sets them (BugReportBody, standing levels). Unit-tested in `AccountSafetyRulesTest`. */
object StandingRules {
    const val GOOD = "good"
    const val LIMITED = "limited"
    const val VERY_LIMITED = "very_limited"
    const val SUSPENDED = "suspended"
    const val SUMMARY_MIN = 4
    const val SUMMARY_MAX = 120
    const val DETAILS_MIN = 10
    const val DETAILS_MAX = 4000

    fun canReport(summary: String, details: String): Boolean =
        summary.trim().length in SUMMARY_MIN..SUMMARY_MAX && details.trim().length in DETAILS_MIN..DETAILS_MAX

    /** The authenticator secret in groups of four, easier to type by hand. */
    fun grouped(secret: String): String = secret.chunked(4).joinToString(" ")
}
