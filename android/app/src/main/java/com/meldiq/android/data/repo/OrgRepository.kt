package com.meldiq.android.data.repo

import com.meldiq.android.data.api.AcceptInviteRes
import com.meldiq.android.data.api.ActivityRes
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ChannelRes
import com.meldiq.android.data.api.ChannelsRes
import com.meldiq.android.data.api.CodeReq
import com.meldiq.android.data.api.CreateChannelReq
import com.meldiq.android.data.api.CreateOrgReq
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.InvitePreviewRes
import com.meldiq.android.data.api.InviteReq
import com.meldiq.android.data.api.InviteRes
import com.meldiq.android.data.api.InvitesRes
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.api.OrgDetailRes
import com.meldiq.android.data.api.OrgRes
import com.meldiq.android.data.api.OrgRoleReq
import com.meldiq.android.data.api.OrgsRes
import com.meldiq.android.data.api.TimeoutReq
import com.meldiq.android.data.api.TimeoutRes
import com.meldiq.android.data.api.UsersRes
import com.meldiq.android.data.api.UpdateOrgReq
import com.meldiq.android.data.api.OrgTitleReq
import com.meldiq.android.data.api.BanReq
import com.meldiq.android.data.api.BansRes
import com.meldiq.android.data.api.CategoryRes
import com.meldiq.android.data.api.CommunityPreviewRes
import com.meldiq.android.data.api.DiscoverRes
import com.meldiq.android.data.api.JoinCommunityRes
import com.meldiq.android.data.api.LayoutReq
import com.meldiq.android.data.api.LayoutRes
import com.meldiq.android.data.api.NameReq
import com.meldiq.android.data.api.OverwriteReq
import com.meldiq.android.data.api.OverwritesRes
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.db.KvEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.flow.StateFlow

/**
 * Communities (the server's "orgs"): membership, invitations, categories, channel layout and permissions, discovery
 * and bans (docs/COMMUNITY_REBUILD_2026-10-21.md). Every call is authorised server-side; the UI hides what the person
 * can't do.
 */
class OrgRepository(
    private val api: ApiClient,
    private val db: GriipDatabase,
    private val conversations: ConversationRepository,
    private val users: UserRepository,
) {
    private val _selectedOrg = MutableStateFlow<String?>(null)
    val selectedOrg: StateFlow<String?> = _selectedOrg

    suspend fun loadSelection() {
        _selectedOrg.value = db.kv().get("org")?.takeIf { it.isNotEmpty() }
    }

    suspend fun select(orgId: String?) {
        _selectedOrg.value = orgId
        db.kv().put(KvEntity("org", orgId ?: ""))
    }

    suspend fun orgs() = api.get<OrgsRes>("/v1/orgs").orgs.also { list ->
        db.kv().put(KvEntity("cache.orgs", GriipJson.encodeToString(OrgsRes.serializer(), OrgsRes(list))))
    }

    suspend fun cachedOrgs() = db.kv().get("cache.orgs")?.let { runCatching { GriipJson.decodeFromString(OrgsRes.serializer(), it).orgs }.getOrNull() }

    suspend fun detail(orgId: String): OrgDetailRes = api.get<OrgDetailRes>("/v1/orgs/$orgId").also {
        db.kv().put(KvEntity("cache.org.$orgId", GriipJson.encodeToString(OrgDetailRes.serializer(), it)))
    }

    /**
     * Deletes the organization (owners only; the server checks the role and [confirmName] again). [requestId] stays the
     * same when the person retries, so a retry after a lost answer gets the same result instead of "not found".
     */
    suspend fun delete(orgId: String, confirmName: String, requestId: String): com.meldiq.android.data.api.OrgDeleteRes =
        api.delete<com.meldiq.android.data.api.OrgDeleteReq, com.meldiq.android.data.api.OrgDeleteRes>(
            "/v1/orgs/$orgId", com.meldiq.android.data.api.OrgDeleteReq(confirmName.trim(), requestId),
        ).also { forget(orgId) }

    /** After an organization is deleted (here or on another device): its channels show as left, it's no longer selected. */
    suspend fun forget(orgId: String) {
        db.conversations().markOrgRemoved(orgId)
        db.kv().delete("cache.org.$orgId")
        cachedOrgs()?.let { list -> db.kv().put(KvEntity("cache.orgs", GriipJson.encodeToString(OrgsRes.serializer(), OrgsRes(list.filter { it.id != orgId })))) }
        if (_selectedOrg.value == orgId) select(null)
    }

    suspend fun cachedDetail(orgId: String): OrgDetailRes? =
        db.kv().get("cache.org.$orgId")?.let { runCatching { GriipJson.decodeFromString(OrgDetailRes.serializer(), it) }.getOrNull() }

    suspend fun create(name: String, description: String?, requestId: String? = null, visibility: String? = null, joinPolicy: String? = null, template: String? = null) =
        api.post<CreateOrgReq, OrgRes>("/v1/orgs", CreateOrgReq(name, description, requestId, visibility, joinPolicy, template = template)).org

    /** The starter templates (batch B2), on servers with `community-templates`. */
    suspend fun templates() = api.get<com.meldiq.android.data.api.CommunityTemplatesRes>("/v1/community-templates").templates
    /**
     * Name, description and rules (owners and admins), visibility and joining (owners only; the server checks). A blank
     * description or rules clears it.
     */
    suspend fun updateOrg(orgId: String, name: String, description: String?, rules: String? = null, visibility: String? = null, joinPolicy: String? = null) =
        api.patch<UpdateOrgReq, OrgRes>(
            "/v1/orgs/$orgId", UpdateOrgReq(name.trim(), jsonOrNull(description), rules?.let { jsonOrNull(it) }, visibility, joinPolicy),
        ).org.also { runCatching { orgs() } }

    /**
     * A community's look (API 0.44.0 and 0.46.0, `workspace.edit`): its accent `#rrggbb` and its 2–4 letter tag. Only the
     * fields passed change; [clearAccent] / [clearTag] go back to Meldiq's theme or no tag.
     */
    suspend fun setBranding(orgId: String, accent: String? = null, clearAccent: Boolean = false, tag: String? = null, clearTag: Boolean = false) =
        api.patch<kotlinx.serialization.json.JsonObject, OrgRes>(
            "/v1/orgs/$orgId",
            kotlinx.serialization.json.buildJsonObject {
                if (clearAccent) put("accent", kotlinx.serialization.json.JsonNull) else accent?.let { put("accent", kotlinx.serialization.json.JsonPrimitive(it.lowercase())) }
                if (clearTag) put("tag", kotlinx.serialization.json.JsonNull) else tag?.let { put("tag", kotlinx.serialization.json.JsonPrimitive(it.uppercase())) }
            },
        ).org.also { runCatching { orgs() } }

    /**
     * Adds people directly (API 0.42.0, at most 20): only people the caller knows who'd accept a DM from them; everyone
     * else comes back `not_available` and needs an invitation link.
     */
    suspend fun addMembers(orgId: String, userIds: List<String>): List<com.meldiq.android.data.api.MemberAddResult> =
        api.post<com.meldiq.android.data.api.MembersAddReq, com.meldiq.android.data.api.MembersAddRes>("/v1/orgs/$orgId/members", com.meldiq.android.data.api.MembersAddReq(userIds.distinct().take(com.meldiq.android.data.api.MembersAddReq.MAX))).results

    /** A community's banner (a JPEG of at most 1 MB; [com.meldiq.android.media.MediaPrep.bannerJpeg]). */
    suspend fun setBanner(orgId: String, jpeg: ByteArray) {
        api.sendBytes("PUT", "/v1/orgs/$orgId/banner", jpeg, kotlinx.serialization.json.JsonObject.serializer())
        runCatching { orgs() }
    }

    suspend fun removeBanner(orgId: String) {
        api.delete<kotlinx.serialization.json.JsonObject>("/v1/orgs/$orgId/banner")
        runCatching { orgs() }
    }

    /**
     * Leaves the community: the server removes [myUserId]'s roles and channel memberships (the last owner is
     * refused with 409). Afterwards its channels show as left on this phone and another workspace is selected.
     */
    suspend fun leave(orgId: String, myUserId: String) {
        api.delete<OkRes>("/v1/orgs/$orgId/members/$myUserId")
        forget(orgId)
        runCatching { orgs() }
        runCatching { conversations.refresh() }
    }

    /** Sets the organisation's avatar (owners and admins): a JPEG the phone has already prepared. */
    suspend fun setOrgPhoto(orgId: String, jpeg: ByteArray): Long? =
        api.sendBytes("PUT", "/v1/orgs/$orgId/photo", jpeg, com.meldiq.android.data.api.PhotoRes.serializer()).photoRev.also { runCatching { orgs() } }
    suspend fun removeOrgPhoto(orgId: String) {
        api.delete<com.meldiq.android.data.api.PhotoRes>("/v1/orgs/$orgId/photo")
        runCatching { orgs() }
    }

    /** A trimmed value, or JSON null to clear the field when it's blank. */
    private fun jsonOrNull(v: String?): kotlinx.serialization.json.JsonElement = v?.trim()?.takeIf { it.isNotEmpty() }?.let { JsonPrimitive(it) } ?: JsonNull

    suspend fun members(orgId: String, q: String = "") =
        api.get<UsersRes>("/v1/orgs/$orgId/members" + if (q.isNotBlank()) "?q=${java.net.URLEncoder.encode(q, "UTF-8")}" else "").members.also { it.forEach { u -> users.remember(u) } }

    suspend fun setOrgRole(orgId: String, userId: String, role: String) = api.patch<OrgRoleReq, OkRes>("/v1/orgs/$orgId/members/$userId", OrgRoleReq(role = role))
    suspend fun removeFromOrg(orgId: String, userId: String) = api.delete<OkRes>("/v1/orgs/$orgId/members/$userId")
    /** A member's job title; blank clears it. */
    suspend fun setOrgTitle(orgId: String, userId: String, title: String) =
        api.patch<OrgTitleReq, OkRes>("/v1/orgs/$orgId/members/$userId", OrgTitleReq(jsonOrNull(title)))
    /** [roleId]: a custom role the invitation gives on joining (not for guests). */
    suspend fun createInvite(orgId: String, role: String, maxUses: Int, hours: Int, guestDays: Int? = null, roleId: String? = null) =
        api.post<InviteReq, InviteRes>("/v1/orgs/$orgId/invites", InviteReq(role, maxUses, hours, guestDays.takeIf { role == "GUEST" }, roleId.takeIf { role != "GUEST" })).invite
    /** Round 7 (docs/WORKSPACE_C5.md): a guest's end date, null for none. */
    suspend fun setGuestExpiry(orgId: String, userId: String, expiresAt: Long?) =
        api.put<com.meldiq.android.data.api.GuestExpiryReq, kotlinx.serialization.json.JsonObject>("/v1/orgs/$orgId/members/$userId/expiry", com.meldiq.android.data.api.GuestExpiryReq(expiresAt))
    suspend fun invites(orgId: String) = api.get<InvitesRes>("/v1/orgs/$orgId/invites").invites
    suspend fun revokeInvite(id: String) = api.delete<OkRes>("/v1/invites/$id")
    suspend fun previewInvite(code: String) = api.post<CodeReq, InvitePreviewRes>("/v1/invites/preview", CodeReq(code))
    suspend fun acceptInvite(code: String) = api.post<CodeReq, AcceptInviteRes>("/v1/invites/accept", CodeReq(code)).also { runCatching { conversations.refresh() } }

    suspend fun channels(orgId: String, q: String = "") =
        api.get<ChannelsRes>("/v1/orgs/$orgId/channels" + if (q.isNotBlank()) "?q=${java.net.URLEncoder.encode(q, "UTF-8")}" else "").channels
    suspend fun createChannel(orgId: String, req: CreateChannelReq) =
        api.post<CreateChannelReq, ChannelRes>("/v1/orgs/$orgId/channels", req).channel.also { conversations.upsertFromServer(it) }

    suspend fun activity(orgId: String) = api.get<ActivityRes>("/v1/orgs/$orgId/activity").activity

    // ───────── Categories, layout and channel permissions ─────────
    suspend fun createCategory(orgId: String, name: String) =
        api.post<NameReq, CategoryRes>("/v1/orgs/$orgId/categories", NameReq(name.trim())).category
    suspend fun renameCategory(id: String, name: String) = api.patch<NameReq, CategoryRes>("/v1/categories/$id", NameReq(name.trim())).category
    /** Refused (409) while the category's permissions decide who sees channels still in it. */
    suspend fun deleteCategory(id: String) = api.delete<OkRes>("/v1/categories/$id")
    /** Category order (the listed ones first) and channels' category and position, in one write. */
    suspend fun saveLayout(orgId: String, req: LayoutReq) = api.put<LayoutReq, LayoutRes>("/v1/orgs/$orgId/layout", req).also { runCatching { conversations.refresh() } }
    suspend fun categoryOverwrites(id: String) = api.get<OverwritesRes>("/v1/categories/$id/overwrites")
    suspend fun channelOverwrites(id: String) = api.get<OverwritesRes>("/v1/conversations/$id/overwrites")
    /** Empty [allow] and [deny] remove the overwrite. Access may change for many people: their channels are refreshed. */
    suspend fun setOverwrite(category: Boolean, id: String, req: OverwriteReq): OverwritesRes =
        api.put<OverwriteReq, OverwritesRes>(if (category) "/v1/categories/$id/overwrites" else "/v1/conversations/$id/overwrites", req)
            .also { runCatching { conversations.refresh() } }

    // ───────── Discovery, joining and moderation ─────────
    suspend fun discover(q: String, cursor: Int = 0) =
        api.get<DiscoverRes>("/v1/communities/discover?cursor=$cursor" + if (q.isNotBlank()) "&q=${java.net.URLEncoder.encode(q.trim(), "UTF-8")}" else "")
    suspend fun preview(id: String) = api.get<CommunityPreviewRes>("/v1/communities/$id/preview")
    suspend fun join(id: String) =
        api.post<JoinCommunityRes>("/v1/communities/$id/join")
            .also { runCatching { orgs() }; runCatching { conversations.refresh() } }
    suspend fun bans(orgId: String) = api.get<BansRes>("/v1/orgs/$orgId/bans").bans
    suspend fun ban(orgId: String, userId: String, reason: String?) =
        api.post<BanReq, OkRes>("/v1/orgs/$orgId/bans", BanReq(userId, reason?.trim()?.takeIf { it.isNotEmpty() }))
    suspend fun unban(orgId: String, userId: String) = api.delete<OkRes>("/v1/orgs/$orgId/bans/$userId")
    /** Times [userId] out until [until] (epoch ms), or ends their timeout (null); the server checks who may. */
    suspend fun timeout(orgId: String, userId: String, until: Long?, reason: String?) =
        api.put<TimeoutReq, TimeoutRes>("/v1/orgs/$orgId/members/$userId/timeout", TimeoutReq(until, reason?.trim()?.takeIf { it.isNotEmpty() }))
}
