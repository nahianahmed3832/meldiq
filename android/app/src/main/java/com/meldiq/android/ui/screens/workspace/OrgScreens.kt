package com.meldiq.android.ui.screens.workspace

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material.icons.outlined.TimerOff
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PostAdd
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.meldiq.android.R
import com.meldiq.android.data.api.ActivityDto
import com.meldiq.android.data.api.ConversationDto
import com.meldiq.android.data.api.InviteDto
import com.meldiq.android.data.api.OrgDetailRes
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.scan.InviteCodes
import com.meldiq.android.ui.components.ArrowKnob
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.MarkTile
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.RoleBadge
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatTile
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.chats.channelIcon
import com.meldiq.android.ui.screens.conversation.AddMembersSheet
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ───────────────────────────── Members & roles ─────────────────────────────

@Composable
fun MembersScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var list by remember { mutableStateOf<List<UserDto>?>(null) }
    var detail by remember { mutableStateOf<OrgDetailRes?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var manage by remember { mutableStateOf<UserDto?>(null) }
    var roleFilter by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    // Owners in the whole directory (not the filtered list), so an owner is offered "step down" only when another owner exists.
    var ownerCount by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(reload) {
        runCatching { container.orgs.detail(orgId) }.onSuccess { detail = it }
        runCatching { container.orgs.members(orgId) }.onSuccess { all -> ownerCount = WorkspaceRoles.ownerCount(all.map { it.orgRole }) }
    }
    LaunchedEffect(q, reload) {
        delay(200)
        runCatching { container.orgs.members(orgId, q) }.onSuccess { list = it }.onFailure { error = it.friendly() }
    }
    val canManage = detail?.permissions?.let { it.canManageOrg || it.canAssignRoles || it.canBan || "members.remove" in it.effective || "members.roles" in it.effective } == true
    val shown = list.orEmpty().filter { roleFilter == null || it.orgRole == roleFilter }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Members & roles", subtitle = detail?.org?.name, onBack = { nav.popBackStack() }) }
        item { SearchPill(q, { q = it }, "Search members", Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) }
        item { RolesGuideCard(Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) }
        item {
            ChipRow {
                PillChip("Everyone", roleFilter == null, { roleFilter = null }, count = list?.size)
                listOf("OWNER", "ADMIN", "MEMBER", "GUEST").forEach { r -> PillChip(r.lowercase().replaceFirstChar { it.uppercase() } + "s", roleFilter == r, { roleFilter = r }) }
            }
        }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp), action = "OK", onAction = { error = null }) } }
        if (list == null) item { ShimmerList(5) }
        // Batch B12: roles marked "show members separately" head their own groups (the whole list, unfiltered).
        val groups = if (roleFilter == null && q.isBlank()) com.meldiq.android.data.model.MemberGroups.group(shown) else listOf(com.meldiq.android.data.model.MemberGroups.Group(null, shown))
        val headed = groups.size > 1
        groups.forEach { g ->
        if (headed) item(key = "group-" + (g.role?.id ?: "rest")) {
            SectionHeader("${g.role?.name ?: stringResource(R.string.b12_others)} — ${g.members.size}", Modifier.padding(start = Space.gutter, top = 12.dp, bottom = 4.dp))
        }
        items(g.members, key = { it.id }) { u ->
            ListCard(
                u.displayName, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                // API 0.56.0: what they're playing comes first, as Discord's member list shows it (docs/ACTIVITY_STATUS.md).
                subtitle = listOfNotNull(
                    com.meldiq.android.ui.components.rememberActivity(u.id)?.let { com.meldiq.android.ui.components.activityLabel(it, withElapsed = false) },
                    "@${u.username}" + (u.title?.let { " · $it" } ?: ""),
                ).joinToString(" · "),
                // API 0.46.0: member lists carry each person's look (animated avatar, frame, worn tag), as on Meldiq Web.
                leading = { com.meldiq.android.ui.components.LookAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, com.meldiq.android.data.model.PersonLook(u.avatarMedia, u.profileStyle, u.tag), size = 46.dp, online = u.online) },
                meta = {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        u.tag?.let { com.meldiq.android.ui.components.WornTagChip(it) }
                        RoleBadge(u.orgRole)
                        u.expiresAt?.let { TagPill(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.guest_until, com.meldiq.android.ui.TimeFmt.dayHeader(it)), c.warning, c.warningSoft) }
                        if (TimeoutRules.running(u.timeoutUntil)) TagPill(stringResource(R.string.to_tag), c.danger, c.dangerSoft)
                        u.customRoles.take(2).forEach { r -> TagPill(r.name, c.primaryDeep, c.primarySoft) }
                        if (u.customRoles.size > 2) TagPill("+${u.customRoles.size - 2}", c.textSecondary, c.surfaceVariant)
                    }
                },
                trailing = { ArrowKnob() },
                onClick = { if (canManage || u.id == container.session.session?.userId) manage = u else nav.navigate(Routes.user(u.id, orgId)) },
            )
        }
        }
    }
    manage?.let { u ->
        detail?.let { d ->
            MemberSheet(d, u, ownerCount, onDismiss = { manage = null }, onOpenProfile = { manage = null; nav.navigate(Routes.user(u.id, orgId)) }) { reload++ }
        }
    }
    @Suppress("UNUSED_VARIABLE") val s = scope
}

@Composable
private fun MemberSheet(d: OrgDetailRes, u: UserDto, ownerCount: Int?, onDismiss: () -> Unit, onOpenProfile: () -> Unit, onChanged: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var role by remember { mutableStateOf(u.orgRole) }
    var confirmRemove by remember { mutableStateOf(false) }
    var banning by remember { mutableStateOf(false) }
    var timingOut by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf(false) }
    var reportsAvailable by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) { reportsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.REPORTS) == true }
    val me = container.session.session?.userId
    val ctx = androidx.compose.ui.platform.LocalContext.current
    fun act(block: suspend () -> Unit, after: () -> Unit = {}) = scope.launch {
        runCatching { block() }.onSuccess { after(); onChanged() }.onFailure { error = it.friendly() }
    }
    GlassSheet(onDismiss) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(u.displayName, u.avatarColor, size = 52.dp, online = u.online)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(u.displayName, style = Griip.type.title, color = c.textPrimary)
                Text("@${u.username}", style = Griip.type.bodySmall, color = c.textSecondary)
            }
            PillButton("Profile", onOpenProfile, tone = ButtonTone.Glass, showKnob = false, height = 38.dp)
        }
        error?.let { Spacer(Modifier.height(8.dp)); StatusBanner(it, BannerKind.Error) }
        LazyColumn(Modifier.fillMaxWidth().height(420.dp)) {
            // Only the roles this person may give (WorkspaceRoles mirrors the server); risky changes ask first.
            item {
                OrgRoleSection(d, u.copy(orgRole = role), ownerCount, onRole = { r -> role = r; onChanged() }, onError = { error = it })
                OrgTitleField(d, u, onSaved = onChanged, onError = { error = it })
                if (role == "GUEST") GuestExpirySection(d, u, onChanged = onChanged, onError = { error = it })
            }
            // Least to most severe (2026-10-23, the reference's member page): timeout, remove, ban. Timeouts (MOD-06): read-only in the community for a while; the server checks who may time out whom.
            if (TimeoutRules.canOffer(d.org.myRole, d.permissions.effective.toSet(), role, self = u.id == me)) item {
                Spacer(Modifier.height(10.dp))
                val until = u.timeoutUntil
                if (until != null && TimeoutRules.running(until)) {
                    StatusBanner(stringResource(R.string.to_until, TimeoutRules.untilText(until)), BannerKind.Warning)
                    Spacer(Modifier.height(8.dp))
                    PillButton(stringResource(R.string.to_end), {
                        act({ container.orgs.timeout(d.org.id, u.id, null, null) }) {
                            android.widget.Toast.makeText(ctx, ctx.getString(R.string.to_ended, u.displayName), android.widget.Toast.LENGTH_SHORT).show()
                            onDismiss()
                        }
                    }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, showKnob = false, leadingIcon = Icons.Outlined.TimerOff, height = 48.dp)
                } else {
                    PillButton(stringResource(R.string.to_action), { timingOut = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, showKnob = false, leadingIcon = Icons.Outlined.Timer, height = 48.dp)
                }
            }
            if (WorkspaceRoles.canRemove(d.org.myRole, role, self = u.id == me)) item {
                Spacer(Modifier.height(16.dp))
                PillButton(stringResource(R.string.member_remove), { confirmRemove = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, showKnob = false, leadingIcon = Icons.Outlined.DeleteOutline, height = 48.dp)
            }
            // Bans (communities): removed and kept out until lifted. Owners can't be banned; the server checks the rest.
            if (d.permissions.canBan && u.id != me && role != "OWNER" && (d.org.myRole == "OWNER" || role in setOf("MEMBER", "GUEST"))) item {
                Spacer(Modifier.height(10.dp))
                PillButton(stringResource(R.string.bn_ban), { banning = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, showKnob = false, leadingIcon = Icons.Outlined.Block, height = 48.dp)
            }
            // Batch B4: anyone can report another member to this community's moderators.
            if (reportsAvailable && u.id != me) item {
                Spacer(Modifier.height(10.dp))
                PillButton(stringResource(R.string.rp_title_person, u.displayName), { reporting = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, showKnob = false, leadingIcon = Icons.Outlined.Flag, height = 48.dp)
            }
        }
    }
    if (banning) BanSheet(d.org.id, u.id, u.displayName, onDismiss = { banning = false }, onDone = { onChanged(); onDismiss() })
    if (timingOut) TimeoutSheet(d.org.id, u.id, u.displayName, onDismiss = { timingOut = false }, onDone = { onChanged(); onDismiss() })
    if (reporting) com.meldiq.android.ui.screens.moderation.ReportSheet(
        com.meldiq.android.ui.screens.moderation.ReportTarget(userId = u.id, name = u.displayName, orgId = d.org.id, communityName = d.org.name),
        onDismiss = { reporting = false },
    )
    if (confirmRemove) ConfirmDialog(
        "Remove ${u.displayName}?", "They lose access to every channel in ${d.org.name} immediately. They can come back with a new invitation.", "Remove",
        onConfirm = { confirmRemove = false; act({ container.orgs.removeFromOrg(d.org.id, u.id) }) { onDismiss() } }, onDismiss = { confirmRemove = false }, destructive = true,
    )
}

// ───────────────────────────── Invitations ─────────────────────────────

@Composable
fun InvitesScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<OrgDetailRes?>(null) }
    var invites by remember { mutableStateOf<List<InviteDto>?>(null) }
    var created by remember { mutableStateOf<InviteDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var role by remember { mutableStateOf("MEMBER") }
    var grantRole by remember { mutableStateOf<String?>(null) }
    var assignable by remember { mutableStateOf<List<com.meldiq.android.data.api.CustomRoleDto>>(emptyList()) }
    var uses by remember { mutableIntStateOf(10) }
    var hours by remember { mutableIntStateOf(72) }
    var busy by remember { mutableStateOf(false) }
    // null: every invite; true: only usable ones; false: revoked, expired and used up.
    var stateFilter by remember { mutableStateOf<Boolean?>(null) }
    var revokeFor by remember { mutableStateOf<InviteDto?>(null) }
    var guestDays by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(reload) {
        runCatching { container.orgs.detail(orgId) }.onSuccess { d ->
            detail = d
            if (d.permissions.canViewRoles) runCatching { container.roles.roles(orgId) }.onSuccess { r -> assignable = r.roles.filter { it.canAssign && !it.archived } }
        }
        runCatching { container.orgs.invites(orgId) }.onSuccess { invites = it }.onFailure { error = it.friendly() }
    }
    val d = detail
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Invitations", subtitle = d?.org?.name, onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp), action = "OK", onAction = { error = null }) } }
        if (d != null) item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), shape = Shapes.hero) {
                Text("New invite", style = Griip.type.title, color = c.textPrimary)
                Spacer(Modifier.height(10.dp))
                Text("Role", style = Griip.type.label, color = c.textSecondary)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillChip("Member", role == "MEMBER", { role = "MEMBER" })
                    PillChip("Guest", role == "GUEST", { role = "GUEST" })
                    if (d.permissions.isOwner) PillChip("Admin", role == "ADMIN", { role = "ADMIN" })
                }
                // A role the invitation hands out on joining (for example the one that opens a category).
                if (role != "GUEST" && assignable.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(R.string.inv_give_role), style = Griip.type.label, color = c.textSecondary)
                    Spacer(Modifier.height(6.dp))
                    ChipRow(Modifier.padding(horizontal = 0.dp)) {
                        PillChip(stringResource(R.string.inv_no_role), grantRole == null, { grantRole = null })
                        assignable.forEach { r -> PillChip(r.name, grantRole == r.id, { grantRole = r.id }) }
                    }
                }
                Spacer(Modifier.height(10.dp))
                // Batch B4: more choices (Discord reference INV-CTRL-002); the server allows 1 to 500 uses and 1 hour to 30 days.
                Text("Uses", style = Griip.type.label, color = c.textSecondary)
                ChipRow(Modifier.padding(horizontal = 0.dp)) {
                    InviteChoices.USES.forEach { n -> PillChip("$n", uses == n, { uses = n }) }
                }
                Spacer(Modifier.height(8.dp))
                Text("Expires", style = Griip.type.label, color = c.textSecondary)
                ChipRow(Modifier.padding(horizontal = 0.dp)) {
                    InviteChoices.HOURS.forEach { (h, label) -> PillChip(stringResource(label), hours == h, { hours = h }) }
                }
                // Round 7: a guest's membership can end on its own (the workspace's guest policy may cap it).
                if (role == "GUEST") {
                    Spacer(Modifier.height(8.dp))
                    Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.guest_for), style = Griip.type.label, color = c.textSecondary)
                    ChipRow(Modifier.padding(horizontal = 0.dp)) {
                        listOf<Int?>(null, 7, 30, 90).forEach { days ->
                            PillChip(days?.let { androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.guest_days, it) } ?: androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.guest_no_end), guestDays == days, { guestDays = days })
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
                PillButton("Create invite", {
                    busy = true
                    scope.launch {
                        runCatching { container.orgs.createInvite(orgId, role, uses, hours, guestDays, grantRole) }.onSuccess { created = it; reload++ }.onFailure { error = it.friendly() }
                        busy = false
                    }
                }, Modifier.fillMaxWidth(), loading = busy, height = 50.dp, enabled = d.permissions.canInvite)
            }
        }
        item { SectionHeader("Recent invites", Modifier.padding(top = 10.dp, bottom = 6.dp)) }
        item {
            ChipRow {
                PillChip(stringResource(R.string.inv_filter_all), stateFilter == null, { stateFilter = null }, count = invites?.size)
                PillChip(stringResource(R.string.inv_filter_active), stateFilter == true, { stateFilter = true })
                PillChip(stringResource(R.string.inv_filter_ended), stateFilter == false, { stateFilter = false })
            }
        }
        val now = System.currentTimeMillis()
        val shownInvites = InviteStates.filter(invites.orEmpty(), stateFilter, now)
        if (invites?.isEmpty() == true) item { EmptyState(Icons.Outlined.GroupAdd, "No invites yet", "Codes you create appear here so you can revoke them.") }
        else if (invites != null && shownInvites.isEmpty()) item {
            Text(
                stringResource(if (stateFilter == true) R.string.inv_none_active else R.string.inv_none_ended), style = Griip.type.bodySmall, color = c.textSecondary,
                modifier = Modifier.padding(horizontal = Space.gutter, vertical = 8.dp),
            )
        }
        items(shownInvites, key = { it.id }) { inv ->
            val scopeName = assignable.firstOrNull { it.id == inv.roleId }?.name
            val state = InviteStates.of(inv, now)
            val usable = state == InviteState.ACTIVE
            ListCard(
                "…${inv.hint} · ${roleLabel(inv.role)}", Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                subtitle = listOfNotNull(
                    scopeName,
                    stringResource(R.string.inv_uses, inv.uses, inv.maxUses),
                    if (usable) stringResource(R.string.inv_expires, TimeFmt.listStamp(inv.expiresAt)) else null,
                    inv.createdByName?.let { stringResource(R.string.inv_created_by, it) },
                ).joinToString(" · "),
                leading = { IconTile(Icons.AutoMirrored.Outlined.Login, if (usable) c.primary else c.textTertiary, if (usable) c.primarySoft else c.surfaceVariant, size = 42.dp) },
                meta = { InviteStatePill(state) },
                trailing = {
                    if (usable) PillButton(stringResource(R.string.inv_revoke), { revokeFor = inv }, tone = ButtonTone.Glass, showKnob = false, height = 36.dp)
                },
            )
        }
    }
    revokeFor?.let { inv ->
        ConfirmDialog(
            stringResource(R.string.inv_revoke_title), stringResource(R.string.inv_revoke_body, inv.hint ?: ""), stringResource(R.string.inv_revoke),
            onConfirm = {
                revokeFor = null
                scope.launch { runCatching { container.orgs.revokeInvite(inv.id) }.onFailure { error = it.friendly() }; reload++ }
            },
            onDismiss = { revokeFor = null }, destructive = true,
        )
    }
    created?.let { inv ->
        GlassSheet({ created = null }, title = "Invite ready") {
            val code = inv.code ?: ""
            val qr = remember(code) { qrBitmap(InviteCodes.link(code)) }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.clip(Shapes.tile).background(Color.White).padding(12.dp)) { Image(qr.asImageBitmap(), "Invite QR code", Modifier.size(200.dp)) }
                Spacer(Modifier.height(14.dp))
                Text(code, style = Griip.type.display.copy(fontFamily = FontFamily.Monospace, fontSize = 26.sp), color = c.primaryDeep, textAlign = TextAlign.Center)
                Text("Shown once — the server stores only a hash. ${inv.maxUses} use(s), ${inv.role.lowercase()}.", style = Griip.type.caption, color = c.textTertiary, textAlign = TextAlign.Center)
                Spacer(Modifier.height(16.dp))
                PillButton("Share code", {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Join ${d?.org?.name ?: "our community"} on Meldiq with invite code $code (${InviteCodes.link(code)})")
                    ctx.startActivity(Intent.createChooser(send, "Share invite"))
                }, Modifier.fillMaxWidth(), leadingIcon = Icons.Outlined.Share, height = 50.dp)
            }
        }
    }
}

/** An invitation's state as a small coloured label. */
@Composable
private fun InviteStatePill(state: InviteState) {
    val c = Griip.colors
    val (label, fg, bg) = when (state) {
        InviteState.ACTIVE -> Triple(stringResource(R.string.inv_status_active), c.success, c.successSoft)
        InviteState.USED_UP -> Triple(stringResource(R.string.inv_status_used_up), c.textSecondary, c.surfaceVariant)
        InviteState.EXPIRED -> Triple(stringResource(R.string.inv_status_expired), c.warning, c.warningSoft)
        InviteState.REVOKED -> Triple(stringResource(R.string.inv_status_revoked), c.danger, c.dangerSoft)
    }
    TagPill(label, fg, bg)
}

fun qrBitmap(text: String, size: Int = 512): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    val px = IntArray(size * size) { i -> if (m[i % size, i / size]) 0xFF13221F.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(px, size, size, Bitmap.Config.ARGB_8888)
}

// ───────────────────────────── Activity ─────────────────────────────

@Composable
fun ActivityScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    var list by remember { mutableStateOf<List<ActivityDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { container.orgs.activity(orgId) }.onSuccess { list = it }.onFailure { error = it.friendly() } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Activity", onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter)) } }
        if (list == null && error == null) item { ShimmerList(6) }
        if (list?.isEmpty() == true) item { EmptyState(Icons.Outlined.History, "Quiet so far", "Channel, category and membership changes will show up here.") }
        items(list.orEmpty(), key = { it.id }) { a ->
            val (icon, label) = describe(a)
            ListCard(
                label, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                subtitle = "${a.actorName ?: "Someone"} · ${TimeFmt.relative(a.at)}",
                leading = { IconTile(icon, c.primary, c.primarySoft, size = 40.dp) },
            )
        }
    }
}

private fun describe(a: ActivityDto): Pair<androidx.compose.ui.graphics.vector.ImageVector, String> {
    val detail = a.detail?.substringAfter(' ') ?: ""
    return when (a.action) {
        "category.create" -> Icons.Outlined.PostAdd to "Created category ${a.detail ?: ""}"
        "category.update" -> Icons.Outlined.Edit to "Renamed a category"
        "category.delete" -> Icons.Outlined.DeleteOutline to "Deleted category ${a.detail ?: ""}"
        "layout.update" -> Icons.Outlined.SwapHoriz to "Rearranged channels"
        "permissions.update" -> Icons.Outlined.Lock to "Changed channel permissions"
        "channel.create" -> Icons.Outlined.PostAdd to "Created channel #$detail"
        "invite.accept" -> Icons.AutoMirrored.Outlined.Login to "Joined the community"
        "community.join" -> Icons.AutoMirrored.Outlined.Login to "Joined from Discover"
        "member.ban" -> Icons.Outlined.DeleteOutline to "Banned a member"
        "member.unban" -> Icons.Outlined.Unarchive to "Lifted a ban"
        "invite.create" -> Icons.Outlined.GroupAdd to "Created a ${a.detail?.lowercase()} invite"
        "invite.revoke" -> Icons.Outlined.DeleteOutline to "Revoked an invite"
        "member.role" -> Icons.Outlined.SwapHoriz to "Changed a role (${a.detail})"
        "member.remove" -> Icons.Outlined.DeleteOutline to "Removed a member"
        "member.leave" -> Icons.AutoMirrored.Outlined.Login to "Left the community"
        "call.start" -> Icons.Rounded.Call to "Started a ${a.detail} call"
        "channel.archive" -> Icons.Outlined.Campaign to "Archived a channel"
        "channel.restore" -> Icons.Outlined.Campaign to "Restored a channel"
        "channel.update" -> Icons.Outlined.Campaign to "Edited a channel"
        "channel.access" -> Icons.Outlined.Lock to "Changed who can see a channel (${a.detail?.lowercase()?.replace("→", " → ") ?: ""})"
        // Rows from before communities (branches and teams became roles and categories).
        "branch.create", "branch.update", "branch.archive", "branch.restore", "department.create", "team.create", "team.update", "team.archive", "team.restore" ->
            Icons.Outlined.Archive to "Changed the old structure: ${a.action.substringBefore('.')} ${a.detail ?: ""}".trimEnd()
        "community.migration" -> Icons.Outlined.SwapHoriz to "Branches and teams became roles and categories"
        "org.update" -> Icons.Outlined.Edit to "Edited the community's details"
        "org.photo" -> Icons.Outlined.Image to if (a.detail == "removed") "Removed the community photo" else "Changed the community photo"
        else -> Icons.Outlined.History to a.action.replace('.', ' ')
    }
}

/** Batch B4: how long an invitation lasts and how many people it lets in. */
object InviteChoices {
    val USES = listOf(1, 10, 50, 100, 500)
    val HOURS = listOf(1 to R.string.inv_exp_1h, 24 to R.string.inv_exp_1d, 72 to R.string.inv_exp_3d, 168 to R.string.inv_exp_7d, 720 to R.string.inv_exp_30d)
}
