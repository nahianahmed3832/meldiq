package com.meldiq.android.ui.screens.community

import com.meldiq.android.ui.theme.listItemMotion

import android.content.ClipData
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Workspaces
import androidx.compose.material.icons.rounded.Call
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.api.CategoryDto
import com.meldiq.android.data.api.LayoutReq
import com.meldiq.android.data.api.NavPrefsDto
import com.meldiq.android.data.model.LayoutRules
import com.meldiq.android.data.model.NavOp
import com.meldiq.android.data.model.NavPrefsRules
import com.meldiq.android.data.repo.NavPreferences
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.LocalTabBarPadding
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.chats.rememberChatListActions
import com.meldiq.android.ui.screens.home.ConnectionBanner
import com.meldiq.android.ui.screens.home.HomeViewModel
import com.meldiq.android.ui.screens.home.NotificationProblems
import com.meldiq.android.ui.screens.home.SectionEditSheet
import com.meldiq.android.ui.screens.home.WorkspaceHomeRules
import com.meldiq.android.ui.screens.home.customSectionsList
import com.meldiq.android.ui.screens.home.rememberNotificationProblems
import com.meldiq.android.ui.screens.home.roomPeople
import com.meldiq.android.ui.screens.workspace.CategoryNameSheet
import com.meldiq.android.ui.screens.workspace.CreateChannelSheet
import com.meldiq.android.ui.screens.workspace.MoveToCategorySheet
import com.meldiq.android.ui.screens.workspace.WorkspaceList
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.launch

/** The sheets Home's panel can show. */
private sealed interface PanelSheet {
    data object Community : PanelSheet
    /** API 0.46.0: how long to mute the whole community. */
    data object CommunityMute : PanelSheet
    /** Invite people: add them directly or make a link (as Meldiq Web's one Invite dialog). */
    data object Invite : PanelSheet
    data class Category(val key: String) : PanelSheet
    data class Channel(val id: String) : PanelSheet
    data class NewChannel(val categoryId: String?) : PanelSheet
    data object NewCategory : PanelSheet
    data class RenameCategory(val category: CategoryDto) : PanelSheet
    data class DeleteCategory(val category: CategoryDto) : PanelSheet
    data class EditChannel(val id: String) : PanelSheet
    data class DeleteChannel(val id: String) : PanelSheet
    data class MoveTo(val id: String) : PanelSheet
    data object Leave : PanelSheet
    /** Batch B2. */
    data object Notifications : PanelSheet
    data object Arrange : PanelSheet
    /** Batch B3: how long to mute these channels; and a category's own level; and the channel browser. */
    data class MuteFor(val ids: List<String>, val title: String) : PanelSheet
    data class CategoryLevel(val categoryId: String, val name: String) : PanelSheet
    data object Browse : PanelSheet
    data object Spark : PanelSheet
}

/**
 * The Home tab (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §2): your communities on a rail, and the selected one's
 * channels in categories, with everything a long-press or the header offers. Direct messages live on the DMs tab;
 * your own things (profile, Later, reminders, calls) on You.
 */
@Composable
fun CommunityHomeScreen(nav: NavHostController) {
    val container = LocalContainer.current
    // AI Workforce (docs/AI_WORKFORCE.md): the AI agents shortcut, on servers that have them.
    val c = Griip.colors
    val ctx = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val vm = containerViewModel { HomeViewModel(it) }
    val loaded by vm.conversations.collectAsStateWithLifecycle()
    val convs = loaded.orEmpty()
    val users by vm.users.collectAsStateWithLifecycle()
    val orgs by vm.orgs.collectAsStateWithLifecycle()
    val orgError by vm.orgError.collectAsStateWithLifecycle()
    val selectedId by vm.selectedOrg.collectAsStateWithLifecycle()
    val detail by vm.detail.collectAsStateWithLifecycle()
    val serverChannels by vm.serverChannels.collectAsStateWithLifecycle()
    val conn by container.realtime.state.collectAsStateWithLifecycle()
    val call by container.calls.state.collectAsStateWithLifecycle()
    val liveCalls by container.calls.live.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val navPrefs by container.navPrefs.prefs.collectAsStateWithLifecycle()
    val starredIds by container.navPrefs.starred.collectAsStateWithLifecycle()
    val views by container.communityView.views.collectAsStateWithLifecycle()
    val actions = rememberChatListActions()
    val permission = com.meldiq.android.ui.screens.calls.rememberCallPermission()
    val me = container.session.session?.userId
    val barPadding = LocalTabBarPadding.current

    var sheet by remember { mutableStateOf<PanelSheet?>(null) }
    var editingSection by remember { mutableStateOf<com.meldiq.android.ui.screens.home.CustomSection?>(null) }
    var discovery by remember { mutableStateOf(false) }
    var canDeleteChannels by remember { mutableStateOf(false) }
    var tagsAvailable by remember { mutableStateOf(false) }
    var communityPrefs by remember { mutableStateOf(false) }
    var channelPrefs by remember { mutableStateOf(false) }
    // API 0.46.0: a whole community muted for a while, synced with the person's other devices.
    var communityMute by remember { mutableStateOf(false) }
    val railOrder by container.navPrefs.railOrder.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        communityPrefs = container.features.has(ServerFeatures.COMMUNITY_PREFERENCES) == true
        channelPrefs = container.features.has(ServerFeatures.CHANNEL_PREFERENCES) == true
        communityMute = container.features.has(ServerFeatures.COMMUNITY_MUTE) == true
        discovery = container.features.has(ServerFeatures.COMMUNITY_DISCOVERY) == true
        canDeleteChannels = container.features.has(ServerFeatures.CHANNEL_DELETE) == true
        tagsAvailable = container.features.has(ServerFeatures.FORUM_TAGS) == true
    }
    fun toast(text: String) = Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show()

    val list = NavPrefsRules.railOrdered(WorkspaceList.normalize(orgs.orEmpty()), railOrder) { it.id }
    val org = list.firstOrNull { it.id == selectedId }
    val d = detail?.takeIf { it.org.id == org?.id }
    // Batch B8b: the guide's ticked tasks (this phone), guides hidden for now, and unanswered onboarding questions.
    val guideDone by container.guide.done.collectAsStateWithLifecycle()
    var hiddenGuides by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(emptySet<String>()) }
    var onboardingPending by remember { mutableStateOf(false) }
    var onboardingOpen by remember { mutableStateOf(false) }
    LaunchedEffect(d?.org?.id, d?.org?.onboarding) {
        val o = d?.org
        onboardingPending = o != null && o.onboarding && runCatching { container.guide.onboarding(o.id).answered == null }.getOrDefault(false)
    }
    val orgId = org?.id
    val view = views[orgId] ?: com.meldiq.android.data.repo.CommunityViewPrefs.View()
    val orgPrefs = orgId?.let { navPrefs[it] } ?: NavPrefsDto()
    val personalPrefs = navPrefs[NavPreferences.PERSONAL] ?: NavPrefsDto()
    val collapsed = remember(orgPrefs) { orgPrefs.collapsed.toSet() }
    val channels = remember(convs, serverChannels, orgId) { CommunityPanelRules.channels(convs, serverChannels, orgId) }
    val favourites = remember(convs, orgId, orgPrefs, personalPrefs) {
        WorkspaceHomeRules.starred(convs, orgId, orgPrefs.starred + personalPrefs.starred).filter { it.type == "CHANNEL" && it.orgId == orgId }
    }
    val customSections = remember(convs, orgId, orgPrefs) {
        WorkspaceHomeRules.customSections(convs, orgId, orgPrefs.sections.map { (orgId ?: NavPreferences.PERSONAL) to it }).map { s -> s.copy(items = s.items.filter { it.type == "CHANNEL" }) }
            .filter { it.items.isNotEmpty() }
    }
    val placed = remember(orgPrefs, personalPrefs) { NavPrefsRules.placed(orgPrefs) + NavPrefsRules.placed(personalPrefs) }
    val canArrange = d?.permissions?.canManageChannels == true
    val canCreateCategory = d != null && ("channels.create" in d.permissions.effective || d.permissions.canManageOrg)
    val selectedChannel = CommunityPanelRules.selected(view.lastChannel, channels)
    val hidden = remember(orgPrefs, channelPrefs) { if (channelPrefs) orgPrefs.hidden.orEmpty().toSet() else emptySet() }
    val sections = remember(channels, d?.categories, collapsed, selectedChannel, view, placed, canArrange, hidden) {
        CommunityPanelRules.sections(
            channels, d?.categories.orEmpty(), collapsed, selectedChannel, hideMuted = view.hideMuted, unreadOnly = view.unreadOnly,
            placed = placed, keepEmpty = canArrange, hidden = hidden,
        )
    }
    val hiddenCount = remember(channels, hidden) { channels.count { it.id in hidden } }
    val badges = remember(convs) { CommunityPanelRules.rail(convs) }
    val usersById = remember(users) { users.associateBy { it.id } }
    val liveCall = if (call.phase == CallPhase.Idle) convs.firstOrNull { it.activeCallId != null && it.type != "CHANNEL" } else null

    fun categoryOf(key: String) = d?.categories?.firstOrNull { ("category:" + it.id) == key }
    fun open(ch: PanelChannel) {
        orgId?.let { container.communityView.opened(it, ch.id) }
        // Batch B8b: opening a guide task's channel ticks it.
        orgId?.let { id -> scope.launch { container.guide.visited(id, d?.org?.guide, ch.id) } }
        if (ch.joined) nav.navigate(Routes.conversation(ch.id))
        else vm.join(ch.id, then = { id -> nav.navigate(Routes.conversation(id)) }, onError = ::toast)
    }
    fun saveLayout(req: LayoutReq) = scope.launch {
        val id = orgId ?: return@launch
        runCatching { container.orgs.saveLayout(id, req) }
            .onSuccess { if (it.removed > 0) toast(ctx.getString(R.string.cm_moved, it.removed)); vm.reloadDetail() }
            .onFailure { toast(it.friendly()) }
    }
    fun setMuted(targets: List<com.meldiq.android.data.db.ConversationEntity>, mute: Boolean) = scope.launch { targets.forEach { container.navPrefs.setMuted(it, mute) } }
    // With community mute (API 0.46.0), Mute means the community itself, as on Meldiq Web: its channels' own levels stay.
    val communityMuted = com.meldiq.android.data.model.NavPrefsRules.communityMutedUntil(orgPrefs) != null
    /** Batch B3: muting asks for how long (where the server keeps timed mutes); unmuting is immediate. */
    fun muteOrAsk(targets: List<com.meldiq.android.data.db.ConversationEntity>, mute: Boolean, title: String) {
        if (mute && channelPrefs) sheet = PanelSheet.MuteFor(targets.map { it.id }, title) else setMuted(targets, mute)
    }
    fun toggleMute(org: com.meldiq.android.data.api.OrgDto) {
        if (communityMute && communityPrefs) {
            if (communityMuted) container.navPrefs.muteCommunity(org.id, null, mute = false) else sheet = PanelSheet.CommunityMute
        } else {
            val mute = !CommunityPanelRules.allMuted(channels)
            muteOrAsk(CommunityPanelRules.muteTargets(channels, mute), mute, org.name)
        }
    }
    fun copy(text: String) = scope.launch { clipboard.setClipEntry(ClipData.newPlainText("name", text).toClipEntry()); toast(ctx.getString(R.string.nv_copied)) }

    Row(Modifier.fillMaxSize().background(c.background).statusBarsPadding()) {
        CommunityRail(
            // Settings › Appearance: "Use a community's own colours" off keeps Meldiq's colours on the rail too.
            if (settings.communityColors) list else list.map { it.copy(accent = null) }, orgId, badges,
            onSelect = { id -> if (id != orgId) vm.switchOrg(id) },
            onAdd = { nav.navigate(Routes.JOIN + "?code=") },
            onDiscover = if (discovery) ({ nav.navigate(Routes.DISCOVER) }) else null,
            contentPadding = PaddingValues(bottom = barPadding),
            onArrange = if (communityPrefs && list.size > 1) ({ sheet = PanelSheet.Arrange }) else null,
        )
        Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(topStart = 16.dp)).background(c.surface)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = barPadding + 16.dp)) {
                if (org != null && settings.communityColors) item(key = "banner") { CommunityBanner(org.id, org.accent, org.bannerRev) }
                if (org != null) item(key = "header") {
                    PanelHeader(
                        org.name, d?.let { memberCountLabel(it.stats.members) },
                        onMenu = { sheet = PanelSheet.Community },
                        onSearch = { nav.navigate(Routes.SEARCH) },
                        onInvite = if (d?.permissions?.canInvite == true) ({ sheet = PanelSheet.Invite }) else null,
                    )
                }
                item(key = "connection") { ConnectionBanner(conn, Modifier.padding(horizontal = 8.dp, vertical = 2.dp)) { container.realtime.reconnectNow() } }
                item(key = "notification-problems") {
                    NotificationProblems(rememberNotificationProblems(settings), Modifier.padding(horizontal = 8.dp), onlySevere = true, max = 1)
                }
                orgError?.let { error ->
                    if (orgs.isNullOrEmpty()) item(key = "org-error") {
                        StatusBanner(
                            stringResource(R.string.home_workspace_error, error), BannerKind.Warning, Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            action = stringResource(R.string.common_retry), onAction = { vm.refresh() },
                        )
                    }
                }
                liveCall?.let { live ->
                    item(key = "live-call") {
                        StatusBanner(
                            stringResource(R.string.nv_call_in_progress, com.meldiq.android.ui.screens.chats.listTitle(live, me)), BannerKind.Success,
                            Modifier.padding(horizontal = 8.dp, vertical = 4.dp), icon = Icons.Rounded.Call, action = stringResource(R.string.vr_join),
                            onAction = { live.activeCallId?.let { callId -> permission(live.activeCallVideo) { scope.launch { container.calls.join(live.id, callId, live.activeCallVideo) } } } },
                        )
                    }
                }
                if (orgs == null || (loaded == null && org != null)) {
                    item(key = "loading") { ShimmerList(6, Modifier.padding(top = 12.dp)) }
                    return@LazyColumn
                }
                if (org == null) {
                    item(key = "none") {
                        Column {
                            EmptyState(
                                Icons.Outlined.Workspaces, stringResource(R.string.cm_none_title), stringResource(R.string.cm_none_body),
                                action = if (discovery) stringResource(R.string.cm_discover) else null, onAction = if (discovery) ({ nav.navigate(Routes.DISCOVER) }) else null,
                            )
                            PillButton(stringResource(R.string.cm_join_or_create), { nav.navigate(Routes.JOIN + "?code=") }, Modifier.fillMaxWidth().padding(horizontal = 16.dp), tone = ButtonTone.Glass, height = 50.dp)
                        }
                    }
                    return@LazyColumn
                }
                // Batch B8b: onboarding questions not answered yet, and the community guide.
                if (onboardingPending && org.myRole != "GUEST") item(key = "onboarding") {
                    StatusBanner(
                        stringResource(R.string.b8b_onboarding_banner), BannerKind.Info, Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        action = stringResource(R.string.b8b_onboarding_answer), onAction = { onboardingOpen = true },
                    )
                }
                d?.org?.guide?.takeIf { org.id !in hiddenGuides }?.let { guide ->
                    item(key = "guide") {
                        GuideCard(
                            guide, guideDone[org.id].orEmpty(),
                            onOpenChannel = { id -> channels.firstOrNull { it.id == id }?.let(::open) ?: nav.navigate(Routes.conversation(id)) },
                            onHide = { hiddenGuides = hiddenGuides + org.id },
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
                item(key = "events") { PanelShortcut(Icons.Outlined.Event, stringResource(R.string.cm_events)) { nav.navigate(Routes.meetings(org.id, canSchedule = org.myRole != "GUEST")) } }
                if (d?.permissions?.canViewDirectory == true) item(key = "members") { PanelShortcut(Icons.Outlined.People, stringResource(R.string.cm_stat_members)) { nav.navigate(Routes.members(org.id)) } }
                if (favourites.isNotEmpty()) {
                    item(key = "fav-header") { PanelFavouritesHeader() }
                    items(favourites, key = { "fav-" + it.id }) { conv ->
                        val ch = channels.firstOrNull { it.id == conv.id } ?: return@items
                        PanelChannelRow(ch, ch.id == selectedChannel, onClick = { open(ch) }, onLongPress = { sheet = PanelSheet.Channel(ch.id) }, live = liveCalls[ch.id])
                    }
                }
                customSectionsList(
                    customSections, me,
                    onToggle = { s -> container.navPrefs.change(s.workspaceId, NavOp.CollapseSection(s.id, !s.collapsed)) },
                    onEdit = { editingSection = it },
                    onOpen = { conv -> channels.firstOrNull { it.id == conv.id }?.let(::open) ?: nav.navigate(Routes.conversation(conv.id)) },
                    onLongPress = { conv -> sheet = PanelSheet.Channel(conv.id) },
                )
                if (sections.isEmpty()) item(key = "no-channels") {
                    com.meldiq.android.ui.screens.home.QuietLine(
                        stringResource(if (view.unreadOnly) R.string.home_no_unread_channels else R.string.home_no_channels), Modifier.padding(top = 12.dp),
                    )
                }
                sections.forEach { section ->
                    val category = section.categoryId?.let { id -> d?.categories?.firstOrNull { it.id == id } }
                    val canCreateHere = category?.canCreateChannels == true || (section.categoryId == null && d?.permissions?.canCreateChannels == true)
                    // Batch B16: opening or closing a category moves only its rows (they fade, the rest slides into place).
                    item(key = "section-" + section.key) {
                        Box(listItemMotion()) {
                        PanelSectionHeader(
                            section.title ?: stringResource(R.string.cm_channels), section.collapsed, section.unreadChannels,
                            onToggle = { orgId?.let { container.navPrefs.change(it, NavOp.Collapse(section.key, !section.collapsed)) } },
                            onLongPress = { sheet = PanelSheet.Category(section.key) },
                            onAdd = if (canCreateHere) ({ sheet = PanelSheet.NewChannel(section.categoryId) }) else null,
                        )
                        }
                    }
                    if (section.all.isEmpty() && !section.collapsed && canArrange) item(key = "empty-" + section.key) { Box(listItemMotion()) { PanelEmptyCategory() } }
                    items(section.shown, key = { "ch-" + it.id }) { ch ->
                        Column(listItemMotion()) {
                            PanelChannelRow(ch, ch.id == selectedChannel, onClick = { open(ch) }, onLongPress = { sheet = PanelSheet.Channel(ch.id) }, live = liveCalls[ch.id])
                            if (ch.voice) ch.conv?.let { conv -> roomPeople(conv).takeIf { it.isNotEmpty() }?.let { PanelVoicePeople(it, usersById) } }
                        }
                    }
                }
                // Batch B3: hidden channels are one tap away (Discord's "Show all").
                if (hiddenCount > 0) item(key = "hidden-channels") {
                    PanelShortcut(Icons.Outlined.VisibilityOff, stringResource(R.string.hc_hidden_n, hiddenCount)) { sheet = PanelSheet.Browse }
                }
            }
        }
    }

    // ───────────── Sheets ─────────────
    val s = sheet
    if (s != null && org != null) when (s) {
        PanelSheet.Community -> CommunityMenuSheet(
            org, d?.stats?.members ?: org.memberCount, communityMuted || CommunityPanelRules.allMuted(channels), view.hideMuted, view.unreadOnly,
            CommunityMenuActions(
                onInvite = if (d?.permissions?.canInvite == true) ({ sheet = PanelSheet.Invite }) else null,
                onToggleMute = if (channels.any { it.joined }) ({ toggleMute(org) }) else null,
                onSettings = { nav.navigate(Routes.WORKSPACE) },
                onMarkRead = CommunityPanelRules.markReadTargets(channels).takeIf { it.isNotEmpty() }?.let { t -> { actions.markAllRead(t); toast(ctx.getString(R.string.r3_marked_all_read)) } },
                onNewChannel = if (d?.permissions?.canCreateChannels == true) ({ sheet = PanelSheet.NewChannel(null) }) else null,
                onNewCategory = if (canCreateCategory) ({ sheet = PanelSheet.NewCategory }) else null,
                onEvents = { nav.navigate(Routes.meetings(org.id, canSchedule = org.myRole != "GUEST")) },
                onMembers = if (d?.permissions?.canViewDirectory == true) ({ nav.navigate(Routes.members(org.id)) }) else null,
                onHideMuted = { container.communityView.setHideMuted(org.id, it) },
                onUnreadOnly = { container.communityView.setUnreadOnly(org.id, it) },
                onCopyName = { copy(org.name) },
                onLeave = if (org.myRole != "OWNER") ({ sheet = PanelSheet.Leave }) else null,
                onNotifications = if (communityPrefs) ({ sheet = PanelSheet.Notifications }) else null,
                onArrange = if (communityPrefs && list.size > 1) ({ sheet = PanelSheet.Arrange }) else null,
                onBrowse = if (channelPrefs) ({ sheet = PanelSheet.Browse }) else null,
                onSpark = if (org.myRole != "GUEST") ({ sheet = PanelSheet.Spark }) else null,
            ),
            onDismiss = { if (sheet == s) sheet = null },
        )
        is PanelSheet.Category -> {
            val section = sections.firstOrNull { it.key == s.key }
            val category = categoryOf(s.key)
            val order = d?.categories.orEmpty().sortedBy { it.position }.map { it.id }
            val i = category?.let { order.indexOf(it.id) } ?: -1
            val items = CommunityMenuRules.category(
                isCategory = category != null, collapsed = section?.collapsed == true,
                hasNews = section?.all?.any { it.joined && it.hasNews } == true, hasJoined = section?.all?.any { it.joined } == true,
                allMuted = CommunityPanelRules.allMuted(section?.all.orEmpty()),
                canCreate = category?.canCreateChannels == true || (category == null && d?.permissions?.canCreateChannels == true),
                canManage = category?.canManage == true && canArrange, canMoveUp = i > 0, canMoveDown = i in 0 until order.lastIndex,
                canSetLevel = channelPrefs,
            )
            CategoryMenuSheet(section?.title ?: stringResource(R.string.cm_channels), items, onDismiss = { if (sheet == s) sheet = null }) { item ->
                val all = section?.all.orEmpty()
                when (item) {
                    CategoryMenuItem.MARK_READ -> actions.markAllRead(CommunityPanelRules.markReadTargets(all))
                    CategoryMenuItem.COLLAPSE, CategoryMenuItem.EXPAND -> container.navPrefs.change(org.id, NavOp.Collapse(s.key, item == CategoryMenuItem.COLLAPSE))
                    CategoryMenuItem.COLLAPSE_ALL -> sections.filter { !it.collapsed }.forEach { container.navPrefs.change(org.id, NavOp.Collapse(it.key, true)) }
                    CategoryMenuItem.MUTE -> muteOrAsk(CommunityPanelRules.muteTargets(all, true), true, section?.title ?: ctx.getString(R.string.cm_channels))
                    CategoryMenuItem.NOTIFY -> category?.let { sheet = PanelSheet.CategoryLevel(it.id, it.name) }
                    CategoryMenuItem.UNMUTE -> setMuted(CommunityPanelRules.muteTargets(all, false), false)
                    CategoryMenuItem.NEW_CHANNEL -> sheet = PanelSheet.NewChannel(category?.id)
                    CategoryMenuItem.RENAME -> category?.let { sheet = PanelSheet.RenameCategory(it) }
                    CategoryMenuItem.PERMISSIONS -> category?.let { nav.navigate(Routes.permissions(category = true, id = it.id, name = it.name)) }
                    CategoryMenuItem.MOVE_UP, CategoryMenuItem.MOVE_DOWN -> category?.let {
                        saveLayout(LayoutReq(categories = LayoutRules.move(order, it.id, if (item == CategoryMenuItem.MOVE_UP) -1 else 1)))
                    }
                    CategoryMenuItem.DELETE -> category?.let { sheet = PanelSheet.DeleteCategory(it) }
                }
            }
        }
        is PanelSheet.Channel -> channels.firstOrNull { it.id == s.id }?.let { ch ->
            val siblings = sections.firstOrNull { sec -> sec.all.any { it.id == ch.id } }?.all.orEmpty().map { it.id }
            val i = siblings.indexOf(ch.id)
            val items = CommunityMenuRules.channel(
                ch, starred = ch.id in starredIds, canArrange = canArrange, canMoveUp = i > 0, canMoveDown = i in 0 until siblings.lastIndex,
                canDelete = canDeleteChannels && ch.joined, canHide = channelPrefs, hidden = ch.id in hidden,
            )
            ChannelMenuSheet(ch, items, onDismiss = { if (sheet == s) sheet = null }) { item ->
                when (item) {
                    ChannelMenuItem.MARK_READ -> ch.conv?.let { actions.markAllRead(listOf(it)) }
                    ChannelMenuItem.FAVOURITE, ChannelMenuItem.UNFAVOURITE -> ch.conv?.let { actions.toggleStar(it) }
                    ChannelMenuItem.MUTE, ChannelMenuItem.UNMUTE -> ch.conv?.let { muteOrAsk(listOf(it), item == ChannelMenuItem.MUTE, "#" + ch.name) }
                    ChannelMenuItem.HIDE, ChannelMenuItem.SHOW -> container.navPrefs.setHidden(org.id, ch.id, item == ChannelMenuItem.HIDE)
                    ChannelMenuItem.COPY_NAME -> copy(ch.name)
                    ChannelMenuItem.EDIT -> sheet = PanelSheet.EditChannel(ch.id)
                    ChannelMenuItem.PERMISSIONS -> nav.navigate(Routes.permissions(category = false, id = ch.id, name = ch.name))
                    ChannelMenuItem.MOVE_TO -> sheet = PanelSheet.MoveTo(ch.id)
                    ChannelMenuItem.MOVE_UP, ChannelMenuItem.MOVE_DOWN ->
                        saveLayout(LayoutReq(channels = LayoutRules.positions(ch.categoryId, LayoutRules.move(siblings, ch.id, if (item == ChannelMenuItem.MOVE_UP) -1 else 1))))
                    ChannelMenuItem.ARCHIVE, ChannelMenuItem.RESTORE -> scope.launch {
                        runCatching { container.conversations.update(ch.id, archived = item == ChannelMenuItem.ARCHIVE) }
                            .onSuccess { vm.reloadDetail() }.onFailure { toast(it.friendly()) }
                    }
                    ChannelMenuItem.DELETE -> sheet = PanelSheet.DeleteChannel(ch.id)
                }
            }
        }
        is PanelSheet.NewChannel -> d?.let { det ->
            CreateChannelSheet(
                det, s.categoryId, { if (sheet == s) sheet = null },
                onPrivateCreated = { id -> vm.reloadDetail(); nav.navigate(Routes.info(id)) },
            ) { id -> vm.reloadDetail(); orgId?.let { container.communityView.opened(it, id) }; nav.navigate(Routes.conversation(id)) }
        }
        PanelSheet.NewCategory -> CategoryNameSheet(org.id, null, { if (sheet == s) sheet = null }) { vm.reloadDetail() }
        is PanelSheet.RenameCategory -> CategoryNameSheet(org.id, s.category, { if (sheet == s) sheet = null }) { vm.reloadDetail() }
        is PanelSheet.DeleteCategory -> ConfirmDialog(
            stringResource(R.string.cm_delete_category_title, s.category.name), stringResource(R.string.cm_delete_category_body),
            stringResource(R.string.cm_delete), onConfirm = {
                sheet = null
                scope.launch { runCatching { container.orgs.deleteCategory(s.category.id) }.onSuccess { vm.reloadDetail() }.onFailure { toast(it.friendly()) } }
            }, onDismiss = { sheet = null }, destructive = true,
        )
        is PanelSheet.EditChannel -> convs.firstOrNull { it.id == s.id }?.let { conv ->
            val canChangeAccess = d != null && ("channels.visibility" in d.permissions.effective || d.permissions.canManageOrg)
            EditChannelSheet(conv, canChangeAccess, tagsAvailable, onDismiss = { if (sheet == s) sheet = null }) { vm.reloadDetail() }
        }
        is PanelSheet.DeleteChannel -> convs.firstOrNull { it.id == s.id }?.let { conv ->
            DeleteChannelSheet(
                conv, onDismiss = { if (sheet == s) sheet = null },
                onArchive = if (!conv.archived) ({ scope.launch { runCatching { container.conversations.update(conv.id, archived = true) }.onFailure { toast(it.friendly()) } } }) else null,
            ) { toast(ctx.getString(R.string.nv_channel_deleted, conv.name.orEmpty())); vm.reloadDetail() }
        }
        is PanelSheet.MoveTo -> channels.firstOrNull { it.id == s.id }?.let { ch ->
            MoveToCategorySheet(ch.categoryId, d?.categories.orEmpty(), { if (sheet == s) sheet = null }) { target ->
                val targetIds = sections.firstOrNull { it.categoryId == target }?.all.orEmpty().map { it.id }
                saveLayout(LayoutReq(channels = LayoutRules.moveTo(ch.id, target, targetIds)))
            }
        }
        PanelSheet.Leave -> ConfirmDialog(
            stringResource(R.string.nv_leave_title, org.name), stringResource(R.string.nv_leave_body), stringResource(R.string.nv_leave_community),
            onConfirm = {
                sheet = null
                val myId = me ?: return@ConfirmDialog
                scope.launch {
                    runCatching { container.orgs.leave(org.id, myId) }
                        .onSuccess { toast(ctx.getString(R.string.ws_left, org.name)); vm.refresh() }
                        .onFailure { toast(it.friendly()) }
                }
            },
            onDismiss = { sheet = null }, destructive = true,
        )
        PanelSheet.Notifications -> CommunityNotificationsSheet(
            org.name, CommunityPanelRules.allMuted(channels), orgPrefs, channels,
            CommunityNotifyActions(
                onToggleMute = if (channels.any { it.joined }) ({ toggleMute(org) }) else null,
                onLevel = { level -> container.navPrefs.setCommunityNotify(org.id, level = level) },
                onSuppressEveryone = { on -> container.navPrefs.setCommunityNotify(org.id, suppressEveryone = on) },
                onChannelLevel = { ch, level ->
                    val conv = ch.conv
                    if (conv != null) scope.launch { if (level == null) container.navPrefs.resetLevel(conv) else container.navPrefs.setLevel(conv, level) }
                },
            ),
            onDismiss = { if (sheet == s) sheet = null },
        )
        PanelSheet.Arrange -> ArrangeCommunitiesSheet(list, onOrder = { container.navPrefs.setRailOrder(it) }, onDismiss = { if (sheet == s) sheet = null })
        PanelSheet.Invite -> InvitePeopleSheet(
            org, canAddDirectly = true,
            onManage = { sheet = null; nav.navigate(Routes.invites(org.id)) },
            onDismiss = { if (sheet == s) sheet = null },
        )
        PanelSheet.CommunityMute -> MuteForSheet(org.name, timed = true, onPick = { duration ->
            container.navPrefs.muteCommunity(org.id, duration)
        }, onDismiss = { if (sheet == s) sheet = null })
        is PanelSheet.MuteFor -> MuteForSheet(s.title, timed = channelPrefs, onPick = { duration ->
            container.navPrefs.muteFor(channels.filter { it.id in s.ids }.mapNotNull { it.conv }, duration)
        }, onDismiss = { if (sheet == s) sheet = null })
        is PanelSheet.CategoryLevel -> CategoryLevelSheet(s.name, orgPrefs, s.categoryId, onPick = { level ->
            container.navPrefs.setCategoryLevel(org.id, s.categoryId, level)
        }, onDismiss = { if (sheet == s) sheet = null })
        PanelSheet.Spark -> com.meldiq.android.ui.screens.mojo.CommunitySparkSheet(org, onSeePlans = { sheet = null; nav.navigate(Routes.MOJO) }) { if (sheet == s) sheet = null }
        PanelSheet.Browse -> {
            val all = remember(channels, d?.categories) {
                CommunityPanelRules.sections(channels, d?.categories.orEmpty(), emptySet(), keepEmpty = false)
            }
            val untitled = stringResource(R.string.cm_channels)
            BrowseChannelsSheet(
                all.map { (it.title ?: untitled) to it.all }, hidden,
                onShow = { ch, show -> container.navPrefs.setHidden(org.id, ch.id, !show) },
                onShowAll = if (hidden.isNotEmpty()) ({ hidden.forEach { id -> container.navPrefs.setHidden(org.id, id, false) } }) else null,
                onDismiss = { if (sheet == s) sheet = null },
            )
        }
    }
    editingSection?.let { section -> SectionEditSheet(section, onDismiss = { editingSection = null }) }
    if (onboardingOpen) d?.org?.id?.let { id ->
        OnboardingSheet(id, onDismiss = { onboardingOpen = false }, onDone = { onboardingOpen = false; onboardingPending = false; vm.reloadDetail() })
    }
}
