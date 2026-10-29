package com.meldiq.android.data.account

import com.meldiq.android.crypto.Canonical
import com.meldiq.android.crypto.Ed25519
import com.meldiq.android.crypto.LocalKeys
import com.meldiq.android.crypto.SessionInfo
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.ApiException

/** Keys and account kept in memory instead of the Keystore-sealed preferences. */
class MemoryVault(var record: AccountRecord? = null, var localKeys: LocalKeys? = null) : AccountVault {
    override fun account() = record
    override fun saveAccount(a: AccountRecord?) {
        record = a
    }
    override fun keys() = localKeys
    override fun saveKeys(k: LocalKeys) {
        localKeys = k
    }
}

class FakeMessagingSession(override var current: SessionInfo? = null) : MessagingSession {
    var signOuts = 0
    override fun signIn(info: SessionInfo) {
        current = info
    }
    override fun updateToken(token: String, expiresAt: Long) {
        current = current?.copy(token = token, tokenExpiresAt = expiresAt)
    }
    override fun signOutKeepingData() {
        current = null
        signOuts++
    }
}

/**
 * A small stand-in for the server's account module (server/src/accounts): it checks passwords, codes, device proofs and
 * certificates with the real signature code, so the app's account logic is tested against the same rules.
 */
class FakeAccountApi : AccountApi {
    class Account(
        val id: String,
        var email: String,
        var password: String,
        var name: String,
        var verified: Boolean = false,
        var identityKey: String? = null,
        var userId: String? = null,
        var username: String? = null,
        val devices: MutableMap<String, String> = mutableMapOf(), // device id → signing key
        val revoked: MutableSet<String> = mutableSetOf(),
        var legacyLinked: Boolean = false,
        /** The key backup, and the password it was saved under (a later change makes it stale, like the server). */
        var keyBackup: KeyBackupDto? = null,
        var keyBackupPassword: String? = null,
        /** Two-step sign-in (API 0.46.0): the one code this fake accepts when set. */
        var totpCode: String? = null,
    )

    val accounts = mutableMapOf<String, Account>()
    /** Legacy (pre-2.0) accounts: username → identity key and user id. */
    val legacyUsers = mutableMapOf<String, Pair<String, String>>()
    val calls = mutableListOf<String>()
    var refreshFailure: ApiException? = null
    var refreshes = 0
    private var signedIn: Account? = null
    private var boundDevice: String? = null
    private var counter = 0
    private val nonces = mutableSetOf<String>()
    private val tickets = mutableMapOf<String, String>() // ticket → legacy user id

    private fun next(prefix: String) = "${prefix}_${++counter}"
    private fun dto(a: Account) = AccountDto(a.id, a.email, a.name, legacyLinkedAt = if (a.legacyLinked) 1 else null,
        identity = a.identityKey?.let { IdentityDto(a.userId!!, a.username!!, it) })
    private fun session(a: Account, deviceId: String?): AccountSessionRes {
        signedIn = a
        boundDevice = deviceId
        return AccountSessionRes(next("access"), 1_000, next("refresh"), 2_000, SessionDto(next("s"), deviceId), dto(a))
    }
    private fun current(): Account = signedIn ?: throw ApiException(401, "unauthorized", "Authentication required")

    /** The signed-in account, for [FakeKeyBackupApi]. */
    internal fun signedInAccount(): Account = current()
    private fun consume(nonce: String) {
        if (!nonces.remove(nonce)) throw ApiException(401, "invalid_proof", "The challenge expired")
    }

    override suspend fun register(serverUrl: String, req: RegisterReq): VerificationSentRes {
        calls += "register"
        if (accounts.values.none { it.email == req.email }) accounts[req.email] = Account(next("acc"), req.email, req.password, req.name)
        return VerificationSentRes("verification_sent", req.email)
    }

    override suspend fun verifyEmail(serverUrl: String, email: String, code: String, password: String) {
        calls += "verify"
        val a = accounts[email]
        if (a == null || code != CODE || password != a.password) throw ApiException(400, "invalid_code", "That code isn't right")
        a.verified = true
    }

    override suspend fun resendVerification(serverUrl: String, email: String) {
        calls += "resend"
    }

    override suspend fun login(serverUrl: String, req: AccountLoginReq): AccountSessionRes {
        calls += if (req.device != null) "login+device" else "login"
        val a = accounts[req.email]?.takeIf { it.password == req.password } ?: throw ApiException(401, "invalid_credentials", "No match")
        if (!a.verified) throw ApiException(403, "email_unverified", "Verify first")
        a.totpCode?.let { expected ->
            if (req.totpCode == null) throw ApiException(401, "totp_required", "Enter the code from your authenticator app.")
            if (req.totpCode != expected) throw ApiException(401, "totp_invalid", "That code isn't right.")
        }
        val proof = req.device ?: return session(a, null)
        val key = a.devices[proof.deviceId]
        if (key == null || !Ed25519.verify(key.unb64(), Canonical.authProof("login", proof.nonce, key).toByteArray(), proof.signature.unb64())) {
            throw ApiException(401, "invalid_device_proof", "Not this account's device")
        }
        consume(proof.nonce)
        if (proof.deviceId in a.revoked) throw ApiException(401, "device_revoked", "Removed")
        return session(a, proof.deviceId)
    }

    /** Passkeys (2026-10-23): credential id → account email. The platform prompt is faked by the test. */
    val passkeyOwners = mutableMapOf<String, String>()

    override suspend fun passkeyLoginOptions(serverUrl: String): PasskeyOptionsRes {
        calls += "passkey-options"
        return PasskeyOptionsRes(next("ch"), kotlinx.serialization.json.buildJsonObject { put("challenge", kotlinx.serialization.json.JsonPrimitive("c")) })
    }

    override suspend fun passkeyLogin(serverUrl: String, req: PasskeyLoginReq): AccountSessionRes {
        calls += if (req.device != null) "passkey+device" else "passkey"
        val id = (req.response["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val a = passkeyOwners[id]?.let { accounts[it] } ?: throw ApiException(401, "passkey_unknown", "Unknown passkey")
        val proof = req.device ?: return session(a, null)
        val key = a.devices[proof.deviceId]
        if (key == null || !Ed25519.verify(key.unb64(), Canonical.authProof("login", proof.nonce, key).toByteArray(), proof.signature.unb64())) {
            throw ApiException(401, "invalid_device_proof", "Not this account's device")
        }
        consume(proof.nonce)
        return session(a, proof.deviceId)
    }

    override suspend fun refresh(serverUrl: String, refreshToken: String): AccountSessionRes {
        calls += "refresh"
        refreshes++
        refreshFailure?.let { throw it }
        return session(current(), boundDevice)
    }

    override suspend fun forgotPassword(serverUrl: String, email: String) {
        calls += "forgot"
    }

    override suspend fun resetPassword(serverUrl: String, req: ResetPasswordReq) {
        calls += "reset"
        val a = accounts[req.email] ?: throw ApiException(400, "invalid_code", "No")
        if (req.code != RESET_CODE) throw ApiException(400, "invalid_code", "No")
        a.password = req.newPassword
    }

    override suspend fun challenge(serverUrl: String): String = next("nonce-0123456789abcdef").also { nonces += it }

    override suspend fun legacyVerify(serverUrl: String, req: LegacyVerifyReq): LegacyVerifyRes {
        calls += "legacyVerify"
        val (identityKey, userId) = legacyUsers[req.username] ?: throw ApiException(401, "legacy_verification_failed", "No match")
        if (!Ed25519.verify(identityKey.unb64(), Canonical.legacyMigration(req.username, req.nonce).toByteArray(), req.signature.unb64())) {
            throw ApiException(401, "legacy_verification_failed", "No match")
        }
        consume(req.nonce)
        val t = next("ticket")
        tickets[t] = userId
        return LegacyVerifyRes(t, 9_999, LegacyUserDto(req.username, "Legacy Person"))
    }

    override suspend fun legacyComplete(serverUrl: String, req: LegacyCompleteReq): VerificationSentRes {
        calls += "legacyComplete"
        val userId = tickets[req.ticket] ?: throw ApiException(401, "invalid_ticket", "Expired")
        val (username, legacy) = legacyUsers.entries.first { it.value.second == userId }.let { it.key to it.value }
        accounts[req.email] = Account(next("acc"), req.email, req.password, req.name, identityKey = legacy.first, userId = userId, username = username, legacyLinked = true)
        return VerificationSentRes("verification_sent", req.email)
    }

    override suspend fun logout() {
        calls += "logout"
        signedIn = null
    }

    override suspend fun me(): AccountMeRes = AccountMeRes(dto(current()), SessionDto("s", boundDevice))

    override suspend fun updateName(name: String): AccountDto = dto(current().also { it.name = name })

    override suspend fun changePassword(req: ChangePasswordReq) {
        val a = current()
        if (a.password != req.currentPassword) throw ApiException(401, "invalid_credentials", "No")
        a.password = req.newPassword
        req.keyBackup?.let { a.keyBackup = it; a.keyBackupPassword = req.newPassword }
    }

    override suspend fun deleteAccount(req: DeleteAccountReq): DeleteAccountRes {
        calls += "delete"
        val a = current()
        if (a.password != req.password) throw ApiException(401, "invalid_credentials", "No")
        if (a.email != req.confirmEmail) throw ApiException(400, "confirm_mismatch", "No")
        return DeleteAccountRes(deleted = true, deletedAt = 1)
    }

    override suspend fun sessions(): List<SessionListItem> = listOf(SessionListItem("s", "test", boundDevice, current = true))

    override suspend fun revokeSession(id: String) = Unit

    /** The next enroll fails like a lost connection (after the app saved its new keys). */
    var failNextEnroll = false

    override suspend fun enroll(req: EnrollDeviceReq): EnrollRes {
        calls += "enroll"
        if (failNextEnroll) {
            failNextEnroll = false
            throw ApiException(0, "network", "Can't reach the server")
        }
        val a = current()
        val created = a.identityKey == null
        val identity = a.identityKey ?: req.identityKey ?: throw ApiException(400, "identity_required", "Send the identity key")
        if (req.identityKey != null && req.identityKey != identity) throw ApiException(409, "identity_mismatch", "Has keys")
        val d = req.device
        if (!Ed25519.verify(identity.unb64(), Canonical.deviceCert(identity, d.signingKey, d.encryptionKey).toByteArray(), d.certificate.unb64())) {
            throw ApiException(401, "invalid_certificate", "Not certified")
        }
        val purpose = if (created) "register" else "add-device"
        if (!Ed25519.verify(d.signingKey.unb64(), Canonical.authProof(purpose, req.nonce, d.signingKey).toByteArray(), req.signature.unb64())) {
            throw ApiException(401, "invalid_proof", "Bad proof")
        }
        consume(req.nonce)
        if (created) {
            a.identityKey = identity
            a.userId = next("u")
            a.username = req.username ?: "user${counter}"
        }
        val existing = a.devices.entries.firstOrNull { it.value == d.signingKey }?.key
        val deviceId = existing ?: next("d").also { a.devices[it] = d.signingKey }
        boundDevice = deviceId
        return EnrollRes(a.userId!!, deviceId, a.username!!, if (created) "identity" else if (existing != null) "existing" else "device")
    }

    override suspend fun resetIdentity(req: ResetIdentityReq): EnrollRes {
        calls += "resetIdentity"
        val a = current()
        if (a.password != req.password) throw ApiException(401, "invalid_credentials", "No")
        consume(req.nonce)
        a.revoked += a.devices.keys
        a.identityKey = req.identityKey
        val deviceId = next("d").also { a.devices[it] = req.device.signingKey }
        boundDevice = deviceId
        return EnrollRes(a.userId!!, deviceId, a.username!!, "identity")
    }

    override suspend fun workspaces(): WorkspacesRes = WorkspacesRes(listOf(WorkspaceDto("personal", "personal", "Personal", "OWNER")), "personal")

    override suspend fun selectWorkspace(id: String): String = id

    /** An account that already verified its address (as after sign-up and the code). */
    fun verifiedAccount(email: String, password: String = PASSWORD): Account =
        Account(next("acc"), email, password, "Test").also { it.verified = true; accounts[email] = it }

    companion object {
        const val CODE = "123456"
        const val RESET_CODE = "ABCDEFGHJK"
        const val PASSWORD = "correct horse battery"
        const val URL = "https://meldiq.test"
    }
}

/**
 * The server's key backup (docs/KEY_BACKUP.md) for [FakeAccountApi]'s signed-in account; the emailed code is
 * [UNLOCK_CODE]. With [delivery] set the account is console-made (API 0.63.0): [FIXED_CODE] works, or no code is needed.
 */
class FakeKeyBackupApi(private val accounts: FakeAccountApi) : KeyBackupApi {
    private var pending: String? = null
    var delivery = UnlockDelivery.Email
    /** Codes sent to the inbox, as the server's mailer would. */
    var emailed = 0

    private fun usable(a: FakeAccountApi.Account): KeyBackupDto? =
        a.keyBackup?.takeIf { a.keyBackupPassword == a.password && it.identityKey == a.identityKey }

    override suspend fun status(): KeyBackupStatus = KeyBackupStatus(usable(accounts.signedInAccount()) != null, 1)

    override suspend fun save(password: String, backup: KeyBackupDto): KeyBackupSaved {
        val a = accounts.signedInAccount()
        if (password != a.password) throw ApiException(401, "invalid_credentials", "No")
        if (backup.identityKey != a.identityKey) throw ApiException(409, "identity_mismatch", "Not these keys")
        a.keyBackup = backup
        a.keyBackupPassword = password
        return KeyBackupSaved(1)
    }

    override suspend fun remove() {
        accounts.signedInAccount().keyBackup = null
    }

    override suspend fun startUnlock(): KeyUnlockStarted {
        usable(accounts.signedInAccount()) ?: throw ApiException(404, "no_key_backup", "None")
        pending = UNLOCK_CODE.takeIf { delivery == UnlockDelivery.Email } ?: FIXED_CODE.takeIf { delivery == UnlockDelivery.FixedCode } ?: ""
        if (delivery == UnlockDelivery.Email) emailed++
        return KeyUnlockStarted("a***e@example.com", 0, delivery)
    }

    override suspend fun unlock(code: String?): KeyBackupDto {
        val wanted = pending ?: throw ApiException(400, "invalid_code", "No")
        if (delivery != UnlockDelivery.None && code != wanted) throw ApiException(400, "invalid_code", "No")
        pending = null
        return usable(accounts.signedInAccount()) ?: throw ApiException(404, "no_key_backup", "None")
    }

    companion object {
        const val UNLOCK_CODE = "654321"
        const val FIXED_CODE = "246810"
    }
}
