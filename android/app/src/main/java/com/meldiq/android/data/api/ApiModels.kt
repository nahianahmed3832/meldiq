package com.meldiq.android.data.api

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialInfo
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// ───────── Auth ─────────
@Serializable data class ChallengeRes(val nonce: String, val expiresAt: Long)
@Serializable data class DeviceReg(val name: String, val signingKey: String, val encryptionKey: String, val certificate: String)
@Serializable data class RegisterReq(
    val username: String, val displayName: String, val identityKey: String, val avatarColor: Int,
    val device: DeviceReg, val nonce: String, val signature: String,
    /** Required by invite-only servers (the default): a registration invite or an org invite code. */
    val inviteCode: String? = null,
)
@Serializable data class LoginReq(val deviceId: String, val nonce: String, val signature: String)
@Serializable data class AddDeviceReq(val username: String, val device: DeviceReg, val nonce: String, val signature: String)
@Serializable data class SessionRes(val userId: String, val deviceId: String, val sessionToken: String, val expiresAt: Long)
@Serializable data class UsernameAvailableRes(val available: Boolean, val username: String? = null, val reason: String? = null)
@Serializable data class ServerInfo(
    val name: String, val version: String, val calling: Boolean, val queueTtlSeconds: Long,
    val attachmentMaxBytes: Long, val attachmentTtlSeconds: Long, val encryption: String,
    // Added 2026-10-16 (server-info v1); absent on older servers.
    val infoVersion: Int? = null, val api: Int? = null, val minClientApi: Int? = null,
    val instanceName: String? = null, val registration: String? = null,
    // 2026-10-17: what the server supports beyond API 1 ("profiles", "profile-photos", "history", "attachment-keep",
    // "org-delete", …). Absent on older servers: they support none of these.
    val features: List<String>? = null,
    // Push wake-ups (docs/BACKGROUND_DELIVERY.md): the push servers this server sends wake-ups to. Null: none.
    val push: ServerPushInfo? = null,
    // Orbit 2.0 (docs/ORBIT_2_ARCHITECTURE §6–7): the largest file in bytes of the file itself, and the account system.
    val fileMaxBytes: Long? = null,
    val accounts: com.meldiq.android.data.account.AccountsInfo? = null,
    // Passkeys (API 0.30.0, docs/PASSKEYS.md): null when the server doesn't offer them (or is older than 0.30.0).
    val passkeys: ServerPasskeysInfo? = null,
)

/** [webOrigins]: web apps on other hosts with passkeys of their own (Meldiq Web); the app uses the server's. */
@Serializable data class ServerPasskeysInfo(val webOrigins: List<String> = emptyList())

@Serializable data class ServerPushInfo(val unifiedPushHosts: List<String> = emptyList())

// ───────── Push wake-ups (docs/BACKGROUND_DELIVERY.md) ─────────
@Serializable data class PushEndpointReq(val kind: String, val endpoint: String)
@Serializable data class PushRegistrationDto(val kind: String, val host: String, val updatedAt: Long)
@Serializable data class PushEndpointRes(val push: PushRegistrationDto)
/** Firebase wake-ups (docs/PUSH_FCM.md): the device's registration token, and what the server stored. */
@Serializable data class FcmTokenReq(val token: String)
@Serializable data class FcmPushDto(val kind: String, val updatedAt: Long)
@Serializable data class FcmTokenRes(val push: FcmPushDto)
@Serializable data class PushRemoveRes(val ok: Boolean = true, val removed: Boolean = false)

// ───────── Encrypted message history (docs/MESSAGE_HISTORY.md) ─────────
@Serializable data class HistoryItemDto(val tag: String, val conv: String, val ts: Long, val body: String? = null, val seq: Long = 0)
@Serializable data class HistoryPutReq(val items: List<HistoryItemDto>)
@Serializable data class HistoryPutRes(val seq: Long, val items: Long, val bytes: Long)
@Serializable data class HistoryPage(val items: List<HistoryItemDto>, val next: Long, val more: Boolean)
@Serializable data class HistorySummary(val enabled: Boolean, val items: Long, val bytes: Long, val seq: Long, val maxItems: Long = 0, val maxBytes: Long = 0)
@Serializable data class HistoryDeleteRes(val deleted: Long)
@Serializable data class AttachmentKeepRes(val kept: Boolean, val expiresAt: Long? = null)

// ───────── Deleting an organization (2026-10-17) ─────────
@Serializable data class OrgDeleteReq(val confirmName: String, val requestId: String)
@Serializable data class OrgDeleteRes(val deleted: Boolean, val orgId: String, val members: Int = 0, val channels: Int = 0, val files: Int = 0)

@Serializable data class PairingStartReq(val deviceName: String, val signingKey: String, val encryptionKey: String, val transferKey: String)
@Serializable data class PairingStartRes(val pairingId: String, val code: String, val expiresAt: Long)
@Serializable data class PairingPollRes(
    val status: String, val username: String? = null, val identityKey: String? = null, val certificate: String? = null,
    val sealedIdentity: String? = null, val sealedEnc: String? = null,
)
@Serializable data class PairingRequestInfo(val deviceName: String, val signingKey: String, val encryptionKey: String, val transferKey: String, val createdAt: Long)
@Serializable data class PairingApproveReq(val certificate: String, val sealedIdentity: String, val sealedEnc: String)

// ───────── Users & devices ─────────
@Serializable data class UserDto(
    val id: String, val username: String, val displayName: String, val avatarColor: Int = 0, val statusText: String? = null,
    /** Round 3 (servers with `status-expiry`): the status emoji and when it ends; your own profile only for the end. */
    val statusEmoji: String? = null, val statusExpiresAt: Long? = null,
    /** Your own profile (servers with `notifications-pause`): notifications are paused until then, or null. */
    val notificationsPausedUntil: Long? = null,
    /** Someone else, when their last-seen setting lets you see it: they have paused notifications. */
    val notificationsPaused: Boolean? = null,
    val online: Boolean? = null, val lastSeenAt: Long? = null, val identityKey: String? = null, val fingerprint: String? = null,
    /**
     * Batch B6b (servers with `presence-modes`): how they appear ("online", "idle", "dnd", "offline"), when you may see
     * it; your own profile: what you chose ("auto", "idle", "dnd", "invisible") and until when.
     */
    val presence: String? = null, val presenceMode: String? = null, val presenceUntil: Long? = null,
    val role: String? = null, val orgRole: String? = null, val title: String? = null,
    /** A guest's membership end date in the workspace directory (round 7), null without one. */
    val expiresAt: Long? = null,
    /** Community member lists: their timeout's end while one runs (servers with member timeouts), null otherwise. */
    val timeoutUntil: Long? = null,
    // Federation (2026-10-16): set for people on another server (their username is then "name:server").
    val homeServer: String? = null, val address: String? = null,
    // Profile (server ≥ 2026-10-17, docs/PROFILE_AND_PRIVACY.md). Absent: not set, or not visible to you.
    val firstName: String? = null, val lastName: String? = null, val birthday: String? = null, val phone: String? = null,
    val photoRev: Long? = null,
    /** Batch B12: shown with the bio, under its privacy setting (servers with `pronouns`). */
    val pronouns: String? = null,
    /** Your own privacy settings (only in your own profile): field → "everyone" | "contacts" | "nobody". */
    val privacy: Map<String, String>? = null,
    /** Workspace member lists (servers with `custom-roles`): the custom roles this person holds there. */
    val customRoles: List<RoleRef> = emptyList(),
)
@Serializable data class MeRes(val user: UserDto, val deviceId: String)
@Serializable data class UserRes(val user: UserDto)
@Serializable data class UsersRes(val users: List<UserDto> = emptyList(), val members: List<UserDto> = emptyList())
/** Profile edit: null fields are left out (unchanged); an empty string clears a field. */
@Serializable data class UpdateMeReq(
    val displayName: String? = null, val statusText: String? = null, val avatarColor: Int? = null,
    val firstName: String? = null, val lastName: String? = null, val birthday: String? = null, val phone: String? = null,
    val username: String? = null,
    val pronouns: String? = null,
)
@Serializable data class PrivacyRes(val privacy: Map<String, String>)
@Serializable data class PhotoRes(val photoRev: Long? = null)
@Serializable data class DeviceKeyDto(val id: String, val signingKey: String, val encryptionKey: String, val certificate: String)
/** A device removed from its account: never encrypted to; envelopes the server accepted up to [revokedAt] verify (T1.5). */
@Serializable data class RevokedDeviceKeyDto(
    val id: String, val signingKey: String, val encryptionKey: String, val certificate: String, val revokedAt: Long,
)
@Serializable data class UserKeysDto(
    val userId: String, val identityKey: String, val devices: List<DeviceKeyDto>,
    /** Servers with the T1.5 fix list devices revoked within the queue lifetime; older ones omit it. */
    val revokedDevices: List<RevokedDeviceKeyDto> = emptyList(),
)
@Serializable data class KeysRes(val users: List<UserKeysDto>)
@Serializable data class UserIdsReq(val userIds: List<String>)
@Serializable data class MyDeviceDto(
    val id: String, val name: String, val signingKey: String, val createdAt: Long, val lastSeenAt: Long? = null,
    val revokedAt: Long? = null, val current: Boolean = false,
)
@Serializable data class DevicesRes(val devices: List<MyDeviceDto>)
@Serializable data class PresenceDto(val userId: String, val online: Boolean, val lastSeenAt: Long? = null, val presence: String? = null)
/** Batch B6b: PUT /v1/users/me/presence. */
@Serializable data class PresenceReq(val mode: String, val until: Long? = null)
@Serializable data class PresenceModeRes(val mode: String, val until: Long? = null)
@Serializable data class PresenceRes(val presence: List<PresenceDto>)

// ───────── Conversations ─────────
@Serializable data class ActiveCallDto(
    val id: String, val video: Boolean, val state: String, val startedAt: Long,
    /** Voice rooms: who is in the room now (at most 12). */
    val participantIds: List<String>? = null,
)
@Serializable data class ConversationDto(
    val id: String, val type: String, val orgId: String? = null, val scope: String? = null, val scopeId: String? = null,
    val scopeName: String? = null, val kind: String? = null, val name: String? = null, val topic: String? = null,
    val archived: Boolean = false, val createdAt: Long = 0, val updatedAt: Long = 0, val memberCount: Int = 0,
    val members: List<UserDto>? = null, val joined: Boolean = true, val myRole: String? = null,
    val canPost: Boolean = true, val canManage: Boolean = false, val activeCall: ActiveCallDto? = null,
    /** May switch the channel between public, private and announcement (scope managers; false from older servers). */
    val canManageAccess: Boolean = false,
    /** Whether this server lets you use @everyone here (false from older servers, which don't support it). */
    val canMentionAll: Boolean = false,
    val federation: ConversationFederationDto? = null,
    /** A voice channel (round 6, docs/VOICE_ROOMS.md): joining starts or joins its call, nobody rings. */
    val voice: Boolean = false,
    /** Communities (docs/COMMUNITY_REBUILD_2026-10-21.md): the channel's category (null: none), its order, text or forum. */
    val categoryId: String? = null,
    val categoryName: String? = null,
    val position: Int = 0,
    val format: String = ChannelFormat.TEXT,
    /** Forum channels: the tags posts can carry (servers with `forum-tags`). */
    val forumTags: List<ForumTagDto> = emptyList(),
    /** May you share files here (false where a permission takes it away; older servers: follow [canPost]). */
    val canAttach: Boolean? = null,
    /** Voice channels (servers with `voice-permissions`): may you join the call, and talk in it. */
    val canConnect: Boolean = true,
    val canSpeak: Boolean = true,
    /** While you're timed out in the channel's community: when it ends (you can read but not post or join voice). */
    val timedOutUntil: Long? = null,
    /** Batch B3 (servers with `slowmode`): seconds between one person's messages here (0: off). */
    val slowmodeSec: Int = 0,
    /** Whether slowmode leaves you alone here (channel managers, `messages.bypass_slowmode`). */
    val slowmodeExempt: Boolean = true,
    /** When you may post your next message under slowmode; null: now. */
    val nextPostAt: Long? = null,
    /** Batch B6 (servers with `message-requests`): this DM is a message request ([DmRequestDto.incoming]: to you). */
    val request: DmRequestDto? = null,
    /** Batch B6b (servers with `group-photos`): a group's photo revision; null without one. */
    val photoRev: Long? = null,
    /** Batch B8 (servers with `forum-guidelines`): what a forum asks of new posts; null without any. */
    val guidelines: String? = null,
)
/** A DM waiting for its recipient's answer. The sender sees it pending until it's accepted, so a decline isn't shown. */
@Serializable data class DmRequestDto(val state: String = "pending", val incoming: Boolean = false, val sent: Int? = null, val limit: Int = 3)
/** Batch B6: GET /v1/connections. */
@Serializable data class ConnectionEntryDto(val user: UserDto, val at: Long = 0)
@Serializable data class ConnectionsRes(val connected: List<UserDto> = emptyList(), val incoming: List<ConnectionEntryDto> = emptyList(), val outgoing: List<ConnectionEntryDto> = emptyList())
@Serializable data class ConnectReq(val userId: String? = null, val username: String? = null)
@Serializable data class ConnectRes(val state: String, val userId: String? = null)
@Serializable data class RequestAnswerReq(val action: String)
/** Who can message you directly, and who can send you requests (Settings › Privacy). */
@Serializable data class MessagingSettingsDto(val dmPolicy: String = "everyone", val requestPolicy: String = "everyone")
/** Times a community member out until [until] (epoch ms, at most 28 days ahead), or ends their timeout (null). */
@Serializable @SendNulls data class TimeoutReq(val until: Long?, val reason: String? = null)
@Serializable data class TimeoutRes(val userId: String, val timeoutUntil: Long? = null)
/** A label a forum offers for its posts. The server knows the names; a post's own tags are inside its encrypted message. */
@Serializable data class ForumTagDto(val id: String, val name: String)
/** Text channels hold a conversation; forum channels hold posts with titles, each with its replies (threads). */
object ChannelFormat {
    const val TEXT = "text"
    const val FORUM = "forum"
}
/** Servers of the people in a conversation who are on another server, as this server sees them. */
@Serializable data class ConversationFederationDto(val servers: List<FederationServerDto> = emptyList(), val calls: Boolean = false)
@Serializable data class FederationServerDto(val serverId: String, val domain: String? = null, val state: String = "unknown", val pending: Int = 0)
@Serializable data class ResolvedServerDto(
    val serverId: String, val domain: String, val state: String, val verifiedBy: Int = 0, val source: String = "quorum", val identityChanged: Boolean = false,
)
@Serializable data class ResolveRes(val user: UserDto, val server: ResolvedServerDto)
@Serializable data class FederationInfoRes(val enabled: Boolean, val domain: String, val serverId: String, val address: String)
@Serializable data class BlockReq(val userId: String)
@Serializable data class BlocksRes(val userIds: List<String> = emptyList())
@Serializable data class ConversationsRes(val conversations: List<ConversationDto>)
@Serializable data class ConversationRes(val conversation: ConversationDto)
@Serializable data class ChannelsRes(val channels: List<ConversationDto>)
@Serializable data class ChannelRes(val channel: ConversationDto)
@Serializable data class DmReq(val userId: String)
@Serializable data class GroupReq(val name: String, val memberIds: List<String>)
@Serializable data class PatchConversationReq(
    val name: String? = null, val topic: String? = null, val archived: Boolean? = null, val kind: String? = null,
    /** Communities: "text" or "forum" (text channels only). */
    val format: String? = null,
    /** Forum channels: the whole list of tags (an id keeps an existing tag; no id: a new one). */
    val forumTags: List<ForumTagReq>? = null,
    /** Batch B3: slowmode seconds, one of [com.meldiq.android.data.model.SlowmodeRules.STEPS]. */
    val slowmodeSec: Int? = null,
    /** Batch B8: a forum's post guidelines; "" removes them. */
    val guidelines: String? = null,
)
@Serializable data class ForumTagReq(val id: String? = null, val name: String)
@Serializable data class DeleteChannelReq(val confirmName: String)
@Serializable data class DeleteChannelRes(val deleted: Boolean = false, val id: String = "", val members: Int = 0, val files: Int = 0)
@Serializable data class RoleReq(val role: String)

// ───────── Messages & queue ─────────
@Serializable data class WireKeyWrap(val deviceId: String, val enc: String, val wrappedKey: String)
@Serializable data class SendMessageReq(
    val conversationId: String, val messageId: String, val cls: String, val sentAt: Long, val nonce: String,
    val ciphertext: String, val signature: String, val recipients: List<WireKeyWrap>,
    /** Asks the server to attest @everyone (null: omitted). The server checks who may and how often. */
    val mentionAll: Boolean? = null,
    /** "self": a control only for this person's own other devices (API 0.43.0); null: everyone in the conversation. */
    val audience: String? = null,
)
@Serializable data class SendMessageRes(val messageId: String, val serverTs: Long, val recipientCount: Int, val duplicate: Boolean = false)
@Serializable data class QueuePayload(
    val v: Int? = null, val cls: String? = null, val sentAt: Long? = null, val serverTs: Long? = null, val nonce: String? = null,
    val ciphertext: String? = null, val signature: String? = null, val enc: String? = null, val wrappedKey: String? = null,
    val status: String? = null, val at: Long? = null,
    /** The server attested @everyone on this copy (servers from 2026-10-17). */
    val mentionAll: Boolean? = null,
)
@Serializable data class QueueItem(
    val id: Long, val kind: String, val conversationId: String, val messageId: String, val senderUserId: String,
    val senderDeviceId: String, val createdAt: Long, val expiresAt: Long, val payload: QueuePayload,
)
@Serializable data class QueueRes(val items: List<QueueItem>, val more: Boolean)
@Serializable data class AckReq(val ids: List<Long>)
@Serializable data class AttachmentUploadRes(val id: String, val size: Long, val expiresAt: Long)

// ───────── Direct uploads to the server's file store (S3), 2026-10-17 ─────────
/** A presigned request: send it to [url] with exactly these [headers] (they're signed), and nothing else. */
@Serializable data class PresignedRequestDto(val method: String = "PUT", val url: String, val headers: Map<String, String>, val expiresAt: Long)
@Serializable data class DirectUploadReq(val conversationId: String, val size: Long, val sha256: String)
@Serializable data class DirectUploadRes(
    val uploadId: String, val mode: String, val expiresAt: Long,
    val upload: PresignedRequestDto? = null, val partSize: Long? = null, val partCount: Int? = null,
)
@Serializable data class UploadUrlRes(val upload: PresignedRequestDto)
@Serializable data class PartReq(val n: Int, val size: Long, val sha256: String)
@Serializable data class PartsReq(val parts: List<PartReq>)
@Serializable data class PartUrl(val n: Int, val upload: PresignedRequestDto)
@Serializable data class PartUrlsRes(val parts: List<PartUrl>)
@Serializable data class StoredPart(val n: Int, val etag: String, val size: Long, val sha256: String? = null)
@Serializable data class StoredPartsRes(val parts: List<StoredPart>)
@Serializable data class CompletedPart(val n: Int, val etag: String, val sha256: String)
@Serializable data class CompleteUploadReq(val parts: List<CompletedPart>? = null)

// ───────── Communities (the server's "orgs") ─────────
// slug defaults to "": servers before 2026-10-16 left it out of the invite preview, and requiring it made the app
// reject a valid invite with "Unexpected server response" (physical-device test).
@Serializable data class OrgDto(
    val id: String, val name: String, val slug: String = "", val description: String? = null, val myRole: String? = null,
    val memberCount: Int = 0, val createdAt: Long = 0,
    /** The community's avatar revision (servers with `org-photos`); null without one. */
    val photoRev: Long? = null,
    /** Round 7 guest policy (docs/WORKSPACE_C5.md). */
    val guestsAllowed: Boolean = true,
    val guestMaxDays: Int? = null,
    /** Listed in discovery ("public") or not ("private"), and how people get in ("invite" or "open"). */
    val visibility: String = CommunityAccess.PRIVATE,
    val joinPolicy: String = CommunityAccess.INVITE,
    /** Rules shown before joining and on the community's home. */
    val rules: String? = null,
    /** Batch B4 (servers with `security-actions`): running pauses of joining and of new DMs between members. */
    val invitesPausedUntil: Long? = null,
    val dmsPausedUntil: Long? = null,
    /** Batch B4b (servers with `join-applications`): the questions people answer to join, or null when it doesn't take applications. */
    val joinQuestions: List<String>? = null,
    /** Batch B4b (servers with `activity-alerts`): whether join spikes alert moderators, and the current alert (moderators only). */
    val activityAlerts: Boolean = true,
    val activityAlert: ActivityAlertDto? = null,
    /** Batch B8b: the community guide (members only), and whether it asks onboarding questions. */
    val guide: GuideDto? = null,
    val onboarding: Boolean = false,
)
/** Batch B9: one of a community's own emoji or stickers. */
@Serializable data class ExpressionDto(
    val id: String, val orgId: String, val kind: String = "emoji", val name: String, val animated: Boolean = false, val sha256: String,
    val size: Long = 0, val createdBy: String? = null, val createdAt: Long = 0,
)
@Serializable data class ExpressionLimitsDto(val emoji: Int = 50, val sticker: Int = 20)
@Serializable data class ExpressionsRes(val expressions: List<ExpressionDto> = emptyList(), val limits: ExpressionLimitsDto = ExpressionLimitsDto())
@Serializable data class ExpressionRes(val expression: ExpressionDto)
@Serializable data class RenameExpressionReq(val name: String)
/** Batch B8b: the community guide: a welcome line, "Get started" tasks and resources, each opening a channel. */
@Serializable data class GuideDto(val welcome: String? = null, val tasks: List<GuideItemDto> = emptyList(), val resources: List<GuideItemDto> = emptyList())
@Serializable data class GuideItemDto(val id: String? = null, val title: String, val channelId: String)
@Serializable data class GuideRes(val guide: GuideDto? = null)
/** Batch B8b: onboarding questions, and what you answered (null: not yet). */
@Serializable data class OnboardingDto(
    val enabled: Boolean = false, val prompts: List<OnboardingPromptDto> = emptyList(), val answered: List<String>? = null, val answeredAt: Long? = null,
)
@Serializable data class OnboardingPromptDto(
    val id: String? = null, val title: String, val single: Boolean = false, val required: Boolean = false, val options: List<OnboardingOptionDto> = emptyList(),
)
@Serializable data class OnboardingOptionDto(
    val id: String? = null, val title: String, val emoji: String? = null, val roleIds: List<String> = emptyList(), val channelIds: List<String> = emptyList(),
)
@Serializable data class OnboardingPutReq(val enabled: Boolean, val prompts: List<OnboardingPromptDto>)
@Serializable data class OnboardingAnswersReq(val optionIds: List<String>)
@Serializable data class OnboardingAnswersRes(val roleIds: List<String> = emptyList(), val channelIds: List<String> = emptyList())
/** Batch B4b: [count] people joined within ten minutes, at [at]. */
@Serializable data class ActivityAlertDto(val kind: String = "joins", val count: Int = 0, val at: Long = 0)

/** Who can find a community and how people get in (docs/COMMUNITY_REBUILD_2026-10-21.md §5). */
object CommunityAccess {
    const val PRIVATE = "private"
    const val PUBLIC = "public"
    const val INVITE = "invite"
    const val OPEN = "open"
}
/** Round 3: GET /v1/conversations/:id/presence. */
@Serializable data class ConversationPresenceRes(val online: Int = 0, val members: Int = 0)
@Serializable data class OrgsRes(val orgs: List<OrgDto>)
@Serializable data class OrgRes(val org: OrgDto)
/** `alreadyMember`: this person had already joined through the invite (a retry); the server used nothing up. */
@Serializable data class AcceptInviteRes(val org: OrgDto, val alreadyMember: Boolean = false)
@Serializable data class OrgStats(val members: Int = 0, val channels: Int = 0, val categories: Int = 0)
@Serializable data class OrgPermissions(
    val canManageOrg: Boolean = false, val canInvite: Boolean = false, val canCreateChannels: Boolean = false,
    val canViewDirectory: Boolean = false, val isOwner: Boolean = false,
    /** Everyone but the last owner may leave (server ≥ workspace-admin; older servers: decided from the role). */
    val canLeave: Boolean? = null,
    // Custom roles (servers with `custom-roles`, docs/WORKSPACE_ROLES.md).
    val canViewRoles: Boolean = false,
    val canManageRoles: Boolean = false,
    val canAssignRoles: Boolean = false,
    val canViewAudit: Boolean = false,
    val canViewUsage: Boolean = false,
    /** Communities: may arrange and manage every channel and category, and ban people. */
    val canManageChannels: Boolean = false,
    val canBan: Boolean = false,
    val canTransferOwnership: Boolean = false,
    /** The caller's effective permission keys in this community (empty on older servers). */
    val effective: List<String> = emptyList(),
)
/** A channel category you can see, in order, with what you may do in it. */
@Serializable data class CategoryDto(
    val id: String, val name: String, val position: Int = 0, val channelCount: Int = 0,
    val canManage: Boolean = false, val canCreateChannels: Boolean = false,
)
@Serializable data class OrgDetailRes(
    val org: OrgDto,
    val stats: OrgStats, val permissions: OrgPermissions,
    /** The custom roles the caller holds here. */
    val myRoles: List<RoleRef> = emptyList(),
    /** Communities: categories you can see, in order (empty on older servers). */
    val categories: List<CategoryDto> = emptyList(),
)
/** [requestId]: one per create form, so a retry or double tap returns the same community (server ≥ 2026-10-16). */
@Serializable data class CreateOrgReq(
    val name: String, val description: String? = null, val requestId: String? = null,
    val visibility: String? = null, val joinPolicy: String? = null, val rules: String? = null,
    /** Batch B2: the starter channels ("starter" when left out; servers with `community-templates`). */
    val template: String? = null,
)
/** A starter template as the server lists it: categories and their channels (names are the server's). */
@Serializable data class TemplateChannelDto(val name: String, val voice: Boolean = false, val format: String = "text", val kind: String = "PUBLIC")
@Serializable data class TemplateCategoryDto(val name: String, val channels: List<TemplateChannelDto> = emptyList())
@Serializable data class CommunityTemplateDto(val id: String, val categories: List<TemplateCategoryDto> = emptyList())
@Serializable data class CommunityTemplatesRes(val templates: List<CommunityTemplateDto> = emptyList())
@Serializable data class CreateChannelReq(
    val name: String, val topic: String? = null, val kind: String,
    val autoJoin: Boolean? = null, val memberIds: List<String> = emptyList(),
    /** A voice channel (round 6). */
    val voice: Boolean = false,
    val categoryId: String? = null,
    val format: String = ChannelFormat.TEXT,
)
@Serializable data class OrgRoleReq(val role: String? = null, val title: String? = null)
@Serializable data class InviteReq(
    val role: String, val maxUses: Int, val expiresInHours: Int,
    /** Round 7: how many days a guest's membership lasts once they join; null for no end date. */
    val guestDays: Int? = null,
    /** A custom role the invitation gives on joining. */
    val roleId: String? = null,
)
@Serializable data class InviteDto(
    val id: String, val code: String? = null, val hint: String? = null, val role: String,
    val maxUses: Int, val uses: Int = 0, val createdAt: Long = 0, val expiresAt: Long,
    val revokedAt: Long? = null, val active: Boolean = true,
    /** "active" | "revoked" | "expired" | "used_up" (server ≥ workspace-admin; null from older servers). */
    val status: String? = null, val createdBy: String? = null, val createdByName: String? = null,
    val roleId: String? = null,
)
@Serializable data class InviteRes(val invite: InviteDto)
@Serializable data class InvitesRes(val invites: List<InviteDto>)
@Serializable data class CodeReq(val code: String)
@Serializable data class NamedRef(val id: String, val name: String)
@Serializable data class GrantRoleRef(val id: String, val name: String, val color: String? = null)
@Serializable data class InvitePreviewRes(
    val org: OrgDto, val role: String, val alreadyMember: Boolean = false,
    val grantRole: GrantRoleRef? = null, val banned: Boolean = false,
    /** Batch B4: the community has paused new members for now. */
    val invitesPaused: Boolean = false,
)
/** Batch B4: what a reporter chose to share (the decrypted message and a little context); see `ReportRules`. */
@Serializable data class ReportAttachmentDto(val name: String, val size: Long? = null, val sha256: String? = null)
@Serializable data class ReportContextDto(val senderUserId: String, val text: String, val sentAt: Long)
@Serializable data class ReportContentDto(
    val text: String? = null, val sentAt: Long? = null,
    val attachments: List<ReportAttachmentDto>? = null, val context: List<ReportContextDto>? = null,
)
@Serializable data class ReportReq(
    val targetUserId: String, val reason: String, val conversationId: String? = null, val messageId: String? = null,
    val orgId: String? = null, val note: String? = null, val content: ReportContentDto? = null,
)
/** [to]: "community" (its moderators) or "meldiq" (Meldiq's team). */
@Serializable data class ReportSentDto(val id: String, val status: String, val to: String, val repeated: Boolean = false)
@Serializable data class ReportSentRes(val report: ReportSentDto)
@Serializable data class ReportPersonDto(val id: String, val username: String? = null, val displayName: String? = null)
/** A report as moderators see it: never who reported. */
@Serializable data class ReportDto(
    val id: String, val orgId: String? = null, val reason: String, val note: String? = null, val status: String,
    val createdAt: Long, val handledAt: Long? = null, val handledBy: ReportPersonDto? = null, val handledNote: String? = null,
    val target: ReportPersonDto? = null, val conversationId: String? = null, val conversationName: String? = null,
    val messageId: String? = null, val content: ReportContentDto? = null,
)
@Serializable data class ReportsRes(val reports: List<ReportDto> = emptyList(), val open: Int = 0, val nextBefore: Long? = null)
@Serializable data class ReportStatusReq(val status: String, val note: String? = null)
@Serializable data class ReportRes(val report: ReportDto)
/** Batch B4 Security actions: until when (epoch ms, at most 7 days ahead), or null to resume. Omitted: unchanged. */
@Serializable data class SecurityReq(val invitesPausedUntil: Long? = null, val dmsPausedUntil: Long? = null)
@Serializable data class SecurityRes(val invitesPausedUntil: Long? = null, val dmsPausedUntil: Long? = null, val activityAlerts: Boolean = true)
@Serializable data class ActivityDto(
    val id: Long, val at: Long, val action: String, val actorId: String? = null, val actorName: String? = null,
    val target: String? = null, val detail: String? = null,
)
@Serializable data class ActivityRes(val activity: List<ActivityDto>)
/** Community profile; a JSON null clears description or rules ([GriipJson] omits plain nulls). */
@Serializable data class UpdateOrgReq(
    val name: String, val description: kotlinx.serialization.json.JsonElement,
    val rules: kotlinx.serialization.json.JsonElement? = null,
    val visibility: String? = null, val joinPolicy: String? = null,
)
@Serializable data class ArchiveReq(val archived: Boolean)
/** A member's title; a JSON null clears it. */
@Serializable data class OrgTitleReq(val title: kotlinx.serialization.json.JsonElement)

// ───────── Categories, layout and channel permissions (docs/COMMUNITY_REBUILD_2026-10-21.md) ─────────
@Serializable data class CategoriesRes(val categories: List<CategoryDto> = emptyList())
@Serializable data class CategoryRes(val category: CategoryDto? = null)
@Serializable data class NameReq(val name: String)
@Serializable data class LayoutChannel(val id: String, val categoryId: String?, val position: Int)
@Serializable @SendNulls data class LayoutReq(val categories: List<String> = emptyList(), val channels: List<LayoutChannel> = emptyList())
@Serializable data class LayoutRes(val ok: Boolean = true, val removed: Int = 0, val categories: List<CategoryDto> = emptyList())
/** An overwrite: for "everyone", a role id, or "user:<id>"; [kind] everyone | role | member. */
@Serializable data class OverwriteDto(
    val subject: String, val kind: String, val label: String, val color: String? = null,
    val allow: List<String> = emptyList(), val deny: List<String> = emptyList(),
)
@Serializable data class CapabilityDto(val key: String, val label: String, val description: String = "")
@Serializable data class RoleLite(val id: String, val name: String, val color: String? = null)
@Serializable data class OverwritesRes(
    val overwrites: List<OverwriteDto> = emptyList(), val capabilities: List<CapabilityDto> = emptyList(),
    val roles: List<RoleLite> = emptyList(), val canManage: Boolean = false, val removed: Int = 0,
)
@Serializable data class OverwriteReq(val subject: String, val allow: List<String>, val deny: List<String>)

// ───────── Discovery, joining and bans ─────────
@Serializable data class DiscoverCommunityDto(
    val id: String, val name: String, val description: String? = null, val memberCount: Int = 0, val photoRev: Long? = null,
    val joinPolicy: String = CommunityAccess.INVITE, val joined: Boolean = false,
    /** Batch B4b: people apply to join by answering the community's questions. */
    val applications: Boolean = false,
)
@Serializable data class DiscoverRes(val communities: List<DiscoverCommunityDto> = emptyList(), val nextCursor: Int? = null)
@Serializable data class PreviewChannelDto(
    val id: String, val name: String? = null, val topic: String? = null, val kind: String? = null, val voice: Boolean = false,
    val format: String = ChannelFormat.TEXT,
)
@Serializable data class CommunityPreviewRes(
    val community: OrgDto, val channels: List<PreviewChannelDto> = emptyList(), val joined: Boolean = false, val banned: Boolean = false,
    /** Batch B4b: this person's latest application here, if any. */
    val application: MyApplicationDto? = null,
)
@Serializable data class MyApplicationDto(val id: String, val status: String, val createdAt: Long = 0, val orgId: String? = null, val orgName: String? = null)
@Serializable data class MyApplicationsRes(val applications: List<MyApplicationDto> = emptyList())
@Serializable data class ApplicationUserDto(val id: String, val username: String? = null, val displayName: String? = null)
/** Batch B4b: an application as people with `members.approve` see it. */
@Serializable data class ApplicationDto(
    val id: String, val orgId: String, val user: ApplicationUserDto, val questions: List<String> = emptyList(), val answers: List<String> = emptyList(),
    val status: String, val createdAt: Long = 0, val handledAt: Long? = null, val handledByName: String? = null, val note: String? = null,
)
@Serializable data class ApplicationsRes(val applications: List<ApplicationDto> = emptyList(), val pending: Int = 0)
@Serializable data class ApplicationRes(val application: ApplicationDto)
@Serializable data class ApplyReq(val answers: List<String>)
@Serializable data class ApplyRes(val application: ApplicationDto, val repeated: Boolean = false)
@Serializable data class DecideApplicationReq(val status: String, val note: String? = null)
@Serializable data class QuestionsRes(val questions: List<String>? = null)
@Serializable data class JoinCommunityRes(val org: OrgDto, val alreadyMember: Boolean = false)
@Serializable data class BanDto(
    val userId: String, val displayName: String, val username: String = "", val reason: String? = null,
    val bannedAt: Long = 0, val bannedBy: String? = null, val bannedByName: String? = null,
)
@Serializable data class BansRes(val bans: List<BanDto> = emptyList())
@Serializable data class BanReq(val userId: String, val reason: String? = null)

// ───────── Personal navigation preferences (servers with `nav-preferences`, docs/WORKSPACE_ADMINISTRATION.md) ─────────
@Serializable data class NavSectionDto(val id: String, val name: String, val items: List<String> = emptyList(), val collapsed: Boolean = false)
/** Starred conversations, custom sections, collapsed Home groups and notification levels ("mentions", "none"; absent = "all"). */
@Serializable data class NavPrefsDto(
    val starred: List<String> = emptyList(), val sections: List<NavSectionDto> = emptyList(),
    val collapsed: List<String> = emptyList(), val notify: Map<String, String> = emptyMap(),
    /**
     * Saved messages (Later, server feature `saved-items`, 2026-10-19): only in the personal document. Null (and then left
     * out of the request) everywhere else, so a server without the feature never sees the field.
     */
    val saved: List<SavedItemDto>? = null,
    /**
     * A community's own notification settings (batch B2, server feature `community-preferences`): only in a
     * community's document, and null (left out of the request) unless the person changed them.
     */
    val community: CommunityNotifyDto? = null,
    /** The person's communities in rail order (personal document only, same feature); null when never arranged. */
    val railOrder: List<String>? = null,
    /** Batch B3 (`channel-preferences`): mutes that end by themselves, conversation id → epoch ms. */
    val mutedUntil: Map<String, Long>? = null,
    /** Batch B3, community documents: a category's own level, which its channels follow unless they have one. */
    val categoryNotify: Map<String, String>? = null,
    /** Batch B3, community documents: channels hidden from the channel list (still joined). */
    val hidden: List<String>? = null,
)
/** The level a community's channels follow unless a channel has its own, and whether @everyone counts as a mention. */
@Serializable data class CommunityNotifyDto(val level: String = "all", val suppressEveryone: Boolean = false)
/** A message saved for later: ids and times only (the message itself stays end-to-end encrypted on the devices). */
@Serializable data class SavedItemDto(
    val conversationId: String, val messageId: String, val savedAt: Long, val remindAt: Long? = null, val done: Boolean = false,
)
@Serializable data class NavPrefsRes(val workspaceId: String, val rev: Int = 0, val updatedAt: Long? = null, val prefs: NavPrefsDto = NavPrefsDto())
@Serializable data class PutNavPrefsReq(val baseRev: Int, val prefs: NavPrefsDto)

// ───────── Calls ─────────
@Serializable data class CallParticipantDto(val userId: String, val deviceId: String, val joinedAt: Long)
@Serializable data class CallDto(
    val id: String, val conversationId: String, val conversationType: String? = null, val createdBy: String, val video: Boolean,
    val state: String, val createdAt: Long, val answeredAt: Long? = null, val endedAt: Long? = null, val endReason: String? = null,
    /** First time a recipient device confirmed it is ringing (server ≥ 2026-10-16; null on older servers). */
    val alertedAt: Long? = null,
    val participants: List<CallParticipantDto> = emptyList(),
    /** Ended calls (server ≥ 2026-10-17): one entry per person who connected. Null from older servers: not known. */
    val attended: List<CallAttendanceDto>? = null,
    /** The call of a voice room (round 6): no ringing, raised hands, room managers moderate. */
    val voiceRoom: Boolean = false,
    /** Voice rooms: who raised a hand, in order. */
    val hands: List<String> = emptyList(),
    /** Live calls: who is sharing their screen now, from the media server (API 0.42.0; older servers leave it out). */
    val sharing: List<String> = emptyList(),
)
@Serializable data class CallAttendanceDto(val userId: String, val joinedAt: Long, val leftAt: Long, val seconds: Long)
/** [canSpeak] false: a voice channel where you may only listen (the token can't publish). Older servers: true. */
@Serializable data class MediaGrant(val url: String, val token: String, val room: String, val canSpeak: Boolean = true)
@Serializable data class CallRes(val call: CallDto, val media: MediaGrant? = null, val joinedExisting: Boolean = false)
@Serializable data class CallsRes(val calls: List<CallDto>)
@Serializable data class StartCallReq(val conversationId: String, val video: Boolean)
@Serializable data class DeclineCallReq(val reason: String)
/** Voice rooms (round 6): raise or lower your hand; a manager's moderation of someone. */
@Serializable data class HandReq(val raised: Boolean)
@Serializable data class ModerateReq(val userId: String, val action: String)

/**
 * On a request model whose nulls mean "clear it" where the server requires the key (`z.….nullable()`): its body is
 * sent with explicit nulls ([encodeBody]); GriipJson would leave them out and the server would refuse the request.
 * RequestContractTest finds the models that need it.
 */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@Target(AnnotationTarget.CLASS)
annotation class SendNulls

@Serializable data class ApiErrorBody(val error: ApiErrorDetail? = null)
@Serializable data class ApiErrorDetail(val code: String = "", val message: String = "", val details: JsonElement? = null)
@Serializable data class OkRes(val ok: Boolean = true)
