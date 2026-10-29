package com.meldiq.android.data.account

import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.OkRes
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** The identity seed sealed under the password (docs/KEY_BACKUP.md), as the server stores and returns it. */
@Serializable
data class KeyBackupDto(val version: Int, val iterations: Int, val salt: String, val nonce: String, val ciphertext: String, val identityKey: String)

/** GET /v2/account/key-backup: whether a backup works with the account's current password and keys. */
@Serializable
data class KeyBackupStatus(val exists: Boolean, val updatedAt: Long? = null)

@Serializable
data class PutKeyBackupReq(val password: String, val backup: KeyBackupDto)

@Serializable
data class KeyBackupSaved(val updatedAt: Long)

/**
 * How the unlock code reaches the person (API 0.63.0, server docs/ADMIN_ACCOUNTS.md): emailed; a tester's fixed code
 * from the admin console (nothing is emailed); or no code at all for an account the console vouched for.
 */
@Serializable
enum class UnlockDelivery {
    @SerialName("email") Email,
    @SerialName("fixed_code") FixedCode,
    @SerialName("none") None,
}

/** Where the unlock code went, masked ("n****2@gmail.com"); an older server says nothing about [delivery]: emailed. */
@Serializable
data class KeyUnlockStarted(val email: String, val expiresAt: Long, val delivery: UnlockDelivery = UnlockDelivery.Email)

/** A null [code] is left out: the unlock step said it needs none. */
@Serializable
data class KeyUnlockReq(val code: String? = null)

/**
 * Keys backed up under the password (docs/KEY_BACKUP.md): a device with the keys saves them; a new device signed in
 * with the password asks for an emailed code (a console-made tester's fixed code, or none: [UnlockDelivery]) and gets
 * them back. Every call uses the account's access token, which
 * exists before this phone has keys.
 */
interface KeyBackupApi {
    suspend fun status(): KeyBackupStatus
    suspend fun save(password: String, backup: KeyBackupDto): KeyBackupSaved
    suspend fun remove()
    suspend fun startUnlock(): KeyUnlockStarted
    suspend fun unlock(code: String?): KeyBackupDto
}

class HttpKeyBackupApi(private val authed: ApiClient) : KeyBackupApi {
    override suspend fun status(): KeyBackupStatus = authed.get("/v2/account/key-backup")

    override suspend fun save(password: String, backup: KeyBackupDto): KeyBackupSaved = authed.put("/v2/account/key-backup", PutKeyBackupReq(password, backup))

    override suspend fun remove() {
        authed.delete<OkRes>("/v2/account/key-backup")
    }

    override suspend fun startUnlock(): KeyUnlockStarted = authed.post("/v2/account/key-backup/unlock/start")

    override suspend fun unlock(code: String?): KeyBackupDto = authed.post("/v2/account/key-backup/unlock", KeyUnlockReq(code))
}
