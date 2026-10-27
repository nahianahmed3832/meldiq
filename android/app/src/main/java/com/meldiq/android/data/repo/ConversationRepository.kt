package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ConversationDto
import com.meldiq.android.data.api.ConversationRes
import com.meldiq.android.data.api.ConversationsRes
import com.meldiq.android.data.api.DmReq
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.GroupReq
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.model.RequestRules
import com.meldiq.android.data.api.PatchConversationReq
import com.meldiq.android.data.api.RoleReq
import com.meldiq.android.data.api.UsersRes
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.model.MemberSummary
import com.meldiq.android.data.api.ConversationFederationDto
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

class ConversationRepository(
    private val api: ApiClient,
    private val db: GriipDatabase,
    private val users: UserRepository,
) {
    private val _federation = MutableStateFlow<Map<String, ConversationFederationDto>>(emptyMap())

    /** Latest server-reported state of other servers per conversation (in memory; refreshed with the conversation). */
    val federation: StateFlow<Map<String, ConversationFederationDto>> = _federation.asStateFlow()

    fun observeAll(): Flow<List<ConversationEntity>> = db.conversations().observeAll()
    fun observe(id: String): Flow<ConversationEntity?> = db.conversations().observe(id)
    fun totalUnread(): Flow<Int> = db.conversations().observeTotalUnread()

    /** Pull membership metadata from the server, merging it with local-only fields. */
    suspend fun refresh() {
        val list = api.get<ConversationsRes>("/v1/conversations").conversations
        val seen = list.map { it.id }.toSet()
        list.forEach { upsertFromServer(it) }
        db.conversations().all().filter { it.id !in seen && !it.removed && it.joined }.forEach { db.conversations().markRemoved(it.id) }
    }

    suspend fun refreshOne(id: String): ConversationEntity? = try {
        upsertFromServer(api.get<ConversationRes>("/v1/conversations/$id").conversation)
    } catch (e: com.meldiq.android.data.api.ApiException) {
        if (e.status == 404) db.conversations().markRemoved(id)
        db.conversations().get(id)
    }

    suspend fun upsertFromServer(d: ConversationDto): ConversationEntity {
        d.members?.forEach { users.remember(it) }
        val members = d.members.orEmpty().map { MemberSummary(
            it.id, it.username, it.displayName, it.avatarColor, it.role, it.online, it.homeServer, it.photoRev,
            statusText = it.statusText, statusEmoji = it.statusEmoji, notificationsPaused = it.notificationsPaused,
        ) }
        _federation.update { m -> if (d.federation != null) m + (d.id to d.federation) else m - d.id }
        _mentionAll.update { m -> if (d.canMentionAll) m + (d.id to true) else m - d.id }
        _slowmode.update { m -> if (d.slowmodeSec > 0) m + (d.id to com.meldiq.android.data.model.Slowmode(d.slowmodeSec, d.slowmodeExempt, d.nextPostAt)) else m - d.id }
        val local = db.conversations().get(d.id)
        val e = ConversationEntity(
            id = d.id, type = d.type, orgId = d.orgId, scope = d.scope, scopeId = d.scopeId, scopeName = d.scopeName, kind = d.kind,
            name = d.name, topic = d.topic, archived = d.archived, memberCount = d.memberCount,
            membersJson = if (d.members != null) GriipJson.encodeToString(ListSerializer(MemberSummary.serializer()), members) else local?.membersJson ?: "[]",
            // Batch B6: an incoming request is read-only until you accept it (no replies, reactions or read receipts).
            joined = d.joined, myRole = d.myRole, canPost = d.canPost && d.request?.incoming != true, canManage = d.canManage,
            activeCallId = d.activeCall?.id, activeCallVideo = d.activeCall?.video ?: false, serverUpdatedAt = d.updatedAt,
            lastMessageId = local?.lastMessageId, lastMessagePreview = local?.lastMessagePreview, lastMessageAt = local?.lastMessageAt ?: 0,
            lastSenderName = local?.lastSenderName, unreadCount = local?.unreadCount ?: 0, mentionCount = local?.mentionCount ?: 0,
            muted = local?.muted ?: false, draft = local?.draft, removed = !d.joined && local?.joined == true,
            archivedAt = local?.archivedAt,
            voice = d.voice,
            roomPeopleJson = d.activeCall?.participantIds?.let { GriipJson.encodeToString(ListSerializer(String.serializer()), it) },
            categoryId = d.categoryId, categoryName = d.categoryName, position = d.position, categoryPosition = d.categoryPosition, format = d.format,
            forumTagsJson = d.forumTags.takeIf { it.isNotEmpty() }?.let { GriipJson.encodeToString(ListSerializer(com.meldiq.android.data.api.ForumTagDto.serializer()), it) },
            canConnect = d.canConnect, canSpeak = d.canSpeak, timedOutUntil = d.timedOutUntil,
            request = d.request?.let { if (it.incoming) RequestRules.INCOMING else RequestRules.OUTGOING },
            photoRev = d.photoRev,
        )
        _guidelines.update { m -> d.guidelines?.takeIf { it.isNotBlank() }?.let { m + (d.id to it) } ?: (m - d.id) }
        _requestSent.update { m -> d.request?.takeIf { !it.incoming }?.let { m + (d.id to ((it.sent ?: 0) to it.limit)) } ?: (m - d.id) }
        if (d.joined || local != null) db.conversations().upsert(e)
        return e
    }

    suspend fun openDm(userId: String): ConversationEntity = upsertFromServer(api.post<DmReq, ConversationRes>("/v1/conversations/dm", DmReq(userId)).conversation)

    suspend fun createGroup(name: String, memberIds: List<String>): ConversationEntity =
        upsertFromServer(api.post<GroupReq, ConversationRes>("/v1/conversations/group", GroupReq(name, memberIds)).conversation)

    /** Batch B6b: a group's photo (a JPEG the phone prepared), or none. */
    suspend fun setGroupPhoto(id: String, jpeg: ByteArray): Long? =
        api.sendBytes("PUT", "/v1/conversations/$id/photo", jpeg, com.meldiq.android.data.api.PhotoRes.serializer()).photoRev.also { refreshOne(id) }

    suspend fun removeGroupPhoto(id: String) {
        api.delete<com.meldiq.android.data.api.PhotoRes>("/v1/conversations/$id/photo")
        refreshOne(id)
    }

    suspend fun members(id: String) = api.get<UsersRes>("/v1/conversations/$id/members").members.also { it.forEach { u -> users.remember(u) } }

    private val _guidelines = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Batch B8: forums' post guidelines, as the server last described them (kept in memory). */
    val guidelines: StateFlow<Map<String, String>> = _guidelines

    private val _requestSent = MutableStateFlow<Map<String, Pair<Int, Int>>>(emptyMap())

    /** Batch B6: your message requests waiting for an answer: messages sent so far and the limit (kept in memory). */
    val requestSent: StateFlow<Map<String, Pair<Int, Int>>> = _requestSent

    /** Answers a message request you received: "accept", "decline" or "block". Declined ones leave this phone. */
    suspend fun answerRequest(id: String, action: String) {
        api.post<com.meldiq.android.data.api.RequestAnswerReq, OkRes>("/v1/conversations/$id/request", com.meldiq.android.data.api.RequestAnswerReq(action))
        if (action == "accept") refreshOne(id)
        else {
            db.messages().deleteConversationLocal(id)
            db.conversations().deleteLocal(id)
        }
    }

    private val _mentionAll = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    private val _slowmode = MutableStateFlow<Map<String, com.meldiq.android.data.model.Slowmode>>(emptyMap())

    /** Batch B3: channels with slowmode on, as the server last described them to this account (kept in memory). */
    val slowmode: StateFlow<Map<String, com.meldiq.android.data.model.Slowmode>> = _slowmode

    /** After this phone posted (or the server said to wait): when the person may post next in [id]. */
    fun slowmodeWait(id: String, nextPostAt: Long) = _slowmode.update { m -> m[id]?.let { m + (id to it.copy(nextPostAt = nextPostAt)) } ?: m }

    /** Conversations where the server lets this account use @everyone (refreshed with the conversation). */
    val mentionAll: StateFlow<Map<String, Boolean>> = _mentionAll

    /**
     * The people a mention can point at: the conversation's full member list from the server, or (offline) the members
     * stored with it. Ids are the mention targets; usernames are what the text shows.
     */
    suspend fun mentionMembers(id: String): List<com.meldiq.android.data.model.MentionMember> {
        val remote = runCatching { members(id) }.getOrNull()
        if (remote != null) return remote.map { com.meldiq.android.data.model.MentionMember(it.id, it.username, it.displayName) }.also { memberCache[id] = it }
        return knownMentionMembers(id)
    }

    private val memberCache = java.util.concurrent.ConcurrentHashMap<String, List<com.meldiq.android.data.model.MentionMember>>()

    /** The members already known on this phone (last full list fetched, else the ones stored with the conversation): no network. */
    suspend fun knownMentionMembers(id: String): List<com.meldiq.android.data.model.MentionMember> {
        memberCache[id]?.let { return it }
        val conv = db.conversations().get(id) ?: return emptyList()
        return ConversationRepository.members(conv).map { com.meldiq.android.data.model.MentionMember(it.id, it.username, it.displayName) }
    }

    suspend fun update(
        id: String, name: String? = null, topic: String? = null, archived: Boolean? = null, kind: String? = null, format: String? = null,
        forumTags: List<com.meldiq.android.data.api.ForumTagReq>? = null, slowmodeSec: Int? = null, guidelines: String? = null,
    ) = upsertFromServer(api.patch<PatchConversationReq, ConversationRes>("/v1/conversations/$id", PatchConversationReq(name, topic, archived, kind, format, forumTags, slowmodeSec, guidelines)).conversation)

    /**
     * Deletes a community channel for everyone (servers with `channel-delete`), after the person typed its name. The
     * local copy goes with it: its messages and files on this phone are removed too.
     */
    suspend fun deleteChannel(id: String, confirmName: String): com.meldiq.android.data.api.DeleteChannelRes {
        val r = api.delete<com.meldiq.android.data.api.DeleteChannelReq, com.meldiq.android.data.api.DeleteChannelRes>(
            "/v1/conversations/$id", com.meldiq.android.data.api.DeleteChannelReq(confirmName),
        )
        db.conversations().markRemoved(id)
        return r
    }

    /** A forum's tags as stored with the conversation. */
    fun forumTags(conv: ConversationEntity): List<com.meldiq.android.data.api.ForumTagDto> =
        conv.forumTagsJson?.let { runCatching { GriipJson.decodeFromString(ListSerializer(com.meldiq.android.data.api.ForumTagDto.serializer()), it) }.getOrNull() }.orEmpty()

    /** The server's current view of a conversation, with fields the local table doesn't keep (who may change its access). */
    suspend fun fetch(id: String): ConversationDto = api.get<ConversationRes>("/v1/conversations/$id").conversation.also { upsertFromServer(it) }

    suspend fun join(id: String) = upsertFromServer(api.post<ConversationRes>("/v1/conversations/$id/join").conversation)

    suspend fun addMember(id: String, userId: String, role: String = "MEMBER") {
        api.put<RoleReq, OkRes>("/v1/conversations/$id/members/$userId", RoleReq(role))
        refreshOne(id)
    }

    suspend fun removeMember(id: String, userId: String) {
        api.delete<OkRes>("/v1/conversations/$id/members/$userId")
        refreshOne(id)
    }

    suspend fun setMuted(id: String, muted: Boolean) = db.conversations().setMuted(id, muted)
    /** Archive ([archived]) or restore a chat on this phone only: membership, history and notifications don't change. */
    suspend fun setArchived(id: String, archived: Boolean) =
        db.conversations().setArchived(id, if (archived) System.currentTimeMillis() else null)
    suspend fun markUnread(id: String) = db.conversations().markUnread(id)
    suspend fun markRead(id: String) = db.conversations().markRead(id)
    suspend fun setDraft(id: String, draft: String?) = db.conversations().setDraft(id, draft)

    companion object {
        fun members(e: ConversationEntity): List<MemberSummary> =
            runCatching { GriipJson.decodeFromString(ListSerializer(MemberSummary.serializer()), e.membersJson) }.getOrDefault(emptyList())

        /** Display title: channel "#name", group name, or the other person in a DM. */
        fun title(e: ConversationEntity, myUserId: String?): String = when (e.type) {
            "CHANNEL" -> e.name ?: "channel"
            "GROUP" -> e.name ?: "Group"
            else -> members(e).firstOrNull { it.id != myUserId }?.displayName ?: "Direct message"
        }

        /** People in the conversation whose account is on another server (federation). */
        fun remoteMembers(e: ConversationEntity): List<MemberSummary> = members(e).filter { GlobalAddress.isRemote(it.username, it.homeServer) }

        fun peer(e: ConversationEntity, myUserId: String?): MemberSummary? =
            if (e.type == "DM") members(e).firstOrNull { it.id != myUserId } else null
    }
}
