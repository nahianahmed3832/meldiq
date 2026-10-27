package com.meldiq.android.data.account

import kotlinx.serialization.json.jsonObject
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.crypto.Canonical
import com.meldiq.android.crypto.KeyBackupCrypto
import com.meldiq.android.crypto.LocalKeys
import com.meldiq.android.crypto.SessionInfo
import com.meldiq.android.crypto.b64
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where this phone's account and keys are kept: [com.meldiq.android.crypto.IdentityStore] in the app, a map in tests. */
interface AccountVault {
    fun account(): AccountRecord?
    fun saveAccount(a: AccountRecord?)
    fun keys(): LocalKeys?
    fun saveKeys(k: LocalKeys)
}

/**
 * The messaging session the rest of the app runs on ([com.meldiq.android.data.repo.SessionRepository]): signed in once
 * this phone's account session is bound to its device keys.
 */
interface MessagingSession {
    val current: SessionInfo?
    fun signIn(info: SessionInfo)
    fun updateToken(token: String, expiresAt: Long)
    /** Ends the session but keeps this phone's keys and messages, so signing in again picks up where it left off. */
    fun signOutKeepingData()
}

/** Where this phone stands with its Orbit 2.0 account. */
sealed interface AccountPhase {
    /** No account on this profile (a fresh install, or a legacy install not moved yet). */
    data object None : AccountPhase

    data class AwaitingVerification(val email: String) : AccountPhase

    /** Signed in, but this phone has no encryption keys for the account yet. */
    data class NeedsDeviceSetup(val account: AccountDto) : AccountPhase

    data class Ready(val account: AccountDto) : AccountPhase

    /** The session ended (signed out, expired or revoked); the keys and messages are still here. */
    data class SignedOut(val email: String, val reason: String?) : AccountPhase
}

/** Sign-in attempts when the device proof's challenge expires on the way (a slow network). */
private const val CHALLENGE_TRIES = 2

/** Tokens renewed this recently are current: a 401 queued behind that renewal retries with them instead of renewing again. */
private const val RECENT_RENEWAL_MS = 10_000L

/** [AccountRepository.login] refuses another account on a profile that holds one's keys and messages. */
const val OTHER_ACCOUNT_HERE = "other_account_here"

/** Server answers that end a session for good: the person signs in again. */
private val SESSION_ENDED = setOf("session_expired", "session_revoked", "account_disabled")
/** Server answers to a device proof that the phone's device key can't be used any more. */
private val DEVICE_UNUSABLE = setOf("invalid_device_proof", "device_revoked")

/**
 * Orbit 2.0 accounts on this phone (docs/ORBIT_2_ARCHITECTURE §2–3): sign-up with an emailed code, sign-in, token
 * renewal, sign-out, and setting up encryption on this phone afterwards ([DeviceSetup]). The server decides; this keeps
 * the tokens (sealed by the Keystore) and turns its answers into [phase]. Unit-tested in `AccountRepositoryTest`.
 */
class AccountRepository(
    private val api: AccountApi,
    private val vault: AccountVault,
    private val session: MessagingSession,
    private val deviceName: () -> String,
    private val clock: () -> Long = System::currentTimeMillis,
    private val keyBackups: KeyBackupApi? = null,
) {
    private val _phase = MutableStateFlow(initialPhase())
    val phase: StateFlow<AccountPhase> = _phase.asStateFlow()

    /** The recovery key of an identity this phone just created: shown once, then [recoveryKeyShown]. */
    private val _newRecoveryKey = MutableStateFlow<String?>(null)
    val newRecoveryKey: StateFlow<String?> = _newRecoveryKey.asStateFlow()

    /** A brand-new account on this phone: offered how to start (personal, create or join an organisation) once. */
    private val _startChoice = MutableStateFlow(false)
    val startChoice: StateFlow<Boolean> = _startChoice.asStateFlow()

    private val refreshLock = Mutex()
    @Volatile private var renewedAt = 0L
    val devices = DeviceSetup(api, vault, this, deviceName, keyBackups)

    /** The current access token, also before this phone has keys (device setup, workspaces). */
    val accessToken: String? get() = vault.account()?.tokens?.accessToken
    val record: AccountRecord? get() = vault.account()

    private fun initialPhase(): AccountPhase {
        val r = vault.account() ?: return AccountPhase.None
        val account = r.account
        return when {
            r.pendingVerification -> AccountPhase.AwaitingVerification(r.email)
            r.tokens == null || account == null -> AccountPhase.SignedOut(r.email, null)
            session.current != null && r.deviceId != null -> AccountPhase.Ready(account)
            else -> AccountPhase.NeedsDeviceSetup(account)
        }
    }

    /**
     * The account this phone holds was recovered with a recovery code and now uses [newEmail] (docs/ACCOUNT_RECOVERY.md).
     * The recovery itself proved control of the account under [oldEmail], so the profile follows it to the new address;
     * signing in still proves this phone's device key. Any other account's recovery changes nothing here.
     */
    fun addressRecovered(oldEmail: String, newEmail: String) {
        val r = vault.account() ?: return
        val old = AccountRules.normalizeEmail(oldEmail)
        if (AccountRules.normalizeEmail(r.email) != old) return
        val address = AccountRules.normalizeEmail(newEmail)
        vault.saveAccount(r.copy(email = address, tokens = null))
        _phase.value = AccountPhase.SignedOut(address, null)
    }

    // ───────────── Sign-up ─────────────

    suspend fun register(serverUrl: String, name: String, email: String, password: String, inviteCode: String?) {
        val address = AccountRules.normalizeEmail(email)
        requireProfileFor(address)
        api.register(serverUrl, RegisterReq(name.trim(), address, password, inviteCode?.trim()?.takeIf { it.isNotEmpty() }))
        awaitVerification(serverUrl, address, deviceId = null)
    }

    /**
     * One account per profile: a profile holding keys (and so messages) belongs to the account they were made for. Another
     * account can't sign up, move or sign in here until the profile is erased. [legacyOwner]: the keys belong to the
     * legacy account this phone is signed in to, which is moving to [email].
     */
    internal fun requireProfileFor(email: String, legacyOwner: Boolean = false) {
        val keys = vault.keys() ?: return
        val here = vault.account()
        if (here?.email == email || (here == null && legacyOwner)) return
        val owner = here?.email ?: session.current?.username?.let { "@$it" } ?: "another account"
        if (keys.identitySeed.isNotEmpty()) {
            throw ApiException(409, OTHER_ACCOUNT_HERE, "This phone holds the messages of $owner. Sign in with that account, or erase this phone first.")
        }
    }

    /** After sign-up or a legacy move: the account exists and waits for the emailed code. */
    internal fun awaitVerification(serverUrl: String, email: String, deviceId: String?, legacyOwner: Boolean = false) {
        requireProfileFor(email, legacyOwner)
        vault.saveAccount(AccountRecord(serverUrl, email, deviceId = deviceId, pendingVerification = true))
        _phase.value = AccountPhase.AwaitingVerification(email)
    }

    /** The code went through earlier (a sign-in after it failed): only the sign-in is left to do. */
    val verified: Boolean get() = vault.account()?.pendingVerification == false

    /** The emailed code, with the password chosen at sign-up (the server checks both). */
    suspend fun verifyEmail(code: String, password: String) {
        val r = vault.account() ?: throw ApiException(400, "no_account", "Sign up first.")
        api.verifyEmail(r.serverUrl, r.email, AccountRules.cleanVerifyCode(code), password)
        vault.saveAccount(r.copy(pendingVerification = false))
    }

    /** "Use another email" during a move or sign-up: forgets the unfinished account on this phone (the server lets it be redone). */
    fun abandonPending() {
        val r = vault.account() ?: return
        if (r.tokens != null) return
        vault.saveAccount(null)
        _phase.value = AccountPhase.None
    }

    suspend fun resendVerification() {
        val r = vault.account() ?: return
        api.resendVerification(r.serverUrl, r.email)
    }

    /** Back from the code screen to sign-up or sign-in: nothing on this phone waits for a code any more. */
    fun cancelVerification() {
        val r = vault.account() ?: return
        if (!r.pendingVerification) return
        vault.saveAccount(if (r.deviceId == null) null else r.copy(pendingVerification = false))
        _phase.value = if (r.deviceId == null) AccountPhase.None else AccountPhase.SignedOut(r.email, null)
    }

    // ───────────── Sign-in ─────────────

    /**
     * Signs in. When this phone already has keys for the account, its device key proves it and the session is bound at
     * once; otherwise [DeviceSetup] takes over (automatically for a new account or this phone's own identity).
     */
    /** [totpCode]: the second step when the account has two-step sign-in on (`totp_required` without it). */
    suspend fun login(serverUrl: String, email: String, password: String, totpCode: String? = null) {
        val address = AccountRules.normalizeEmail(email)
        val here = vault.account()
        val keys = vault.keys()
        // A legacy installation signing in to the account it moved to: its own device key must prove it.
        val legacyDevice = session.current?.deviceId?.takeIf { here == null && keys != null }
        requireProfileFor(address, legacyOwner = legacyDevice != null)
        devices.rememberPassword(password)
        val r = here?.takeIf { it.email == address && it.serverUrl == serverUrl }
        val deviceId = r?.deviceId ?: legacyDevice
        var deviceUnusable = false
        val res = try {
            loginWithProof(serverUrl, address, password, deviceId?.let { id -> keys?.let { id to it } }, totpCode)
        } catch (e: ApiException) {
            if (deviceId == null || e.code !in DEVICE_UNUSABLE) throw e
            // Keys for another account must never be set up under this one.
            if (legacyDevice != null) throw ApiException(409, OTHER_ACCOUNT_HERE, "This phone holds another account's messages. Sign in with the account you moved, or erase this phone first.")
            // This phone's device was removed: sign in, then set it up again with new device keys.
            deviceUnusable = true
            api.login(serverUrl, AccountLoginReq(address, password, deviceName(), null, totpCode))
        }
        adopt(serverUrl, res, keepDevice = !deviceUnusable)
    }

    /**
     * Signs in with a passkey (2026-10-23, docs/PASSKEYS.md). [assert] shows the platform's passkey prompt for the
     * server's options (WebAuthn JSON) and returns its answer. When this phone holds an account's keys for this server,
     * its device key proves it as with a password; if the passkey belongs to another account that proof is refused, and
     * the sign-in is tried once more without it (a second prompt), after which keys of another account still stop it.
     */
    suspend fun loginWithPasskey(serverUrl: String, assert: suspend (String) -> String) {
        val here = vault.account()?.takeIf { it.serverUrl == serverUrl }
        val keys = vault.keys()
        val device = here?.deviceId?.let { id -> keys?.let { id to it } }
        devices.rememberPassword(null)
        suspend fun attempt(proveDevice: Boolean): AccountSessionRes {
            val o = api.passkeyLoginOptions(serverUrl)
            val answer = GriipJson.parseToJsonElement(assert(o.options.toString())).jsonObject
            val proof = if (proveDevice) device?.let { deviceProof(serverUrl, it.first, it.second) } else null
            return api.passkeyLogin(serverUrl, PasskeyLoginReq(o.challengeId, answer, deviceName(), proof))
        }
        var provedDevice = device != null
        val res = try {
            attempt(provedDevice)
        } catch (e: ApiException) {
            if (!provedDevice || e.code !in DEVICE_UNUSABLE) throw e
            provedDevice = false
            attempt(false)
        }
        // Keys for another account must never be set up under this one (the same rule as a password sign-in).
        requireProfileFor(res.account.email)
        adopt(serverUrl, res, keepDevice = provedDevice || here?.email == res.account.email)
    }

    /** This account's passkeys, and whether its server offers them. */
    suspend fun passkeys(): PasskeyListRes = api.passkeys()

    /** Adds a passkey: [create] shows the platform's create-passkey prompt for the server's options and returns its answer. */
    suspend fun addPasskey(name: String, create: suspend (String) -> String): PasskeyDto {
        val o = api.passkeyRegisterOptions()
        val answer = GriipJson.parseToJsonElement(create(o.options.toString())).jsonObject
        return api.addPasskey(PasskeyRegisterReq(o.challengeId, answer, name.trim().take(80).ifEmpty { null })).passkey
    }

    suspend fun removePasskey(id: String) = api.removePasskey(id)

    /** Signs in, proving [device]'s key when given; a challenge that expired on the way is asked for again once. */
    private suspend fun loginWithProof(serverUrl: String, email: String, password: String, device: Pair<String, LocalKeys>?, totpCode: String?): AccountSessionRes {
        repeat(CHALLENGE_TRIES - 1) {
            try {
                return api.login(serverUrl, AccountLoginReq(email, password, deviceName(), device?.let { deviceProof(serverUrl, it.first, it.second) }, totpCode))
            } catch (e: ApiException) {
                if (e.code != "challenge_expired") throw e
            }
        }
        return api.login(serverUrl, AccountLoginReq(email, password, deviceName(), device?.let { deviceProof(serverUrl, it.first, it.second) }, totpCode))
    }

    private suspend fun deviceProof(serverUrl: String, deviceId: String, keys: LocalKeys): DeviceProofDto {
        val nonce = api.challenge(serverUrl)
        return DeviceProofDto(deviceId, nonce, keys.signWithDevice(Canonical.authProof("login", nonce, keys.deviceSignPublic.b64())))
    }

    private suspend fun adopt(serverUrl: String, res: AccountSessionRes, keepDevice: Boolean) {
        val previous = vault.account()?.takeIf { it.email == res.account.email }
        val record = AccountRecord(
            serverUrl = serverUrl,
            email = res.account.email,
            account = res.account,
            deviceId = res.session.deviceId ?: previous?.deviceId?.takeIf { keepDevice },
            tokens = res.tokens(),
        )
        vault.saveAccount(record)
        val bound = res.session.deviceId
        if (bound != null) {
            bindMessaging(record, bound)
            devices.afterBoundSignIn()
        } else {
            devices.afterSignIn(res.account, deviceStale = !keepDevice)
        }
    }

    /** The session is bound to [deviceId]: the messaging app takes over with the access token. */
    internal fun bindMessaging(record: AccountRecord, deviceId: String) {
        val account = checkNotNull(record.account) { "bound without an account" }
        val identity = checkNotNull(account.identity) { "bound without an encryption identity" }
        val tokens = checkNotNull(record.tokens) { "bound without a session" }
        vault.saveAccount(record.copy(deviceId = deviceId, pendingIdentityFor = null))
        session.signIn(SessionInfo(record.serverUrl, identity.userId, deviceId, identity.username, account.name, tokens.accessToken, tokens.accessTokenExpiresAt))
        _phase.value = AccountPhase.Ready(account)
    }

    internal fun markPendingIdentity(accountId: String?) {
        vault.account()?.let { vault.saveAccount(it.copy(pendingIdentityFor = accountId)) }
    }

    internal fun needsDeviceSetup(account: AccountDto) {
        _phase.value = AccountPhase.NeedsDeviceSetup(account)
    }

    internal fun identityCreated(recoveryKey: String, newAccount: Boolean) {
        _newRecoveryKey.value = recoveryKey
        if (newAccount) _startChoice.value = true
    }

    fun recoveryKeyShown() {
        _newRecoveryKey.value = null
    }

    fun startChoiceMade() {
        _startChoice.value = false
    }

    /** The account as the server describes it now (for example after setting up encryption elsewhere). */
    suspend fun reload(): AccountDto {
        val me = api.me()
        vault.account()?.let { vault.saveAccount(it.copy(account = me.account)) }
        return me.account
    }

    // ───────────── Tokens ─────────────

    /**
     * Swaps the refresh token for new tokens: what the API client and the realtime connection do on a 401. One at a time;
     * a caller that waited while another renewed them, or that comes right after (the API client queues its 401s), uses
     * the new ones. A session the server ended signs this phone out (keeping its data); a network failure changes nothing.
     */
    suspend fun refreshTokens(): Boolean {
        val before = vault.account()?.tokens?.refreshToken ?: return false
        return refreshLock.withLock {
            val r = vault.account() ?: return@withLock false
            val tokens = r.tokens ?: return@withLock false
            if (tokens.refreshToken != before || clock() - renewedAt < RECENT_RENEWAL_MS) return@withLock true
            try {
                val res = api.refresh(r.serverUrl, tokens.refreshToken)
                vault.saveAccount(r.copy(tokens = res.tokens(), account = res.account))
                if (session.current != null) session.updateToken(res.accessToken, res.accessTokenExpiresAt)
                renewedAt = clock()
                true
            } catch (e: ApiException) {
                if (e.code in SESSION_ENDED) endSession(e.message)
                false
            }
        }
    }

    /** Signs out on the server and here; keys and messages stay, so signing in again on this phone continues. */
    suspend fun logout() {
        runCatching { api.logout() }
        endSession(null)
    }

    private fun endSession(reason: String?) {
        devices.rememberPassword(null)
        val r = vault.account() ?: return
        vault.saveAccount(r.copy(tokens = null))
        session.signOutKeepingData()
        _phase.value = AccountPhase.SignedOut(r.email, reason)
    }

    // ───────────── Passwords and sessions ─────────────

    suspend fun forgotPassword(serverUrl: String, email: String) = api.forgotPassword(serverUrl, AccountRules.normalizeEmail(email))

    suspend fun resetPassword(serverUrl: String, email: String, code: String, newPassword: String) =
        api.resetPassword(serverUrl, ResetPasswordReq(AccountRules.normalizeEmail(email), AccountRules.cleanResetCode(code), newPassword))

    /**
     * Changes the password. A phone with the account's keys seals them again under the new password in the same request,
     * so the key backup survives the change (docs/KEY_BACKUP.md).
     */
    suspend fun changePassword(current: String, next: String) {
        val keys = vault.keys()?.takeIf { session.current != null }
        val accountId = vault.account()?.account?.id
        val backup = if (keys != null && accountId != null) {
            withContext(Dispatchers.Default) { KeyBackupCrypto.seal(next, accountId, keys.identitySeed.unb64()) }
        } else {
            null
        }
        api.changePassword(ChangePasswordReq(current, next, backup))
    }

    /** Settings › Key backup: seals this phone's keys under [password] and saves them; the server checks the password. */
    suspend fun backUpKeys(password: String) {
        val backups = keyBackups ?: throw ApiException(404, "no_key_backup", "This server doesn't keep key backups.")
        val keys = vault.keys()?.takeIf { session.current != null } ?: throw ApiException(403, "device_required", "Set up this phone first.")
        val accountId = vault.account()?.account?.id ?: throw ApiException(401, "session_expired", "Your session has ended. Sign in again.")
        val backup = withContext(Dispatchers.Default) { KeyBackupCrypto.seal(password, accountId, keys.identitySeed.unb64()) }
        backups.save(password, backup)
    }

    suspend fun sessions(): List<SessionListItem> = api.sessions()

    /**
     * Deletes the account on the server for good (docs/ACCOUNT_DELETION.md). The caller erases this phone's copy once it
     * returns: the server has already ended every session.
     */
    suspend fun deleteAccount(password: String, typedEmail: String): DeleteAccountRes =
        api.deleteAccount(DeleteAccountReq(password, AccountRules.normalizeEmail(typedEmail)))

    suspend fun revokeSession(id: String) = api.revokeSession(id)

    suspend fun rename(name: String): AccountDto {
        val account = api.updateName(name.trim())
        vault.account()?.let { vault.saveAccount(it.copy(account = account)) }
        session.current?.let { session.signIn(it.copy(displayName = account.name)) }
        val p = _phase.value
        if (p is AccountPhase.Ready) _phase.value = AccountPhase.Ready(account)
        return account
    }
}

internal fun AccountSessionRes.tokens() = AccountTokens(session.id, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt)
