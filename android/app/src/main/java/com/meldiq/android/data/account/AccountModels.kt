package com.meldiq.android.data.account

import kotlinx.serialization.Serializable

/*
 * Wire models of the Orbit 2.0 account API (docs/ORBIT_2_ARCHITECTURE_2026-10-18.md §6). They mirror the server's zod
 * schemas in server/src/shared/contracts/http/accounts.ts (docs/api/openapi.json). Plain Kotlin with no Android imports, so they can move into a Kotlin
 * Multiplatform module for iOS unchanged.
 */

@Serializable
data class RegisterReq(val name: String, val email: String, val password: String, val inviteCode: String? = null)

@Serializable
data class EmailReq(val email: String)

/** The password chosen at sign-up goes with the code: whoever verifies an address is whoever set its password. */
@Serializable
data class VerifyEmailReq(val email: String, val code: String, val password: String)

/** An existing device of the account proves its key by signing a fresh `/v1/auth/challenge` nonce. */
@Serializable
data class DeviceProofDto(val deviceId: String, val nonce: String, val signature: String)

@Serializable
data class AccountLoginReq(
    val email: String, val password: String, val deviceName: String? = null, val device: DeviceProofDto? = null,
    /** Two-step sign-in (API 0.46.0, docs/ACCOUNT_SAFETY.md): a code from the authenticator app or a backup code. */
    val totpCode: String? = null,
)

@Serializable
data class RefreshReq(val refreshToken: String)

@Serializable
data class ResetPasswordReq(val email: String, val code: String, val newPassword: String)

@Serializable
/** [keyBackup]: this phone's keys sealed under the new password, so the key backup keeps working (docs/KEY_BACKUP.md). */
data class ChangePasswordReq(val currentPassword: String, val newPassword: String, val keyBackup: KeyBackupDto? = null)

/** `DELETE /v2/account` (docs/ACCOUNT_DELETION.md): the password again and the account's email typed by the person. */
@Serializable
data class DeleteAccountReq(val password: String, val confirmEmail: String)

@Serializable
data class DeleteAccountRes(val deleted: Boolean = false, val deletedAt: Long = 0)

@Serializable
data class UpdateAccountReq(val name: String)

@Serializable
data class PreferencesReq(val selectedWorkspaceId: String)

/** The account's end-to-end encryption identity, once a device has set one up. */
@Serializable
data class IdentityDto(val userId: String, val username: String, val identityKey: String)

@Serializable
data class AccountDto(
    val id: String,
    val email: String,
    val name: String,
    val createdAt: Long = 0,
    val legacyLinkedAt: Long? = null,
    val selectedWorkspaceId: String? = null,
    val identity: IdentityDto? = null,
)

@Serializable
data class SessionDto(val id: String, val deviceId: String? = null, val createdAt: Long = 0)

@Serializable
data class AccountSessionRes(
    val accessToken: String,
    val accessTokenExpiresAt: Long,
    val refreshToken: String,
    val refreshTokenExpiresAt: Long,
    val session: SessionDto,
    val account: AccountDto,
)

@Serializable
data class AccountMeRes(val account: AccountDto, val session: SessionDto)

@Serializable
data class AccountUpdateRes(val account: AccountDto)

@Serializable
data class SessionListItem(
    val id: String,
    val label: String,
    val deviceId: String? = null,
    val createdAt: Long = 0,
    val lastUsedAt: Long = 0,
    val current: Boolean = false,
)

@Serializable
data class SessionListRes(val sessions: List<SessionListItem> = emptyList())

@Serializable
data class NewDeviceDto(val name: String, val signingKey: String, val encryptionKey: String, val certificate: String)

@Serializable
data class EnrollDeviceReq(
    val identityKey: String? = null,
    val username: String? = null,
    val device: NewDeviceDto,
    val nonce: String,
    val signature: String,
)

@Serializable
data class ResetIdentityReq(val password: String, val identityKey: String, val device: NewDeviceDto, val nonce: String, val signature: String)

/** `result`: "identity" (made the account's encryption identity), "device" (added a device) or "existing". */
@Serializable
data class EnrollRes(val userId: String, val deviceId: String, val username: String, val result: String)

@Serializable
data class WorkspaceDto(val id: String, val kind: String, val name: String, val role: String, val slug: String? = null) {
    val isPersonal: Boolean get() = kind == KIND_PERSONAL

    companion object {
        const val PERSONAL_ID = "personal"
        const val KIND_PERSONAL = "personal"
    }
}

@Serializable
data class WorkspacesRes(val workspaces: List<WorkspaceDto> = emptyList(), val selectedWorkspaceId: String = WorkspaceDto.PERSONAL_ID)

@Serializable
data class SelectedWorkspaceRes(val selectedWorkspaceId: String)

@Serializable
data class LegacyVerifyReq(val username: String, val nonce: String, val signature: String)

@Serializable
data class LegacyUserDto(val username: String, val displayName: String)

@Serializable
data class LegacyVerifyRes(val ticket: String, val expiresAt: Long, val legacyUser: LegacyUserDto)

@Serializable
data class LegacyCompleteReq(val ticket: String, val name: String, val email: String, val password: String)

@Serializable
data class VerificationSentRes(val status: String, val email: String? = null)

/** What server-info says about Orbit 2.0 accounts (absent on servers before 2.0). */
@Serializable
data class AccountsInfo(
    val registration: Boolean = false,
    val legacyLogin: Boolean = true,
    val legacyRegistration: Boolean = true,
    val legacyMigration: Boolean = false,
    /** The move must be done before the app opens (no "Later"); see [MigrationWindow]. */
    val legacyMigrationRequired: Boolean = false,
)

/**
 * This phone's Orbit 2.0 account for one server profile, sealed with the Keystore key ([com.meldiq.android.crypto.IdentityStore]).
 * [deviceId] stays after a session ends, so signing in again can prove this phone's device key and keep its data.
 */
@Serializable
data class AccountRecord(
    val serverUrl: String,
    val email: String,
    /** The account as the server last described it; null until the first sign-in. */
    val account: AccountDto? = null,
    val deviceId: String? = null,
    val tokens: AccountTokens? = null,
    /** Signed up (or moved from a legacy account) and waiting for the emailed code. */
    val pendingVerification: Boolean = false,
    /** The account id the keys on this phone were made for, before the server confirmed them (a retry reuses them). */
    val pendingIdentityFor: String? = null,
)

@Serializable
data class AccountTokens(
    val sessionId: String,
    val accessToken: String,
    val accessTokenExpiresAt: Long,
    val refreshToken: String,
    val refreshTokenExpiresAt: Long,
)

// ───────────── Passkeys (2026-10-23, docs/PASSKEYS.md) ─────────────

/** Options for the platform's passkey prompt (WebAuthn JSON, passed to Credential Manager as is) and this ceremony's id. */
@Serializable
data class PasskeyOptionsRes(val challengeId: String, val options: kotlinx.serialization.json.JsonObject)

@Serializable
data class PasskeyLoginReq(val challengeId: String, val response: kotlinx.serialization.json.JsonObject, val deviceName: String? = null, val device: DeviceProofDto? = null)

@Serializable
data class PasskeyRegisterReq(val challengeId: String, val response: kotlinx.serialization.json.JsonObject, val name: String? = null)

@Serializable
data class PasskeyDto(val id: String, val name: String, val createdAt: Long = 0, val lastUsedAt: Long? = null, val synced: Boolean = false)

@Serializable
data class PasskeyListRes(val available: Boolean = false, val passkeys: List<PasskeyDto> = emptyList())

@Serializable
data class PasskeyAddedRes(val passkey: PasskeyDto)
