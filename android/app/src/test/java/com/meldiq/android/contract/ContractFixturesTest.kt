package com.meldiq.android.contract

import com.meldiq.android.data.account.AccountMeRes
import com.meldiq.android.data.account.AccountSessionRes
import com.meldiq.android.data.account.AccountUpdateRes
import com.meldiq.android.data.account.DeleteAccountRes
import com.meldiq.android.data.account.EnrollRes
import com.meldiq.android.data.account.KeyBackupDto
import com.meldiq.android.data.account.KeyBackupSaved
import com.meldiq.android.data.account.KeyBackupStatus
import com.meldiq.android.data.account.KeyUnlockStarted
import com.meldiq.android.data.account.LegacyVerifyRes
import com.meldiq.android.data.account.RecoveryCodesRes
import com.meldiq.android.data.account.RecoveryCodesStatus
import com.meldiq.android.data.account.RecoveryCompleteRes
import com.meldiq.android.data.account.RecoveryStartRes
import com.meldiq.android.data.account.SelectedWorkspaceRes
import com.meldiq.android.data.account.SessionListRes
import com.meldiq.android.data.account.VerificationSentRes
import com.meldiq.android.data.account.WorkspacesRes
import com.meldiq.android.data.api.AcceptInviteRes
import com.meldiq.android.data.api.ActivityRes
import com.meldiq.android.data.api.ApiErrorBody
import com.meldiq.android.data.api.ApplicationRes
import com.meldiq.android.data.api.ApplicationsRes
import com.meldiq.android.data.api.ApplyRes
import com.meldiq.android.data.api.AttachmentKeepRes
import com.meldiq.android.data.api.BansRes
import com.meldiq.android.data.api.BlocksRes
import com.meldiq.android.data.api.CallRes
import com.meldiq.android.data.api.CallsRes
import com.meldiq.android.data.api.CategoryRes
import com.meldiq.android.data.api.ChannelRes
import com.meldiq.android.data.api.ChannelsRes
import com.meldiq.android.data.api.CommunityPreviewRes
import com.meldiq.android.data.api.CommunityTemplatesRes
import com.meldiq.android.data.api.ConnectRes
import com.meldiq.android.data.api.ConnectionsRes
import com.meldiq.android.data.api.ConnectorCheckRes
import com.meldiq.android.data.api.ConnectorsRes
import com.meldiq.android.data.api.ConversationPresenceRes
import com.meldiq.android.data.api.ConversationRes
import com.meldiq.android.data.api.ConversationsRes
import com.meldiq.android.data.api.DeleteChannelRes
import com.meldiq.android.data.api.DevicesRes
import com.meldiq.android.data.api.DirectUploadRes
import com.meldiq.android.data.api.DiscoverRes
import com.meldiq.android.data.api.ExpressionRes
import com.meldiq.android.data.api.ExpressionsRes
import com.meldiq.android.data.api.FederationInfoRes
import com.meldiq.android.data.api.HealthRes
import com.meldiq.android.data.api.HistoryDeleteRes
import com.meldiq.android.data.api.HistoryPage
import com.meldiq.android.data.api.HistoryPutRes
import com.meldiq.android.data.api.HistorySummary
import com.meldiq.android.data.api.InvitePreviewRes
import com.meldiq.android.data.api.InviteRes
import com.meldiq.android.data.api.InvitesRes
import com.meldiq.android.data.api.JoinCommunityRes
import com.meldiq.android.data.api.KeysRes
import com.meldiq.android.data.api.LayoutRes
import com.meldiq.android.data.api.MeRes
import com.meldiq.android.data.api.MeetingRes
import com.meldiq.android.data.api.MeetingsRes
import com.meldiq.android.data.api.MessagingSettingsDto
import com.meldiq.android.data.api.MyApplicationsRes
import com.meldiq.android.data.api.NavPrefsRes
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.api.OnboardingAnswersRes
import com.meldiq.android.data.api.OnboardingDto
import com.meldiq.android.data.api.OrgDeleteRes
import com.meldiq.android.data.api.OrgDetailRes
import com.meldiq.android.data.api.OrgRes
import com.meldiq.android.data.api.OrgsRes
import com.meldiq.android.data.api.OverwritesRes
import com.meldiq.android.data.api.PhotoRes
import com.meldiq.android.data.api.PlatformMeRes
import com.meldiq.android.data.api.PresenceModeRes
import com.meldiq.android.data.api.PresenceRes
import com.meldiq.android.data.api.QueueRes
import com.meldiq.android.data.api.RealtimeCodec
import com.meldiq.android.data.api.ServerEvent
import com.meldiq.android.data.api.ReportRes
import com.meldiq.android.data.api.ReportSentRes
import com.meldiq.android.data.api.RoleMembersRes
import com.meldiq.android.data.api.RoleRes
import com.meldiq.android.data.api.SendMessageRes
import com.meldiq.android.data.api.ServerInfo
import com.meldiq.android.data.api.TimeoutRes
import com.meldiq.android.data.api.UserRes
import com.meldiq.android.data.api.UsersRes
import com.meldiq.android.data.repo.AnalyticsBatchRes
import com.meldiq.android.data.repo.ExperimentsRes
import com.meldiq.android.data.repo.ReminderRes
import com.meldiq.android.data.repo.RemindersRes
import com.meldiq.android.data.api.GriipJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The server's golden fixtures (shared/contracts/fixtures, docs/api/README.md) decoded with the app's own models: every
 * real answer and frame the server's test suite captured, for the routes the app calls, must decode with GriipJson,
 * the app's configuration. A stricter decoder (no coercion of unknown enum values or nulls) also runs; what it can't
 * decode today is listed in src/test/resources/contract_strict_allowlist.txt, which may only shrink.
 *
 * The route table was generated from the app's typed `api.get<T>(…)` calls (Architecture 1.0 step F1); add a row
 * when the app starts using another route.
 */
class ContractFixturesTest {
    private val fixtures: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "shared/contracts/fixtures") }
        .firstOrNull { it.isDirectory }
        ?: error("shared/contracts/fixtures not found above ${File("").absolutePath}")

    /** Strict: the app's settings minus coercion, so an unknown enum value or an unexpected null is reported. */
    private val strict = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = false
    }

    /** HTTP answers the app decodes: fixture name (method_path) to the model the app decodes it with. */
    private val http: Map<String, KSerializer<*>> = mapOf(
        // AI Workforce (docs/AI_WORKFORCE.md, API 0.35.0).
        "DELETE_v1_orgs_orgId_ai_agents_installId" to serializer<com.meldiq.android.data.ai.AiOkRes>(),
        // AI Workforce 2 (API 0.36.0–0.40.0): readiness, activity, test, triggers, tasks, readers, direct conversations.
        "DELETE_v1_orgs_orgId_ai_agents_installId_triggers_triggerId" to serializer<com.meldiq.android.data.ai.AiOkPlain>(),
        "GET_v1_conversations_id_ai_readers" to serializer<com.meldiq.android.data.ai.AiConversationReaders>(),
        "GET_v1_orgs_orgId_ai_agents_installId_activity" to serializer<com.meldiq.android.data.ai.AiActivityRes>(),
        "GET_v1_orgs_orgId_ai_agents_installId_readiness" to serializer<com.meldiq.android.data.ai.AiReadinessRes>(),
        "GET_v1_orgs_orgId_ai_agents_installId_triggers" to serializer<com.meldiq.android.data.ai.AiTriggersRes>(),
        "GET_v1_orgs_orgId_ai_approvals" to serializer<com.meldiq.android.data.ai.AiApprovalsRes>(),
        "GET_v1_orgs_orgId_ai_tasks" to serializer<com.meldiq.android.data.ai.AiTasksPage>(),
        "GET_v1_orgs_orgId_ai_tasks_settings" to serializer<com.meldiq.android.data.ai.AiTaskSettingsRes>(),
        "GET_v1_orgs_orgId_ai_tasks_taskId" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "PATCH_v1_orgs_orgId_ai_agents_installId_triggers_triggerId" to serializer<com.meldiq.android.data.ai.AiTriggerRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_direct" to serializer<com.meldiq.android.data.ai.AiDirectRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_read-scope" to serializer<com.meldiq.android.data.ai.AiReadersRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_readers" to serializer<com.meldiq.android.data.ai.AiReaderRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_readers_readerId_off" to serializer<com.meldiq.android.data.ai.AiReaderRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_test" to serializer<com.meldiq.android.data.ai.AiJobRes>(),
        "POST_v1_orgs_orgId_ai_agents_installId_triggers" to serializer<com.meldiq.android.data.ai.AiTriggerAdded>(),
        "POST_v1_orgs_orgId_ai_tasks" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_accept" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_approve" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_block" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_cancel" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_reassign" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_return" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_start" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "POST_v1_orgs_orgId_ai_tasks_taskId_submit" to serializer<com.meldiq.android.data.ai.AiTaskRes>(),
        "PUT_v1_conversations_id_ai_readers_readerId_choice" to serializer<com.meldiq.android.data.ai.AiConversationReaders>(),
        "PUT_v1_orgs_orgId_ai_tasks_settings" to serializer<com.meldiq.android.data.ai.AiTaskSettingsRes>(),
        "GET_v1_conversations_id_ai_agents" to serializer<com.meldiq.android.data.ai.AiChannelAgentsRes>(),
        "GET_v1_conversations_id_ai_posts" to serializer<com.meldiq.android.data.ai.AiPostsRes>(),
        "GET_v1_orgs_orgId_ai_agents_installId" to serializer<com.meldiq.android.data.ai.AiAgentDetail>(),
        "GET_v1_orgs_orgId_ai_catalog" to serializer<com.meldiq.android.data.ai.AiCatalog>(),
        "GET_v1_orgs_orgId_ai_jobs" to serializer<com.meldiq.android.data.ai.AiJobsPage>(),
        "GET_v1_orgs_orgId_ai_jobs_jobId" to serializer<com.meldiq.android.data.ai.AiJobRes>(),
        "PATCH_v1_orgs_orgId_ai_agents_installId" to serializer<com.meldiq.android.data.ai.AiAgentRes>(),
        "POST_v1_orgs_orgId_ai_agents" to serializer<com.meldiq.android.data.ai.AiAgentRes>(),
        "POST_v1_orgs_orgId_ai_approvals_approvalId" to serializer<com.meldiq.android.data.ai.AiJobSummaryRes>(),
        "POST_v1_orgs_orgId_ai_files" to serializer<com.meldiq.android.data.ai.AiFileRes>(),
        "POST_v1_orgs_orgId_ai_jobs" to serializer<com.meldiq.android.data.ai.AiJobRes>(),
        "POST_v1_orgs_orgId_ai_jobs_jobId_cancel" to serializer<com.meldiq.android.data.ai.AiJobSummaryRes>(),
        "POST_v1_orgs_orgId_ai_jobs_jobId_retry" to serializer<com.meldiq.android.data.ai.AiJobSummaryRes>(),
        "POST_v1_orgs_orgId_ai_jobs_jobId_revise" to serializer<com.meldiq.android.data.ai.AiJobSummaryRes>(),
        "PUT_v1_orgs_orgId_ai_agents_installId_avatar" to serializer<com.meldiq.android.data.ai.AiAgentRes>(),
        "PUT_v1_orgs_orgId_ai_agents_installId_channels_conversationId" to serializer<com.meldiq.android.data.ai.AiChannelsRes>(),
        "DELETE_v1_applications_id" to serializer<OkRes>(),
        "DELETE_v1_blocks_userId" to serializer<OkRes>(),
        "DELETE_v1_categories_id" to serializer<OkRes>(),
        "DELETE_v1_connections_userId" to serializer<OkRes>(),
        "DELETE_v1_conversations_id" to serializer<DeleteChannelRes>(),
        "DELETE_v1_conversations_id_members_userId" to serializer<OkRes>(),
        "DELETE_v1_conversations_id_photo" to serializer<PhotoRes>(),
        "DELETE_v1_devices_id" to serializer<OkRes>(),
        "DELETE_v1_expressions_id" to serializer<OkRes>(),
        "DELETE_v1_history" to serializer<HistoryDeleteRes>(),
        "DELETE_v1_invites_id" to serializer<OkRes>(),
        "DELETE_v1_orgs_orgId" to serializer<OrgDeleteRes>(),
        "DELETE_v1_orgs_orgId_bans_userId" to serializer<OkRes>(),
        "DELETE_v1_orgs_orgId_members_userId" to serializer<OkRes>(),
        "DELETE_v1_orgs_orgId_photo" to serializer<PhotoRes>(),
        "DELETE_v1_reminders_id" to serializer<OkRes>(),
        "DELETE_v1_roles_roleId" to serializer<OkRes>(),
        "DELETE_v1_users_me_photo" to serializer<PhotoRes>(),
        "DELETE_v2_account" to serializer<DeleteAccountRes>(),
        "DELETE_v2_account_key-backup" to serializer<OkRes>(),
        "DELETE_v2_account_sessions_id" to serializer<OkRes>(),
        "GET_v1_admin_connectors" to serializer<ConnectorsRes>(),
        "GET_v1_admin_health" to serializer<HealthRes>(),
        "GET_v1_blocks" to serializer<BlocksRes>(),
        "GET_v1_calls_active" to serializer<CallsRes>(),
        "GET_v1_calls_id" to serializer<CallRes>(),
        "GET_v1_categories_id_overwrites" to serializer<OverwritesRes>(),
        "GET_v1_communities_discover" to serializer<DiscoverRes>(),
        "GET_v1_communities_id_preview" to serializer<CommunityPreviewRes>(),
        "GET_v1_community-templates" to serializer<CommunityTemplatesRes>(),
        "GET_v1_connections" to serializer<ConnectionsRes>(),
        "GET_v1_conversations" to serializer<ConversationsRes>(),
        "GET_v1_conversations_id" to serializer<ConversationRes>(),
        "GET_v1_conversations_id_calls" to serializer<CallsRes>(),
        "GET_v1_conversations_id_devices" to serializer<KeysRes>(),
        "GET_v1_conversations_id_members" to serializer<UsersRes>(),
        "GET_v1_conversations_id_overwrites" to serializer<OverwritesRes>(),
        "GET_v1_conversations_id_presence" to serializer<ConversationPresenceRes>(),
        "GET_v1_devices" to serializer<DevicesRes>(),
        "GET_v1_experiments" to serializer<ExperimentsRes>(),
        "GET_v1_federation_info" to serializer<FederationInfoRes>(),
        "GET_v1_history_items" to serializer<HistoryPage>(),
        "GET_v1_history_summary" to serializer<HistorySummary>(),
        "GET_v1_me_applications" to serializer<MyApplicationsRes>(),
        "GET_v1_me_preferences_workspaceId" to serializer<NavPrefsRes>(),
        "GET_v1_meetings_id" to serializer<MeetingRes>(),
        "GET_v1_orgs" to serializer<OrgsRes>(),
        "GET_v1_orgs_orgId" to serializer<OrgDetailRes>(),
        "GET_v1_orgs_orgId_activity" to serializer<ActivityRes>(),
        "GET_v1_orgs_orgId_applications" to serializer<ApplicationsRes>(),
        "GET_v1_orgs_orgId_bans" to serializer<BansRes>(),
        "GET_v1_orgs_orgId_channels" to serializer<ChannelsRes>(),
        "GET_v1_orgs_orgId_expressions" to serializer<ExpressionsRes>(),
        "GET_v1_orgs_orgId_invites" to serializer<InvitesRes>(),
        "GET_v1_orgs_orgId_meetings" to serializer<MeetingsRes>(),
        "GET_v1_orgs_orgId_members" to serializer<UsersRes>(),
        "GET_v1_orgs_orgId_onboarding" to serializer<OnboardingDto>(),
        "GET_v1_platform_me" to serializer<PlatformMeRes>(),
        "GET_v1_presence" to serializer<PresenceRes>(),
        "GET_v1_queue" to serializer<QueueRes>(),
        "GET_v1_reminders" to serializer<RemindersRes>(),
        "GET_v1_reminders_id" to serializer<ReminderRes>(),
        "GET_v1_roles_roleId_members" to serializer<RoleMembersRes>(),
        "GET_v1_server-info" to serializer<ServerInfo>(),
        "GET_v1_users_by-phone" to serializer<UserRes>(),
        "GET_v1_users_id" to serializer<UserRes>(),
        "GET_v1_users_me" to serializer<MeRes>(),
        "GET_v1_users_me_messaging" to serializer<MessagingSettingsDto>(),
        "GET_v1_users_search" to serializer<UsersRes>(),
        "GET_v2_account" to serializer<AccountMeRes>(),
        "GET_v2_account_key-backup" to serializer<KeyBackupStatus>(),
        "GET_v2_account_recovery-codes" to serializer<RecoveryCodesStatus>(),
        "GET_v2_account_sessions" to serializer<SessionListRes>(),
        "GET_v2_workspaces" to serializer<WorkspacesRes>(),
        "PATCH_v1_applications_id" to serializer<ApplicationRes>(),
        "PATCH_v1_categories_id" to serializer<CategoryRes>(),
        "PATCH_v1_conversations_id" to serializer<ConversationRes>(),
        "PATCH_v1_expressions_id" to serializer<ExpressionRes>(),
        "PATCH_v1_orgs_orgId" to serializer<OrgRes>(),
        "PATCH_v1_orgs_orgId_members_userId" to serializer<OkRes>(),
        "PATCH_v1_reports_id" to serializer<ReportRes>(),
        "PATCH_v1_roles_roleId" to serializer<RoleRes>(),
        "PATCH_v1_users_me" to serializer<UserRes>(),
        "PATCH_v2_account" to serializer<AccountUpdateRes>(),
        "POST_v1_admin_connectors_id_check" to serializer<ConnectorCheckRes>(),
        "POST_v1_analytics_events" to serializer<AnalyticsBatchRes>(),
        "POST_v1_attachments_id_keep" to serializer<AttachmentKeepRes>(),
        "POST_v1_attachments_uploads" to serializer<DirectUploadRes>(),
        "POST_v1_blocks" to serializer<OkRes>(),
        "POST_v1_calls" to serializer<CallRes>(),
        "POST_v1_calls_id_alerted" to serializer<CallRes>(),
        "POST_v1_calls_id_connected" to serializer<CallRes>(),
        "POST_v1_calls_id_decline" to serializer<CallRes>(),
        "POST_v1_calls_id_end" to serializer<CallRes>(),
        "POST_v1_calls_id_hand" to serializer<CallRes>(),
        "POST_v1_calls_id_join" to serializer<CallRes>(),
        "POST_v1_calls_id_leave" to serializer<CallRes>(),
        "POST_v1_calls_id_moderate" to serializer<CallRes>(),
        "POST_v1_communities_id_apply" to serializer<ApplyRes>(),
        "POST_v1_communities_id_join" to serializer<JoinCommunityRes>(),
        "POST_v1_connections" to serializer<ConnectRes>(),
        "POST_v1_connections_userId_accept" to serializer<ConnectRes>(),
        "POST_v1_conversations_dm" to serializer<ConversationRes>(),
        "POST_v1_conversations_group" to serializer<ConversationRes>(),
        "POST_v1_conversations_id_join" to serializer<ConversationRes>(),
        "POST_v1_conversations_id_request" to serializer<OkRes>(),
        "POST_v1_invites_accept" to serializer<AcceptInviteRes>(),
        "POST_v1_invites_preview" to serializer<InvitePreviewRes>(),
        "POST_v1_meetings_id_cancel" to serializer<MeetingRes>(),
        "POST_v1_meetings_id_respond" to serializer<MeetingRes>(),
        "POST_v1_messages" to serializer<SendMessageRes>(),
        "POST_v1_orgs" to serializer<OrgRes>(),
        "POST_v1_orgs_orgId_bans" to serializer<OkRes>(),
        "POST_v1_orgs_orgId_categories" to serializer<CategoryRes>(),
        "POST_v1_orgs_orgId_channels" to serializer<ChannelRes>(),
        "POST_v1_orgs_orgId_invites" to serializer<InviteRes>(),
        "POST_v1_orgs_orgId_meetings" to serializer<MeetingRes>(),
        "POST_v1_orgs_orgId_onboarding_answers" to serializer<OnboardingAnswersRes>(),
        "POST_v1_orgs_orgId_roles" to serializer<RoleRes>(),
        "POST_v1_pairing_code_code_approve" to serializer<OkRes>(),
        "POST_v1_queue_ack" to serializer<OkRes>(),
        "POST_v1_reminders" to serializer<ReminderRes>(),
        "POST_v1_reminders_id_ack" to serializer<OkRes>(),
        "POST_v1_reports" to serializer<ReportSentRes>(),
        "POST_v1_users_devices" to serializer<KeysRes>(),
        "POST_v2_account_devices" to serializer<EnrollRes>(),
        "POST_v2_account_identity_reset" to serializer<EnrollRes>(),
        "POST_v2_account_key-backup_unlock" to serializer<KeyBackupDto>(),
        "POST_v2_account_key-backup_unlock_start" to serializer<KeyUnlockStarted>(),
        "POST_v2_account_password" to serializer<OkRes>(),
        "POST_v2_account_recovery-codes" to serializer<RecoveryCodesRes>(),
        "POST_v2_account_recovery-codes_revoke" to serializer<OkRes>(),
        "POST_v2_auth_email_resend" to serializer<VerificationSentRes>(),
        "POST_v2_auth_login" to serializer<AccountSessionRes>(),
        "POST_v2_auth_logout" to serializer<OkRes>(),
        "POST_v2_auth_password_forgot" to serializer<VerificationSentRes>(),
        "POST_v2_auth_password_reset" to serializer<OkRes>(),
        "POST_v2_auth_recover_complete" to serializer<RecoveryCompleteRes>(),
        "POST_v2_auth_recover_start" to serializer<RecoveryStartRes>(),
        "POST_v2_auth_refresh" to serializer<AccountSessionRes>(),
        "POST_v2_auth_register" to serializer<VerificationSentRes>(),
        "POST_v2_migration_legacy_complete" to serializer<VerificationSentRes>(),
        "POST_v2_migration_legacy_verify" to serializer<LegacyVerifyRes>(),
        "PUT_v1_conversations_id_members_userId" to serializer<OkRes>(),
        "PUT_v1_history_items" to serializer<HistoryPutRes>(),
        "PUT_v1_me_preferences_workspaceId" to serializer<NavPrefsRes>(),
        "PUT_v1_meetings_id" to serializer<MeetingRes>(),
        "PUT_v1_orgs_orgId_layout" to serializer<LayoutRes>(),
        "PUT_v1_orgs_orgId_members_userId_timeout" to serializer<TimeoutRes>(),
        "PUT_v1_orgs_orgId_onboarding" to serializer<OnboardingDto>(),
        "PUT_v1_users_me_messaging" to serializer<MessagingSettingsDto>(),
        "PUT_v1_users_me_presence" to serializer<PresenceModeRes>(),
        "PUT_v2_account_key-backup" to serializer<KeyBackupSaved>(),
        "PUT_v2_account_preferences" to serializer<SelectedWorkspaceRes>(),
    )

    private fun read(rel: String): String = File(fixtures, rel).readText()

    private fun firstLine(t: Throwable): String = t.message?.lineSequence()?.first() ?: t.toString()

    /** The app's own path ([RealtimeCodec]) for GriipJson, the same models with [json] otherwise; must be known. */
    private fun decodeFrame(json: Json, text: String): ServerEvent {
        val event = if (json === GriipJson) {
            RealtimeCodec.decode(text)
        } else {
            val t = json.parseToJsonElement(text).jsonObject.getValue("t").jsonPrimitive.content
            RealtimeCodec.serializerFor(t)?.let { json.decodeFromString(it, text) } ?: RealtimeCodec.decode(text)
        }
        check(event !is ServerEvent.Unknown) { "a frame the app doesn't know: ${(event as ServerEvent.Unknown).t}" }
        return event
    }

    private fun decodeAll(json: Json): Map<String, String> {
        val failures = sortedMapOf<String, String>()
        for ((name, ser) in http) {
            runCatching { json.decodeFromString(ser, read("http/$name.json")) }.onFailure { failures["http/$name"] = firstLine(it) }
        }
        for (f in File(fixtures, "realtime").listFiles().orEmpty().filter { it.extension == "json" }) {
            runCatching { decodeFrame(json, f.readText()) }
                .onFailure { failures["realtime/${f.nameWithoutExtension}"] = firstLine(it) }
        }
        for (f in File(fixtures, "http/errors").listFiles().orEmpty().filter { it.extension == "json" }) {
            runCatching {
                val e = json.decodeFromString(serializer<ApiErrorBody>(), f.readText())
                check(e.error?.code == f.nameWithoutExtension) { "decoded code ${e.error?.code}" }
            }.onFailure { failures["http/errors/${f.nameWithoutExtension}"] = firstLine(it) }
        }
        return failures
    }

    @Test
    fun everyMappedFixtureExists() {
        val missing = http.keys.filterNot { File(fixtures, "http/$it.json").isFile }
        assertEquals("fixtures the app's route table names but the server doesn't have", emptyList<String>(), missing)
        assertTrue(File(fixtures, "realtime").listFiles().orEmpty().isNotEmpty())
    }

    @Test
    fun theAppDecodesEveryFixtureItUses() {
        assertEquals("fixtures the app can't decode", emptyMap<String, String>(), decodeAll(GriipJson))
    }

    @Test
    fun strictDecodingOnlyFailsWhereAlreadyKnown() {
        val now = decodeAll(strict)
        val allowed = javaClass.getResource("/contract_strict_allowlist.txt")?.readText().orEmpty()
            .lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toSet()
        if (System.getenv("MELDIQ_WRITE_STRICT_ALLOWLIST") == "1") {
            File("src/test/resources/contract_strict_allowlist.txt").writeText(
                "# Strict-decoding failures known when written (ContractFixturesTest); may only shrink.\n" +
                    now.entries.joinToString("") { "${it.key}\n" },
            )
            return
        }
        assertEquals("new strict-decoding failures (an enum value or null the app doesn't expect)", emptyMap<String, String>(), now.filterKeys { it !in allowed })
        assertEquals("allowlisted strict failures that are fixed now: remove them", emptySet<String>(), allowed - now.keys)
    }
}
