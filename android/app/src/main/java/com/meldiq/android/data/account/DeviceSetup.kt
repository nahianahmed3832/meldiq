package com.meldiq.android.data.account

import com.meldiq.android.crypto.Canonical
import com.meldiq.android.crypto.Ed25519
import com.meldiq.android.crypto.KeyBackupCrypto
import com.meldiq.android.crypto.LocalKeys
import com.meldiq.android.crypto.RecoveryCode
import com.meldiq.android.crypto.b64
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Setting up end-to-end encryption on this phone after signing in (docs/ORBIT_2_ARCHITECTURE §3). A phone needs the
 * account's identity key: made here for a new account, already here for this phone's own account, unlocked from the
 * key backup with the password and an emailed code (docs/KEY_BACKUP.md), typed in as the recovery key, sealed over
 * from another phone (pairing), or replaced altogether ("start fresh").
 *
 * Once a phone has the keys it backs them up under the sign-in password if the account has no usable backup, so the
 * next new phone needs only the email code. The password stays in memory only, until that is done.
 */
class DeviceSetup internal constructor(
    private val api: AccountApi,
    private val vault: AccountVault,
    private val accounts: AccountRepository,
    private val deviceName: () -> String,
    private val keyBackups: KeyBackupApi? = null,
) {
    @Volatile private var signInPassword: String? = null

    /** The password just typed to sign in, for unlocking or making the key backup. */
    internal fun rememberPassword(password: String?) {
        signInPassword = password
    }

    /** Whether the sign-in password is still in memory (otherwise the unlock step asks for it). */
    val hasPassword: Boolean get() = signInPassword != null

    /** Whether the account has a backup this phone can unlock with an emailed code; null when the server couldn't say. */
    suspend fun backupAvailable(): Boolean? {
        val api = keyBackups ?: return false
        return try {
            api.status().exists
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /** Emails a code for unlocking the backup on this phone; says how the code reaches the person. */
    suspend fun startEmailUnlock(): KeyUnlockStarted = requireBackups().startUnlock()

    /**
     * The emailed code (a tester's fixed code; null when the unlock step said it needs none) gets the sealed keys back; the
     * password ([password], or the one typed to sign in) opens them, and this phone is added with them like with a
     * recovery key.
     */
    suspend fun withEmailCode(code: String?, password: String?) {
        val pw = password?.takeIf { it.isNotEmpty() } ?: signInPassword ?: throw ApiException(400, "password_required", "Enter your password.")
        val accountId = requireRecord().account?.id ?: throw ApiException(401, "session_expired", "Your session has ended. Sign in again.")
        val backup = requireBackups().unlock(code?.let { AccountRules.cleanVerifyCode(it) })
        val seed = withContext(Dispatchers.Default) {
            try {
                KeyBackupCrypto.open(pw, accountId, backup)
            } catch (_: KeyBackupCrypto.WrongPassword) {
                throw ApiException(400, "wrong_backup_password", "That password doesn't open your key backup. Use your recovery key instead.")
            }
        }
        signInPassword = pw
        withIdentitySeed(seed)
    }

    /** A phone that signed in with its own keys: backs them up if the account has no usable backup yet. */
    internal suspend fun afterBoundSignIn() {
        vault.keys()?.let { backUpQuietly(it) }
    }

    private fun requireBackups(): KeyBackupApi = keyBackups ?: throw ApiException(404, "no_key_backup", "This server doesn't keep key backups.")

    /**
     * Right after a sign-in that didn't bind a device. A new account gets its identity made here; a phone that holds
     * this account's identity adds (or re-adds) itself. Anything else needs the person to choose ([AccountPhase.NeedsDeviceSetup]).
     */
    internal suspend fun afterSignIn(account: AccountDto, deviceStale: Boolean) {
        val identity = account.identity
        val keys = vault.keys()
        when {
            identity == null -> createIdentity()
            keys != null && keys.identityPublic.b64() == identity.identityKey -> addDevice(if (deviceStale) newDeviceKeys(keys) else keys)
            else -> accounts.needsDeviceSetup(account)
        }
    }

    /** The account's first device: its identity is made on this phone. The recovery key is shown once afterwards. */
    suspend fun createIdentity() {
        // Kept before the server hears of them: if the app stops halfway, a retry uses the same keys instead of losing
        // them. Only keys made for this account are reused.
        val r = requireRecord()
        val accountId = r.account?.id
        val keys = vault.keys()?.takeIf { accountId != null && r.pendingIdentityFor == accountId }
            ?: LocalKeys.generate().also {
                vault.saveKeys(it)
                accounts.markPendingIdentity(accountId)
            }
        val nonce = api.challenge(r.serverUrl)
        val res = api.enroll(EnrollDeviceReq(identityKey = keys.identityPublic.b64(), device = keys.newDevice(deviceName()), nonce = nonce, signature = keys.proof("register", nonce)))
        finish(res, keys)
        accounts.identityCreated(RecoveryCode.encode(keys.identitySeed.unb64()), newAccount = true)
    }

    /** "Restore with my recovery key": checked here first, so a key of another account fails before any request. */
    suspend fun withRecoveryKey(code: String) {
        val seed = RecoveryCode.decode(code) ?: throw ApiException(400, "bad_recovery", "That recovery key isn't valid. Check for typos.")
        withIdentitySeed(seed)
    }

    /** With the account's identity seed in hand (a recovery key, or a legacy move on a new phone). */
    suspend fun withIdentitySeed(seed: ByteArray) {
        val identity = requireRecord().account?.identity
        if (identity != null && Ed25519.publicFromSeed(seed).b64() != identity.identityKey) {
            throw ApiException(400, "recovery_mismatch", "That recovery key belongs to a different account.")
        }
        addDevice(LocalKeys.generate(seed))
    }

    /** Linked from another phone (pairing): [keys] carry the identity seed it sealed to this one. */
    suspend fun withLinkedKeys(keys: LocalKeys) = addDevice(keys)

    /**
     * "Start fresh": a new identity for the account. Other devices are removed, the server's encrypted history goes, and
     * contacts see a new security code. Needs the password again.
     */
    suspend fun startFresh(password: String) {
        signInPassword = password
        val keys = LocalKeys.generate()
        val r = requireRecord()
        val nonce = api.challenge(r.serverUrl)
        val res = api.resetIdentity(ResetIdentityReq(password, keys.identityPublic.b64(), keys.newDevice(deviceName()), nonce, keys.proof("register", nonce)))
        vault.saveKeys(keys)
        finish(res, keys)
        accounts.identityCreated(RecoveryCode.encode(keys.identitySeed.unb64()), newAccount = false)
    }

    private suspend fun addDevice(keys: LocalKeys) {
        val r = requireRecord()
        val nonce = api.challenge(r.serverUrl)
        val res = api.enroll(EnrollDeviceReq(device = keys.newDevice(deviceName()), nonce = nonce, signature = keys.proof("add-device", nonce)))
        vault.saveKeys(keys)
        finish(res, keys)
    }

    private suspend fun finish(res: EnrollRes, keys: LocalKeys) {
        val r = requireRecord()
        val known = r.account
        val account = if (known?.identity?.userId == res.userId && known.identity.identityKey == keys.identityPublic.b64()) known else accounts.reload()
        accounts.bindMessaging(r.copy(account = account), res.deviceId)
        backUpQuietly(keys)
    }

    /**
     * Seals [keys]' identity under the sign-in password and saves it, when the account has no backup for its current
     * password and keys. Best effort: setting up the phone has already worked, and a later sign-in tries again.
     */
    private suspend fun backUpQuietly(keys: LocalKeys) {
        val api = keyBackups ?: return
        val password = signInPassword ?: return
        signInPassword = null
        val accountId = accounts.record?.account?.id ?: return
        try {
            if (api.status().exists) return
            val backup = withContext(Dispatchers.Default) { KeyBackupCrypto.seal(password, accountId, keys.identitySeed.unb64()) }
            api.save(password, backup)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            runCatching { android.util.Log.w("DeviceSetup", "key backup not saved: ${e.javaClass.simpleName} ${(e as? ApiException)?.code}") }
        }
    }

    private fun requireRecord(): AccountRecord =
        accounts.record?.takeIf { it.tokens != null } ?: throw ApiException(401, "session_expired", "Your session has ended. Sign in again.")

    private fun newDeviceKeys(keys: LocalKeys): LocalKeys = LocalKeys.generate(keys.identitySeed.unb64())
}

internal fun LocalKeys.newDevice(name: String): NewDeviceDto =
    NewDeviceDto(name, deviceSignPublic.b64(), deviceEncPublic, deviceCertificate())

internal fun LocalKeys.proof(purpose: String, nonce: String): String = signWithDevice(Canonical.authProof(purpose, nonce, deviceSignPublic.b64()))
