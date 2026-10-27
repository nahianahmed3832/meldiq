package com.meldiq.android.data.repo

import com.meldiq.android.crypto.Canonical
import com.meldiq.android.crypto.Ed25519
import com.meldiq.android.crypto.RecipientDevice
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.model.PresenceRules
import com.meldiq.android.data.api.KeysRes
import com.meldiq.android.data.api.PresenceRes
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.api.UserIdsReq
import com.meldiq.android.data.api.UserKeysDto
import com.meldiq.android.data.api.UserRes
import com.meldiq.android.data.api.UsersRes
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.UserEntity
import java.util.concurrent.ConcurrentHashMap

/** Where the directory gets public keys from; a fake replaces the API in unit tests. */
interface KeySource {
    suspend fun conversationKeys(conversationId: String): List<UserKeysDto>
    suspend fun userKeys(userId: String): UserKeysDto?
}

/** Where pinned identity keys live (the `users` table); a fake replaces Room in unit tests. */
interface PinStore {
    suspend fun get(userId: String): UserEntity?
    suspend fun upsert(u: UserEntity)
}

private class ApiKeySource(private val api: ApiClient) : KeySource {
    override suspend fun conversationKeys(conversationId: String) = api.get<KeysRes>("/v1/conversations/$conversationId/devices").users
    override suspend fun userKeys(userId: String) = api.post<UserIdsReq, KeysRes>("/v1/users/devices", UserIdsReq(listOf(userId))).users.firstOrNull()
}

private class RoomPinStore(private val db: GriipDatabase) : PinStore {
    override suspend fun get(userId: String) = db.users().get(userId)
    override suspend fun upsert(u: UserEntity) = db.users().upsert(u)
}

/** Sending is paused: these members' identity keys differ from the ones pinned on first contact. */
class IdentityChangedException(val userIds: Set<String>) : Exception("identity key changed for ${userIds.size} member(s)")

/** How to treat the sender of an incoming envelope. */
sealed interface SenderKey {
    class Trusted(val signingKey: ByteArray) : SenderKey

    /** The sender's account now presents an identity key other than the pinned one: hold the message. */
    data object IdentityChanged : SenderKey

    /** No device with that id is certified by the sender's trusted identity key. */
    data object Unknown : SenderKey
}

/**
 * Public-key directory with trust-on-first-use pinning (docs/SECURITY.md §3, T1.2). The first
 * identity key seen for a user is pinned. Devices are encrypted to, or trusted as senders, only if
 * their certificate verifies against that *pinned* key. If the server later presents a different
 * identity key, the user is untrusted: sending to any conversation they're in is paused
 * ([IdentityChangedException]) and their messages are held ([SenderKey.IdentityChanged]) until the
 * local user reviews and accepts the new key ([acceptIdentity]). A warning alone isn't enough: a
 * relay that substitutes keys must not receive or forge anything.
 */
class KeyDirectory(private val source: KeySource, private val pins: PinStore) {
    constructor(api: ApiClient, db: GriipDatabase) : this(ApiKeySource(api), RoomPinStore(db))

    private data class Cached(val keys: UserKeysDto, val at: Long)
    private val cache = ConcurrentHashMap<String, Cached>()
    private val convCache = ConcurrentHashMap<String, Pair<List<UserKeysDto>, Long>>()

    /** Pins on first contact; returns the identity key to trust, or null when it differs from the pinned key. */
    private suspend fun trustedKey(u: UserKeysDto): String? {
        val existing = pins.get(u.userId)
        return when {
            existing == null -> u.identityKey.also { pins.upsert(UserEntity(u.userId, "", "", 0, null, pinnedIdentityKey = u.identityKey)) }
            existing.pinnedIdentityKey == null -> u.identityKey.also { pins.upsert(existing.copy(pinnedIdentityKey = u.identityKey)) }
            existing.pinnedIdentityKey == u.identityKey -> u.identityKey.also {
                // The server presents the pinned key again (e.g. it reverted): trust it, clear the warning.
                if (existing.identityChanged) pins.upsert(existing.copy(identityChanged = false))
            }
            else -> null.also { if (!existing.identityChanged) pins.upsert(existing.copy(identityChanged = true, verified = false)) }
        }
    }

    private fun certifies(identityKey: String, signingKey: String, encryptionKey: String, certificate: String) =
        Ed25519.verify(identityKey.unb64(), Canonical.deviceCert(identityKey, signingKey, encryptionKey).toByteArray(), certificate.unb64())

    private fun certified(u: UserKeysDto, identityKey: String) =
        u.devices.filter { certifies(identityKey, it.signingKey, it.encryptionKey, it.certificate) }

    private suspend fun conversationUsers(conversationId: String, force: Boolean): List<UserKeysDto> {
        val now = System.currentTimeMillis()
        val hit = convCache[conversationId]
        if (!force && hit != null && now - hit.second < 60_000) return hit.first
        return source.conversationKeys(conversationId).also { list ->
            convCache[conversationId] = list to now
            list.forEach { cache[it.userId] = Cached(it, now) }
        }
    }

    /** Devices to encrypt a message to. Throws [IdentityChangedException] if any member is untrusted. */
    suspend fun conversationRecipients(conversationId: String, myDeviceId: String, force: Boolean): List<RecipientDevice> {
        val changed = LinkedHashSet<String>()
        val out = ArrayList<RecipientDevice>()
        for (u in conversationUsers(conversationId, force)) {
            val key = trustedKey(u)
            if (key == null) {
                changed += u.userId
                continue
            }
            certified(u, key).filter { it.id != myDeviceId }.forEach { out += RecipientDevice(it.id, it.encryptionKey.unb64()) }
        }
        if (changed.isNotEmpty()) throw IdentityChangedException(changed)
        return out
    }

    /** This person's own other devices in [conversationId], for a self-only control (API 0.43.0, audience "self"). */
    suspend fun ownRecipients(conversationId: String, myUserId: String, myDeviceId: String, force: Boolean): List<RecipientDevice> {
        val me = conversationUsers(conversationId, force).firstOrNull { it.userId == myUserId } ?: return emptyList()
        val key = trustedKey(me) ?: return emptyList()
        return certified(me, key).filter { it.id != myDeviceId }.map { RecipientDevice(it.id, it.encryptionKey.unb64()) }
    }

    /** Member ids of a conversation (cached for a minute), e.g. to show which of them changed keys. */
    suspend fun conversationMemberIds(conversationId: String): List<String> = conversationUsers(conversationId, false).map { it.userId }

    fun invalidate(conversationId: String? = null) {
        if (conversationId == null) {
            convCache.clear()
        } else {
            convCache.remove(conversationId)
        }
    }

    fun invalidateUser(userId: String) {
        cache.remove(userId)
        convCache.clear()
    }

    /**
     * Signing key of the device that signed an envelope the server accepted at [serverTs], if the device is certified
     * by the sender's pinned identity: an active device, or one revoked no earlier than [serverTs] (T1.5). The server
     * accepts nothing from a device once it's revoked, so a later envelope is [SenderKey.Unknown]. Revoked devices are
     * never encryption targets (recipients are read from `devices` only).
     */
    suspend fun senderKey(userId: String, deviceId: String, serverTs: Long): SenderKey {
        val cached = cache[userId]?.keys?.takeIf { k -> k.devices.any { it.id == deviceId } || k.revokedDevices.any { it.id == deviceId } }
        val keys = cached ?: source.userKeys(userId)?.also { cache[userId] = Cached(it, System.currentTimeMillis()) } ?: return SenderKey.Unknown
        val trusted = trustedKey(keys) ?: return SenderKey.IdentityChanged
        certified(keys, trusted).firstOrNull { it.id == deviceId }?.let { return SenderKey.Trusted(it.signingKey.unb64()) }
        val revoked = keys.revokedDevices.firstOrNull {
            it.id == deviceId && serverTs <= it.revokedAt && certifies(trusted, it.signingKey, it.encryptionKey, it.certificate)
        }
        return revoked?.let { SenderKey.Trusted(it.signingKey.unb64()) } ?: SenderKey.Unknown
    }

    /**
     * The local user compared [identityKey]'s safety number and accepts it as this contact's key. The
     * reviewed key is pinned, not whatever the server returns next, so a second swap is caught too.
     */
    suspend fun acceptIdentity(userId: String, identityKey: String) {
        val e = pins.get(userId) ?: UserEntity(userId, "", "", 0, null, null)
        pins.upsert(e.copy(pinnedIdentityKey = identityKey, identityChanged = false, verified = false))
        invalidateUser(userId)
    }
}

class UserRepository(private val api: ApiClient, private val db: GriipDatabase) {
    suspend fun remember(u: UserDto) {
        val e = db.users().get(u.id)
        db.users().upsert(
            (e ?: UserEntity(u.id, u.username, u.displayName, u.avatarColor, u.statusText, null)).copy(
                username = u.username, displayName = u.displayName, avatarColor = u.avatarColor, statusText = u.statusText,
                online = u.online ?: e?.online ?: false, lastSeenAt = u.lastSeenAt ?: e?.lastSeenAt, updatedAt = System.currentTimeMillis(),
                photoRev = u.photoRev,
                presence = PresenceRules.stored(u.presence),
            ),
        )
    }

    suspend fun search(q: String): List<UserDto> = api.get<UsersRes>("/v1/users/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}").users.also { it.forEach { u -> remember(u) } }

    suspend fun fetch(id: String): UserDto = api.get<UserRes>("/v1/users/$id").user.also { remember(it) }

    suspend fun refreshPresence(ids: List<String>) {
        if (ids.isEmpty()) return
        api.get<PresenceRes>("/v1/presence?ids=${ids.joinToString(",")}").presence.forEach { db.users().setPresence(it.userId, it.online, it.lastSeenAt, PresenceRules.stored(it.presence)) }
    }

    suspend fun markVerified(userId: String) {
        db.users().get(userId)?.let { db.users().upsert(it.copy(verified = true)) }
    }

}
