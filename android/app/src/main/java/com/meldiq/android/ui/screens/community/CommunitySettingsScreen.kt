package com.meldiq.android.ui.screens.community

import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.Policy
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.Workspaces
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.CommunityAccess
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.RoleBadge
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.workspace.DeleteWorkspaceRules
import com.meldiq.android.ui.screens.workspace.DeleteWorkspaceSheet
import com.meldiq.android.ui.screens.workspace.TransferOwnershipSheet
import com.meldiq.android.ui.screens.workspace.WorkspaceList
import com.meldiq.android.ui.screens.workspace.WorkspaceSettingsSheet
import com.meldiq.android.ui.screens.workspace.WorkspaceSetupCard
import com.meldiq.android.ui.screens.workspace.WorkspaceViewModel
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

private enum class SettingsSheet { Overview, Transfer, Delete, Leave, Security, Questions, Guide, OnboardingEdit, OnboardingAnswer }

/**
 * Community settings in groups (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §4): Community, People, Channels,
 * Moderation, More, then the danger zone. Each row opens an existing screen and shows only for people allowed to use
 * it; the server checks again.
 */
@Composable
fun CommunitySettingsScreen(nav: NavHostController) {
    val vm = containerViewModel { WorkspaceViewModel(it) }
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val detail by vm.detail.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val loading by vm.loading.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<SettingsSheet?>(null) }
    // Batch B4: reports and Security actions, on servers that have them.
    var reportsAvailable by remember { mutableStateOf(false) }
    var securityAvailable by remember { mutableStateOf(false) }
    // Batch B4b: join applications and activity alerts.
    var applicationsAvailable by remember { mutableStateOf(false) }
    var alertsAvailable by remember { mutableStateOf(false) }
    // Batch B8b: the community guide and onboarding questions.
    var guideAvailable by remember { mutableStateOf(false) }
    var onboardingAvailable by remember { mutableStateOf(false) }
    var expressionsAvailable by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        vm.refresh()
        reportsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.REPORTS) == true
        securityAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.SECURITY_ACTIONS) == true
        applicationsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.JOIN_APPLICATIONS) == true
        alertsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.ACTIVITY_ALERTS) == true
        guideAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.COMMUNITY_GUIDE) == true
        onboardingAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.ONBOARDING) == true
        expressionsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.COMMUNITY_EXPRESSIONS) == true
    }
    val d = detail

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { GriipTopBar(stringResource(R.string.nv_community_settings), subtitle = d?.org?.name, onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp), action = stringResource(R.string.common_retry), onAction = { vm.refresh() }) } }
        if (d == null) {
            item { if (loading) ShimmerList(4) else EmptyState(Icons.Outlined.Workspaces, stringResource(R.string.cm_none_title), stringResource(R.string.cm_none_body)) }
            return@LazyColumn
        }
        val p = d.permissions
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), shape = Shapes.hero) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OrgMark(d.org.id, d.org.name, WorkspaceList.colorSeed(d.org), d.org.photoRev, size = 52.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(d.org.name, style = Griip.type.title, color = c.textPrimary)
                        Text(
                            listOf(
                                memberCountLabel(d.stats.members),
                                stringResource(if (d.org.visibility == CommunityAccess.PUBLIC) R.string.cs_public else R.string.cs_private),
                            ).joinToString(" · "),
                            style = Griip.type.bodySmall, color = c.textSecondary,
                        )
                    }
                    RoleBadge(d.org.myRole)
                }
            }
        }
        d.org.activityAlert?.let { alert ->
            item(key = "alert") {
                StatusBanner(
                    stringResource(R.string.ja_alert, alert.count), BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp),
                    action = stringResource(R.string.ja_alert_action), onAction = { sheet = SettingsSheet.Security },
                )
            }
        }
        if (p.canManageOrg) item(key = "setup") { WorkspaceSetupCard(d) }
        group(R.string.nv_group_community) {
            MenuRow(Icons.Outlined.Info, stringResource(R.string.nv_overview), subtitle = stringResource(R.string.nv_overview_sub), onClick = { sheet = SettingsSheet.Overview })
            MenuRow(
                Icons.Outlined.Public, stringResource(R.string.nv_access_rules),
                subtitle = stringResource(if (d.org.joinPolicy == CommunityAccess.OPEN) R.string.dc_open else R.string.dc_invite_only),
                onClick = { sheet = SettingsSheet.Overview },
            )
            if (applicationsAvailable && d.org.visibility == CommunityAccess.PUBLIC && (p.isOwner || "workspace.edit" in p.effective)) MenuRow(
                Icons.Outlined.HowToReg, stringResource(R.string.ja_questions_title),
                subtitle = d.org.joinQuestions?.let { stringResource(R.string.ja_questions_on, it.size) } ?: stringResource(R.string.ja_questions_off),
                onClick = { sheet = SettingsSheet.Questions },
            )
            val canEditCommunity = p.isOwner || "workspace.edit" in p.effective
            if (guideAvailable && canEditCommunity) MenuRow(
                Icons.Outlined.Info, stringResource(R.string.b8b_guide),
                subtitle = stringResource(if (d.org.guide != null) R.string.b8b_guide_on else R.string.b8b_guide_off), onClick = { sheet = SettingsSheet.Guide },
            )
            if (onboardingAvailable && canEditCommunity) MenuRow(
                Icons.Outlined.HowToReg, stringResource(R.string.b8b_onboarding_title),
                subtitle = stringResource(if (d.org.onboarding) R.string.b8b_onboarding_is_on else R.string.b8b_onboarding_is_off), onClick = { sheet = SettingsSheet.OnboardingEdit },
            )
            if (expressionsAvailable && (p.isOwner || "expressions.manage" in p.effective)) MenuRow(
                Icons.Outlined.EmojiEmotions, stringResource(R.string.b9_title), subtitle = stringResource(R.string.b9_sub), onClick = { nav.navigate(Routes.expressions(d.org.id)) },
            )
            if (onboardingAvailable && d.org.onboarding && d.org.myRole != "GUEST") MenuRow(
                Icons.Outlined.HowToReg, stringResource(R.string.b8b_my_answers), onClick = { sheet = SettingsSheet.OnboardingAnswer },
            )
        }
        group(R.string.nv_group_people) {
            if (p.canViewDirectory) MenuRow(Icons.Outlined.ManageAccounts, stringResource(R.string.cm_stat_members), onClick = { nav.navigate(Routes.members(d.org.id)) })
            if (p.canViewRoles) MenuRow(Icons.Outlined.AdminPanelSettings, stringResource(R.string.manage_roles), subtitle = stringResource(R.string.manage_roles_sub), onClick = { nav.navigate(Routes.roles(d.org.id)) })
            if (p.canInvite) MenuRow(Icons.Outlined.GroupAdd, stringResource(R.string.nv_invitations), tint = c.peach, tintBg = c.peachSoft, onClick = { nav.navigate(Routes.invites(d.org.id)) })
        }
        group(R.string.nv_group_channels) {
            MenuRow(Icons.Outlined.Tag, stringResource(R.string.nv_channels_categories), subtitle = stringResource(R.string.nv_channels_categories_sub, d.stats.channels, d.categories.size), onClick = { nav.navigate(Routes.CHANNELS_MANAGE) })
        }
        val canReports = reportsAvailable && (p.isOwner || "reports.view" in p.effective)
        val canSecurity = securityAvailable && (p.isOwner || "workspace.edit" in p.effective || p.canBan)
        val canApplications = applicationsAvailable && (p.isOwner || "members.approve" in p.effective)
        if (p.canBan || p.canViewAudit || p.canViewDirectory || canReports || canSecurity || canApplications) group(R.string.nv_group_moderation) {
            if (canApplications) MenuRow(Icons.Outlined.HowToReg, stringResource(R.string.ja_title), subtitle = stringResource(R.string.ja_sub), tint = c.peach, tintBg = c.peachSoft, onClick = { nav.navigate(Routes.applications(d.org.id)) })
            if (canReports) MenuRow(Icons.Outlined.Flag, stringResource(R.string.rq_title), subtitle = stringResource(R.string.rq_sub), tint = c.danger, tintBg = c.dangerSoft, onClick = { nav.navigate(Routes.reports(d.org.id)) })
            if (canSecurity) MenuRow(
                Icons.Outlined.Shield, stringResource(R.string.sa_title),
                subtitle = listOfNotNull(
                    d.org.invitesPausedUntil?.let { stringResource(R.string.sa_invites) + " · " + stringResource(R.string.sa_paused_until, com.meldiq.android.ui.screens.workspace.TimeoutRules.untilText(it)) },
                    d.org.dmsPausedUntil?.let { stringResource(R.string.sa_dms) + " · " + stringResource(R.string.sa_paused_until, com.meldiq.android.ui.screens.workspace.TimeoutRules.untilText(it)) },
                ).joinToString("\n").ifEmpty { stringResource(R.string.sa_sub) },
                tint = c.warning, tintBg = c.warningSoft, onClick = { sheet = SettingsSheet.Security },
            )
            if (p.canBan) MenuRow(Icons.Outlined.Block, stringResource(R.string.cm_bans), subtitle = stringResource(R.string.cm_bans_sub), tint = c.danger, tintBg = c.dangerSoft, onClick = { nav.navigate(Routes.bans(d.org.id)) })
            if (p.canViewAudit) MenuRow(Icons.Outlined.Policy, stringResource(R.string.manage_audit), subtitle = stringResource(R.string.manage_audit_sub), tint = c.lavender, tintBg = c.lavenderSoft, onClick = { nav.navigate(Routes.audit(d.org.id)) })
            if (p.canViewDirectory) MenuRow(Icons.Outlined.History, stringResource(R.string.activity_workspace_log), tint = c.lavender, tintBg = c.lavenderSoft, onClick = { nav.navigate(Routes.activity(d.org.id)) })
        }
        group(R.string.nv_group_more) {
            MenuRow(Icons.Outlined.Event, stringResource(R.string.cm_events), subtitle = stringResource(R.string.cm_events_sub), tint = c.peach, tintBg = c.peachSoft, onClick = { nav.navigate(Routes.meetings(d.org.id, canSchedule = d.org.myRole != "GUEST")) })
            if (p.canViewUsage) MenuRow(Icons.Outlined.Insights, stringResource(R.string.manage_usage), subtitle = stringResource(R.string.manage_usage_sub), onClick = { nav.navigate(Routes.usage(d.org.id)) })
        }
        group(R.string.nv_group_danger, danger = true) {
            if (p.canTransferOwnership) MenuRow(Icons.Outlined.SwapHoriz, stringResource(R.string.owner_transfer), subtitle = stringResource(R.string.owner_transfer_sub), tint = c.warning, tintBg = c.warningSoft, onClick = { sheet = SettingsSheet.Transfer })
            if (DeleteWorkspaceRules.visible(d.org.myRole)) MenuRow(Icons.Outlined.DeleteForever, stringResource(R.string.nv_delete_community), subtitle = stringResource(R.string.nv_delete_community_sub), tint = c.danger, tintBg = c.dangerSoft, onClick = { sheet = SettingsSheet.Delete })
            if (d.org.myRole != "OWNER") MenuRow(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.nv_leave_community), tint = c.danger, tintBg = c.dangerSoft, onClick = { sheet = SettingsSheet.Leave })
        }
    }

    if (d != null) when (sheet) {
        SettingsSheet.Security -> com.meldiq.android.ui.screens.moderation.SecuritySheet(
            d.org.id, d.org.invitesPausedUntil, d.org.dmsPausedUntil, onDismiss = { sheet = null }, onChanged = { vm.refresh() },
            alertsOn = if (alertsAvailable) d.org.activityAlerts else null,
        )
        SettingsSheet.Guide -> GuideEditorSheet(d.org.id, d.org.guide, onDismiss = { sheet = null }, onSaved = { vm.refresh() })
        SettingsSheet.OnboardingEdit -> OnboardingEditorSheet(d.org.id, onDismiss = { sheet = null }, onSaved = { vm.refresh() })
        SettingsSheet.OnboardingAnswer -> OnboardingSheet(d.org.id, onDismiss = { sheet = null }, onDone = { sheet = null; vm.refresh() })
        SettingsSheet.Questions -> com.meldiq.android.ui.screens.moderation.JoinQuestionsSheet(d.org.id, d.org.joinQuestions, onDismiss = { sheet = null }, onChanged = { vm.refresh() })
        SettingsSheet.Overview -> WorkspaceSettingsSheet(d, onDismiss = { sheet = null }, onChanged = { vm.refresh() }, onLeft = { name ->
            sheet = null
            Toast.makeText(ctx, ctx.getString(R.string.ws_left, name), Toast.LENGTH_SHORT).show()
            nav.popBackStack()
        })
        SettingsSheet.Transfer -> TransferOwnershipSheet(d, onDismiss = { sheet = null }, onDone = { name ->
            sheet = null
            Toast.makeText(ctx, ctx.getString(R.string.owner_transfer_done, name), Toast.LENGTH_SHORT).show()
            vm.refresh()
        })
        SettingsSheet.Delete -> DeleteWorkspaceSheet(d, onDismiss = { sheet = null }, onDeleted = { name ->
            sheet = null
            Toast.makeText(ctx, ctx.getString(R.string.nv_community_deleted, name), Toast.LENGTH_SHORT).show()
            nav.popBackStack()
        })
        SettingsSheet.Leave -> ConfirmDialog(
            stringResource(R.string.nv_leave_title, d.org.name), stringResource(R.string.nv_leave_body), stringResource(R.string.nv_leave_community),
            onConfirm = {
                sheet = null
                val me = container.session.session?.userId ?: return@ConfirmDialog
                scope.launch {
                    runCatching { container.orgs.leave(d.org.id, me) }
                        .onSuccess { Toast.makeText(ctx, ctx.getString(R.string.ws_left, d.org.name), Toast.LENGTH_SHORT).show(); nav.popBackStack() }
                        .onFailure { Toast.makeText(ctx, it.friendly(), Toast.LENGTH_SHORT).show() }
                }
            },
            onDismiss = { sheet = null }, destructive = true,
        )
        null -> Unit
    }
}

/** One titled group of rows; left out when it would be empty is the caller's choice (rows inside decide themselves). */
private fun androidx.compose.foundation.lazy.LazyListScope.group(title: Int, danger: Boolean = false, rows: @Composable () -> Unit) {
    item(key = "group-$title") {
        Column {
            Text(
                stringResource(title), style = Griip.type.section, color = if (danger) Griip.colors.danger else Griip.colors.textSecondary,
                modifier = Modifier.padding(start = Space.gutter + 4.dp, top = 14.dp, bottom = 4.dp).semantics { heading() },
            )
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) { rows() }
        }
    }
}
