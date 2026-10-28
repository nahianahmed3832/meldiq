package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ServerInfo
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * What this account's server supports, from /v1/server-info (2026-10-17). Servers from before then list nothing, so
 * the app can say "this server needs an update" instead of showing a bare "Not found" (the profile-photo report).
 * Cached for a few minutes; null while unknown (no connection yet).
 */
class ServerFeatures(private val api: ApiClient, private val clock: () -> Long = System::currentTimeMillis) {
    private val lock = Mutex()
    private var cached: ServerInfo? = null
    private var at = 0L
    /** Which server [cached] describes: a new account's address is set after its profile exists (2026-10-19 fix). */
    private var cachedFor: String? = null

    private suspend fun info(): ServerInfo? = lock.withLock {
        val address = api.serverAddress()
        if (cachedFor != address) {
            cached = null
            cachedFor = address
        }
        if (cached != null && clock() - at < TTL_MS) return cached
        val fresh = runCatching { api.get<ServerInfo>("/v1/server-info") }.getOrNull()
        // Only if the address didn't change while asking: an answer from the old server never describes the new one.
        if (fresh != null && api.serverAddress() == address) {
            cached = fresh
            at = clock()
        }
        cached
    }

    suspend fun get(): Set<String>? = info()?.let { it.features.orEmpty().toSet() }

    /** true / false once known; null when the server couldn't be asked. */
    suspend fun has(feature: String): Boolean? = get()?.contains(feature)

    /** The push servers this server sends wake-ups to (empty: none; null: unknown for now). */
    suspend fun pushHosts(): List<String>? = info()?.let { it.push?.unifiedPushHosts.orEmpty() }

    fun forget() {
        cached = null
    }

    companion object {
        const val PROFILES = "profiles"
        const val PROFILE_PHOTOS = "profile-photos"
        const val HISTORY = "history"
        const val ATTACHMENT_KEEP = "attachment-keep"
        const val ORG_DELETE = "org-delete"
        /** Deleting your own account, `DELETE /v2/account` (docs/ACCOUNT_DELETION.md). */
        const val ACCOUNT_DELETE = "account-delete"
        /** Communities (docs/COMMUNITY_REBUILD_2026-10-21.md): categories, channel order, forums, channel permissions. */
        const val COMMUNITY_CHANNELS = "community-channels"
        /** Public communities in Discover and open joining. */
        const val COMMUNITY_DISCOVERY = "community-discovery"
        /** Bans. */
        const val COMMUNITY_MODERATION = "community-moderation"
        /** 2026-10-21 Discord reference round: forum tags, deleting a channel, voice join/speak permissions. */
        const val FORUM_TAGS = "forum-tags"
        const val CHANNEL_DELETE = "channel-delete"
        const val VOICE_PERMISSIONS = "voice-permissions"
        /** Batch B2: a community's own notification settings and the rail order in the preferences documents. */
        const val COMMUNITY_PREFERENCES = "community-preferences"
        /** Batch B2: starter templates for a new community (GET /v1/community-templates). */
        const val COMMUNITY_TEMPLATES = "community-templates"
        /** Batch B3: slowmode on channels, enforced by the server. */
        const val SLOWMODE = "slowmode"
        /** Batch B3: timed mutes, category levels and hidden channels in the preferences documents. */
        const val CHANNEL_PREFERENCES = "channel-preferences"
        /** Batch B4: reports to moderators and to Meldiq's team. */
        const val REPORTS = "reports"
        /** Batch B4: pausing joining and new DMs between members; the audit log's person filter. */
        const val SECURITY_ACTIONS = "security-actions"
        /** Batch B4b: applying to join with a community's questions; join-spike alerts; https invite links and their page. */
        const val JOIN_APPLICATIONS = "join-applications"
        const val ACTIVITY_ALERTS = "activity-alerts"
        const val INVITE_LINKS = "invite-links"
        /** Batch B6: connections, message requests and who may message you. */
        const val CONNECTIONS = "connections"
        const val MESSAGE_REQUESTS = "message-requests"
        /** Batch B6b: a group's photo; appearing idle, do not disturb or invisible. */
        const val GROUP_PHOTOS = "group-photos"
        const val PRESENCE_MODES = "presence-modes"
        /** Batch B8: a forum's post guidelines. */
        const val FORUM_GUIDELINES = "forum-guidelines"
        /** Batch B8b: repeating events, onboarding questions, the community guide. */
        const val EVENT_REPEAT = "event-repeat"
        const val ONBOARDING = "onboarding"
        const val COMMUNITY_GUIDE = "community-guide"
        /** Batch B9: a community's own emoji and stickers. */
        const val COMMUNITY_EXPRESSIONS = "community-expressions"
        /** Batch B12: pronouns on profiles; roles listed separately in the member list. */
        const val PRONOUNS = "pronouns"
        const val ROLE_HOIST = "role-hoist"
        /** Meldiq 2.0: experiments and content-free analytics counts (docs/product/EXPERIMENTS.md). */
        const val EXPERIMENTS = "experiments"
        const val ANALYTICS_EVENTS = "analytics-events"
        /** Round 3: statuses with an end time, pausing notifications, online counts per conversation. */
        const val STATUS_EXPIRY = "status-expiry"
        const val NOTIFICATIONS_PAUSE = "notifications-pause"
        const val CONVERSATION_PRESENCE = "conversation-presence"
        const val DIRECT_UPLOAD = "direct-upload"
        const val PUSH_UNIFIEDPUSH = "push-unifiedpush"
        /** Firebase Cloud Messaging wake-ups (docs/PUSH_FCM.md). */
        const val PUSH_FCM = "push-fcm"
        /** Channel access modes, invitation states, archived branches and teams (docs/WORKSPACE_ADMINISTRATION.md). */
        const val WORKSPACE_ADMIN = "workspace-admin"
        /** Personal navigation preferences kept on the server: starred, sections, notification levels (2026-10-19). */
        const val NAV_PREFERENCES = "nav-preferences"
        /** Messages saved for later in the personal preferences document (2026-10-19, Home › Later). */
        const val SAVED_ITEMS = "saved-items"
        /** Universal search over server-readable content (round 7, docs/SEARCH.md). */
        const val SEARCH = "search"
        /** Organisation avatars (2026-10-19). */
        const val ORG_PHOTOS = "org-photos"
        /** API 0.43.0: self-only encrypted controls (audience "self"): a channel read here clears on this person's other devices. */
        const val SELF_CONTROLS = "self-controls"
        /** API 0.57.0: messages stored and served by the server (/v2/messages, history, summary, search, import). */
        const val SERVER_MESSAGES = "server-messages"
        const val DISCORD_IMPORT = "discord-import"
        /** API 0.44.0: a community's accent colour and banner (docs/COMMUNITY_BRANDING.md). */
        const val COMMUNITY_BRANDING = "community-branding"
        /** API 0.45.0: animated avatars, profile banners and style (docs/PROFILE_MEDIA.md); GIF search (docs/GIFS.md). */
        const val PROFILE_MEDIA = "profile-media"
        const val GIF_SEARCH = "gif-search"
        /** API 0.46.0 (docs/PROFILE_MEDIA.md): name styles, community tags, a whole community muted for a while. */
        const val NAME_STYLES = "name-styles"
        const val COMMUNITY_TAGS = "community-tags"
        const val COMMUNITY_MUTE = "community-mute"
        /** API 0.46.0 (docs/ACCOUNT_SAFETY.md): two-step sign-in, email change, standing, bug reports, About me and links. */
        const val TWO_STEP = "two-step"
        const val EMAIL_CHANGE = "email-change"
        const val ACCOUNT_STANDING = "account-standing"
        const val BUG_REPORTS = "bug-reports"
        const val PROFILE_LINKS = "profile-links"
        /** API 0.56.0: "Playing …" activities (docs/ACTIVITY_STATUS.md). */
        const val ACTIVITY_STATUS = "activity-status"
        /** Custom workspace roles and delegated permissions (2026-10-19, docs/WORKSPACE_ROLES.md). */
        const val CUSTOM_ROLES = "custom-roles"
        private const val TTL_MS = 5 * 60_000L
    }
}
