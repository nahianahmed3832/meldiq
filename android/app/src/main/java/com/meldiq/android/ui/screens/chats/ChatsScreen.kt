package com.meldiq.android.ui.screens.chats

import androidx.compose.foundation.layout.Box
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.MarkChatUnread
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import com.meldiq.android.ui.components.AccentChip
import com.meldiq.android.ui.theme.Motion
import androidx.compose.ui.Alignment
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.ui.res.stringResource
import com.meldiq.android.R
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.call.CallPhase
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.ShimmerList
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.data.api.ResolveRes
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.repo.GlobalAddress
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.ArrowKnob
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.LargeHeader
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.home.ConnectionBanner
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

/**
 * Lets another screen open the DMs tab with a filter: Home's "See all" under Unread DMs asks for [ChatListRules.UNREAD].
 * The DMs tab takes the request once, the next time it is shown.
 */
@Stable
class DmListRequest {
    var filter by mutableStateOf<Int?>(null)
        private set

    fun open(filter: Int) {
        this.filter = filter
    }

    fun consume(): Int? = filter.also { this.filter = null }
}

/**
 * The DMs tab (UI-002): direct messages and personal groups, with search, the name filter, the All / Unread / Direct /
 * Groups chips, swipe and long-press actions, and the archived list. Channels are on Home. The tab bar is drawn by
 * MainNav over it.
 */
@Composable
fun ChatsScreen(nav: NavHostController, request: DmListRequest) = ChatsHome(nav, request)

@Composable
private fun ChatsHome(nav: NavHostController, request: DmListRequest) {
    val container = LocalContainer.current
    val c = Griip.colors
    val me = container.session.session?.userId
    // From a ViewModel that outlives this screen while a chat is open on top of it: coming back, the list is drawn with
    // its rows at once, so the saved scroll position is restored. (Collected here with an empty start value, the first
    // frame had no rows and the list jumped back to the top every time a chat was closed.)
    val vm = com.meldiq.android.ui.containerViewModel { ChatsViewModel(it) }
    val loaded by vm.conversations.collectAsStateWithLifecycle()
    // Batch B6: message requests wait under their own row, not in the list.
    val requests = remember(loaded) { com.meldiq.android.data.model.RequestRules.incoming(loaded.orEmpty()) }
    val convs = remember(loaded) { com.meldiq.android.data.model.RequestRules.notRequests(loaded.orEmpty()) }
    val users by vm.users.collectAsStateWithLifecycle()
    val typing by container.messages.typing.collectAsStateWithLifecycle()
    val conn by container.realtime.state.collectAsStateWithLifecycle()
    val call by container.calls.state.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableIntStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    var actionsFor by remember { mutableStateOf<ConversationEntity?>(null) }
    var movingFor by remember { mutableStateOf<ConversationEntity?>(null) }
    // The archived list (local to this phone), and the chat just archived, for Undo.
    var archivedView by rememberSaveable { mutableStateOf(false) }
    var undo by remember { mutableStateOf<ConversationEntity?>(null) }
    androidx.activity.compose.BackHandler(enabled = archivedView) { archivedView = false }
    LaunchedEffect(undo) { if (undo != null) { delay(5_000); undo = null } }
    // Home's "See all" (unread DMs): show that filter on the main list.
    LaunchedEffect(request.filter) {
        request.consume()?.let {
            filter = it
            query = ""
            archivedView = false
        }
    }
    var refreshing by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    val permission = com.meldiq.android.ui.screens.calls.rememberCallPermission()
    val actions = rememberChatListActions()
    LaunchedEffect(Unit) { runCatching { container.conversations.refresh() }; refreshing = false }

    val filters = listOf(R.string.filter_all, R.string.filter_unread, R.string.filter_direct, R.string.filter_groups).map { stringResource(it) }
    val shown = ChatListRules.visible(convs, filter, query, archivedView, peopleOnly = true) { ConversationRepository.title(it, me) }
    val archivedInfo = ChatListRules.archived(convs)
    val noPeopleChats = convs.none(ChatListRules::isPeople)
    fun toggleArchive(conv: ConversationEntity) {
        val archive = !ChatListRules.isArchived(conv)
        actions.setArchived(conv, archive)
        undo = if (archive) conv else null
    }
    val online = users.associate { it.id to it.online }
    val liveCall = if (call.phase == CallPhase.Idle) convs.firstOrNull { it.activeCallId != null } else null
    // What the app already does, beside a new message (the New button): groups, calls, people, invites.
    val menu = listOf(
        HomeMenuItem(stringResource(R.string.chats_new_group), Icons.Outlined.GroupAdd) { nav.navigate(Routes.NEW_CHAT + "?mode=group") },
        HomeMenuItem(stringResource(R.string.home_start_call), Icons.Outlined.Call) { nav.navigate(Routes.NEW_CHAT + "?mode=call") },
        HomeMenuItem(stringResource(R.string.home_call_history), Icons.Outlined.History) { nav.navigate(Routes.CALLS) },
        HomeMenuItem(stringResource(R.string.contacts_title), Icons.Outlined.People) { nav.navigate(Routes.CONTACTS) },
        HomeMenuItem(stringResource(R.string.b6_connections), Icons.Outlined.PersonAdd) { nav.navigate(Routes.PEOPLE) },
        HomeMenuItem(stringResource(R.string.contacts_invite), Icons.Outlined.QrCodeScanner) { nav.navigate(Routes.JOIN + "?code=") },
    )
    val list = rememberLazyListState()
    val scrolled by remember { derivedStateOf { list.firstVisibleItemIndex > 0 || list.firstVisibleItemScrollOffset > 0 } }
    val fabVisible by com.meldiq.android.ui.screens.home.rememberFabVisible(list)
    val barPadding = com.meldiq.android.ui.LocalTabBarPadding.current
    var serverNoticeSeen by remember { mutableStateOf(container.messages.history.noticeSeen) }

    Box(Modifier.fillMaxSize().background(c.background)) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 88.dp + barPadding)) {
            if (archivedView) {
                item(key = "archived-bar") {
                    GriipTopBar(
                        stringResource(R.string.chats_archived_title), subtitle = stringResource(R.string.chats_archived_sub),
                        onBack = { archivedView = false },
                    )
                }
                item(key = "archived-filter") { SearchPill(query, { query = it }, stringResource(R.string.chats_filter_hint), Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) }
            } else item(key = "header") {
                // A warm cocoa glow behind the header that settles into the list's background.
                Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(c.canvasTop, c.canvasMid, c.background)))) {
                    HomeTopBar(stringResource(R.string.nav_dms), onSearch = { nav.navigate(Routes.SEARCH) }, menu = menu)
                    SearchPill(query, { query = it }, stringResource(R.string.chats_filter_hint), Modifier.padding(horizontal = Space.gutter, vertical = 6.dp))
                    Spacer(Modifier.height(6.dp))
                    ChipRow {
                        filters.forEachIndexed { i, f ->
                            AccentChip(f, filter == i, { filter = i }, count = if (i == ChatListRules.UNREAD) ChatListRules.unreadCount(convs, peopleOnly = true) else null)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
            item(key = "connection") { ConnectionBanner(conn, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) { container.realtime.reconnectNow() } }
            // API 0.56.0 (the owner's decision of 2026-10-28): said once, plainly, where messages are kept now.
            if (!archivedView && !serverNoticeSeen) item(key = "server-notice") {
                StatusBanner(
                    stringResource(R.string.srv_notice), BannerKind.Info, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp),
                    action = stringResource(R.string.srv_notice_ok), onAction = { container.messages.history.noticeSeen = true; serverNoticeSeen = true },
                )
            }
            // The floating redesign (2026-10-28): invite friends to Meldiq itself (community invitations stay in each community),
            // and a small Meldiq Mojo card.
            if (!archivedView && query.isBlank()) {
                item(key = "invite-meldiq") { MeldiqInviteCard(Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
                item(key = "mojo-promo") { MojoPromoCard({ nav.navigate(Routes.MOJO) }, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
            }
            if (liveCall != null) item(key = "live-call") {
                val title = listTitle(liveCall, me)
                StatusBanner(
                    "${if (liveCall.activeCallVideo) "Video" else "Voice"} call in progress · $title", BannerKind.Success,
                    Modifier.padding(horizontal = Space.gutter, vertical = 4.dp), icon = Icons.Rounded.Call, action = "Join",
                    onAction = { permission(liveCall.activeCallVideo) { scope.launch { container.calls.join(liveCall.id, liveCall.activeCallId!!, liveCall.activeCallVideo) } } },
                )
            }
            if (!archivedView && query.isBlank() && requests.isNotEmpty()) item(key = "requests") {
                ListCard(
                    stringResource(R.string.b6_requests), Modifier.padding(horizontal = 8.dp, vertical = 2.dp).animateItem(),
                    subtitle = stringResource(R.string.b6_requests_sub, requests.size),
                    leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.MarkChatUnread, c.peach, c.peachSoft, size = 44.dp) },
                    trailing = { ArrowKnob() },
                    onClick = { nav.navigate(Routes.REQUESTS) },
                )
            }
            if (!archivedView && query.isBlank() && archivedInfo.chats > 0) item(key = "archived") {
                ListCard(
                    stringResource(R.string.chats_archived), Modifier.padding(horizontal = 8.dp, vertical = 2.dp).animateItem(),
                    subtitle = "${archivedInfo.chats} chat${if (archivedInfo.chats == 1) "" else "s"}" +
                        if (archivedInfo.unreadChats > 0) " · ${archivedInfo.unreadChats} unread" else "",
                    leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.Archive, c.lavender, c.lavenderSoft, size = 44.dp) },
                    trailing = { ArrowKnob() },
                    onClick = { archivedView = true },
                )
            }
            if (loaded == null || (refreshing && convs.isEmpty())) item(key = "loading") { ShimmerList(6, Modifier.padding(top = 8.dp)) }
            else if (shown.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        Icons.Outlined.ChatBubbleOutline,
                        when {
                            noPeopleChats && !archivedView && query.isBlank() -> stringResource(R.string.chats_empty)
                            query.isNotBlank() -> "No chats named \"${query.trim()}\""
                            archivedView -> "No archived chats"
                            else -> "Nothing here"
                        },
                        when {
                            noPeopleChats && !archivedView && query.isBlank() -> stringResource(R.string.chats_empty_body)
                            query.isNotBlank() -> "Search also finds people, channels and message text."
                            archivedView -> "Swipe a chat left to archive it. You stay in it and can restore it any time."
                            else -> "Try another filter."
                        },
                        action = when {
                            archivedView && query.isBlank() -> null
                            noPeopleChats && query.isBlank() -> "New message"
                            query.isNotBlank() -> "Search everywhere"
                            else -> null
                        },
                        onAction = { if (query.isBlank()) nav.navigate(Routes.NEW_CHAT + "?mode=dm") else nav.navigate(Routes.SEARCH) },
                    )
                }
            }
            items(shown, key = { it.id }) { conv ->
                val peer = ConversationRepository.peer(conv, me)
                val names = typing[conv.id]?.keys?.mapNotNull { id -> users.firstOrNull { it.id == id }?.displayName } ?: emptyList()
                SwipeableChat(
                    archived = ChatListRules.isArchived(conv), unread = conv.unreadCount > 0, muted = conv.muted,
                    onToggleRead = { actions.toggleRead(conv) }, onToggleArchive = { toggleArchive(conv) }, onToggleMute = { actions.toggleMute(conv) },
                    modifier = Modifier.animateItem(),
                ) {
                    ConversationRow(
                        conv, me, names, peer?.let { online[it.id] },
                        onClick = { nav.navigate(Routes.conversation(conv.id)) },
                        onLongClick = { actionsFor = conv },
                    )
                }
            }
        }
        // Once the list scrolls under the transparent status bar, a scrim keeps the clock and icons readable.
        val scrim by animateFloatAsState(if (scrolled) 0.94f else 0f, Motion.quick(), label = "statusScrim")
        Box(Modifier.fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).graphicsLayer { alpha = scrim }.background(c.background))
        com.meldiq.android.ui.screens.home.ComposeFab(
            stringResource(R.string.chats_new_chat), { nav.navigate(Routes.NEW_CHAT + "?mode=dm") },
            Modifier.align(Alignment.BottomEnd).padding(end = Space.gutter, bottom = barPadding + 12.dp),
            visible = !archivedView && fabVisible && undo == null,
        )
        undo?.let { conv ->
            com.meldiq.android.ui.components.UndoBar(
                stringResource(R.string.chats_archived_toast, listTitle(conv, me)), onUndo = {
                    actions.setArchived(conv, false)
                    undo = null
                },
                Modifier.align(Alignment.BottomCenter).padding(start = Space.gutter, end = Space.gutter, bottom = 16.dp + barPadding),
            )
        }
    }

    actionsFor?.let { conv ->
        val starredIds by container.navPrefs.starred.collectAsStateWithLifecycle()
        ChatActionsSheet(
            conv, me, onDismiss = { actionsFor = null },
            onToggleRead = { actions.toggleRead(conv) },
            onToggleArchive = { toggleArchive(conv) }, onInfo = { nav.navigate(Routes.info(conv.id)) },
            starred = conv.id in starredIds, onToggleStar = { actions.toggleStar(conv) },
            onMoveToSection = { movingFor = conv },
        )
    }
    movingFor?.let { conv -> com.meldiq.android.ui.screens.home.SectionPickerSheet(conv, onDismiss = { movingFor = null }) }
}

/** Pick people → open a DM, create a group (mode=group) or start a call (mode=call). */
@Composable
fun NewChatScreen(nav: NavHostController, mode: String?, with: String? = null) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var colleagues by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    val picked = remember { mutableStateListOf<UserDto>() }
    var groupName by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // Someone on another server, found by their full address (exact lookup only).
    var remote by remember { mutableStateOf<ResolveRes?>(null) }
    var remoteSheet by remember { mutableStateOf<ResolveRes?>(null) }
    var resolving by remember { mutableStateOf(false) }
    val group = mode == "group"
    val call = mode == "call"
    val me = container.session.session?.userId
    val permission = com.meldiq.android.ui.screens.calls.rememberCallPermission()

    // Batch B14: "New group" from a DM's details starts with that person picked.
    LaunchedEffect(with) {
        val id = with?.takeIf { it != me } ?: return@LaunchedEffect
        if (picked.none { it.id == id }) runCatching { container.users.fetch(id) }.onSuccess { u -> if (picked.none { it.id == u.id }) picked.add(u) }
    }
    LaunchedEffect(Unit) {
        val org = container.orgs.selectedOrg.value ?: runCatching { container.orgs.orgs().firstOrNull()?.id }.getOrNull()
        if (org != null) colleagues = runCatching { container.orgs.members(org) }.getOrDefault(emptyList()).filter { it.id != me }
    }
    LaunchedEffect(q) {
        remote = null
        error = null
        if (q.length < 2) { results = emptyList(); return@LaunchedEffect }
        if (GlobalAddress.looksLike(q) && !group) {
            results = emptyList()
            delay(500)
            resolving = true
            remote = runCatching { container.federation.resolve(q) }.onFailure { error = it.friendly() }.getOrNull()
            resolving = false
            return@LaunchedEffect
        }
        // An exact international phone number: found only if its owner lets people find them by it (docs/PROFILE_AND_PRIVACY.md).
        val phone = com.meldiq.android.data.model.ProfileRules.normalizePhone(q)?.takeIf { it.startsWith("+") }
        if (phone != null) {
            delay(500)
            results = runCatching { listOf(container.api.get<com.meldiq.android.data.api.UserRes>("/v1/users/by-phone?phone=${java.net.URLEncoder.encode(phone, "UTF-8")}").user) }
                .onFailure { error = "No one on Meldiq lets people find them by this number" }.getOrDefault(emptyList())
            return@LaunchedEffect
        }
        delay(250)
        results = runCatching { container.users.search(q) }.onFailure { error = it.friendly() }.getOrDefault(emptyList())
    }
    val list = if (q.length >= 2) results else colleagues

    fun openNow(u: UserDto) {
        scope.launch {
            runCatching { container.conversations.openDm(u.id) }
                .onSuccess { conv ->
                    nav.popBackStack()
                    if (call) container.calls.startCall(conv.id, video = false) else nav.navigate(Routes.conversation(conv.id))
                }
                .onFailure { error = it.friendly() }
        }
    }

    fun open(u: UserDto) {
        if (call) { permission(false) { openNow(u) }; return }
        openNow(u)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        GriipTopBar(if (group) "New group" else if (call) "Start a call" else "New message", onBack = { nav.popBackStack() })
        if (group) {
            GriipTextField(groupName, { groupName = it.take(60) }, "Group name", Modifier.padding(horizontal = Space.gutter), placeholder = "Launch crew", leadingIcon = Icons.Rounded.Groups,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
            Spacer(Modifier.height(12.dp))
        }
        SearchPill(q, { q = it }, if (group) "Search by name or @username" else "Name, @username or @name:server", Modifier.padding(horizontal = Space.gutter, vertical = 4.dp))
        if (!group && !call) {
            ListCard(
                "New group", Modifier.padding(horizontal = 8.dp, vertical = 4.dp), subtitle = "Pick people to add",
                leading = { com.meldiq.android.ui.components.IconTile(Icons.Rounded.Groups, c.lavender, c.lavenderSoft, size = 44.dp) },
                onClick = { nav.navigate(Routes.NEW_CHAT + "?mode=group") { popUpTo(Routes.NEW_CHAT + "?mode={mode}&with={with}") { inclusive = true } } },
            )
        }
        if (group && picked.isNotEmpty()) {
            ChipRow { picked.forEach { u -> PillChip(u.displayName, true, { picked.remove(u) }) } }
        }
        error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
            item { SectionHeader(if (q.length >= 2) "Results" else "Colleagues", Modifier.padding(vertical = 6.dp)) }
            if (resolving) item { Text("Looking up that address…", style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 8.dp)) }
            remote?.let { r ->
                item(key = "remote") {
                    ListCard(
                        r.user.displayName, Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        subtitle = (r.user.address ?: "@${r.user.username}") + if (r.server.source == "local") "" else " · on ${r.server.domain}",
                        leading = { Avatar(r.user.displayName, r.user.avatarColor, size = 44.dp) },
                        trailing = { if (r.server.source != "local") TagPill("Other server", c.lavender, c.lavenderSoft) else ArrowKnob() },
                        onClick = { remoteSheet = r },
                    )
                }
            }
            if (list.isEmpty() && remote == null && !resolving) item {
                EmptyState(
                    Icons.Outlined.Search, if (q.length >= 2) "No one found" else "Search for people",
                    if (group) "You can find colleagues in your organization, or anyone on this server by exact @username."
                    else "Find colleagues in your organization, anyone on this server by exact @username, or someone on another Griip server by their full address, like @name:server.example.",
                )
            }
            items(list, key = { it.id }) { u ->
                val sel = picked.any { it.id == u.id }
                ListCard(
                    u.displayName, Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    subtitle = "@${u.username}" + (u.title?.let { " · $it" } ?: ""),
                    leading = { Avatar(u.displayName, u.avatarColor, size = 44.dp, online = u.online) },
                    trailing = {
                        when {
                            group && sel -> TagPill("Added", c.primaryDeep, c.primarySoft, icon = Icons.Rounded.Check)
                            group -> TagPill("Add", c.textSecondary, c.surfaceVariant)
                            call -> Icon(Icons.Rounded.Call, "Call", tint = c.primary)
                            else -> ArrowKnob()
                        }
                    },
                    selected = sel,
                    onClick = { if (group) { if (sel) picked.removeAll { it.id == u.id } else picked.add(u) } else open(u) },
                )
            }
        }
        remoteSheet?.let { r ->
            RemoteContactSheet(r, call, container.session.keys?.identityPublic, onDismiss = { remoteSheet = null }) {
                remoteSheet = null
                open(r.user)
            }
        }
        if (group) {
            PillButton(
                "Create group (${picked.size})",
                {
                    busy = true
                    scope.launch {
                        runCatching { container.conversations.createGroup(groupName.trim(), picked.map { it.id }) }
                            .onSuccess { nav.popBackStack(); nav.navigate(Routes.conversation(it.id)) }
                            .onFailure { error = it.friendly() }
                        busy = false
                    }
                },
                Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 12.dp).padding(bottom = 8.dp),
                enabled = groupName.isNotBlank() && picked.isNotEmpty(), loading = busy,
            )
        }
    }
}

/**
 * Someone found by global address: who they are, which server vouches for them and how that server was verified,
 * before the first message (safety numbers were retired on 2026-10-28, as on Meldiq Web).
 */
@Composable
private fun RemoteContactSheet(r: ResolveRes, call: Boolean, myKey: ByteArray?, onDismiss: () -> Unit, onMessage: () -> Unit) {
    val c = Griip.colors
    val remote = r.server.source != "local"
    GlassSheet(onDismiss, title = r.user.displayName) {
        Text(r.user.address ?: "@${r.user.username}", style = Griip.type.bodyMedium, color = c.textPrimary)
        Spacer(Modifier.height(10.dp))
        if (remote) {
            Text(
                when {
                    r.server.source == "cache" -> "Server ${r.server.domain}: identity checked earlier (the directory couldn't be reached just now)."
                    else -> "Server ${r.server.domain}: identity verified by ${r.server.verifiedBy} directory nodes."
                },
                style = Griip.type.bodySmall, color = c.textSecondary,
            )
            Spacer(Modifier.height(6.dp))
            Text("Server id ${r.server.serverId.take(15)}…", style = Griip.type.caption, color = c.textTertiary)
            Spacer(Modifier.height(10.dp))
        }
        if (r.server.identityChanged) {
            StatusBanner("This address now points to a different server than before. Check with the person before you trust it.", BannerKind.Warning)
            Spacer(Modifier.height(8.dp))
        }
        if (r.server.state == "unreachable") {
            StatusBanner("${r.server.domain} isn't reachable right now. Messages wait for up to 7 days.", BannerKind.Info)
            Spacer(Modifier.height(8.dp))
        }
        if (call && remote) {
            Text("The call is hosted by your server; ${r.user.displayName} joins through theirs. Media travels over encrypted connections.", style = Griip.type.caption, color = c.textTertiary)
            Spacer(Modifier.height(8.dp))
        }
        PillButton(if (call) "Call" else "Message", onMessage, Modifier.fillMaxWidth(), height = 50.dp)
    }
}

@Suppress("unused")
private val unusedIcon = Icons.Rounded.Videocam
@Suppress("unused")
private val unusedW = Modifier.width(1.dp)

/** The chat list's data, kept while a chat is open on top of the list (null until the database first answers). */
class ChatsViewModel(c: com.meldiq.android.di.AppContainer) : androidx.lifecycle.ViewModel() {
    val conversations = c.conversations.observeAll()
        .stateIn(viewModelScope, kotlinx.coroutines.flow.SharingStarted.Eagerly, null)
    val users = c.db.users().observeAll()
        .stateIn(viewModelScope, kotlinx.coroutines.flow.SharingStarted.Eagerly, emptyList())
}
