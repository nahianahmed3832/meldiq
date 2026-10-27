package com.meldiq.android.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavBackStackEntry
import androidx.compose.animation.scaleIn
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Notifications
import com.meldiq.android.ui.theme.DarkSurfaceSystemBars
import com.meldiq.android.ui.theme.Motion
import com.meldiq.android.ui.theme.ProvideGriipPalette
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.Alignment
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.repo.SessionState
import com.meldiq.android.di.AppContainer
import com.meldiq.android.ui.components.AppBackground
import com.meldiq.android.ui.components.FloatingNavBar
import com.meldiq.android.ui.components.NavItem
import com.meldiq.android.ui.screens.calls.CallOverlay
import com.meldiq.android.ui.screens.calls.CallsScreen
import com.meldiq.android.ui.screens.chats.ChatsScreen
import com.meldiq.android.ui.screens.chats.DmListRequest
import com.meldiq.android.ui.screens.home.ActivityFeedScreen
import com.meldiq.android.ui.screens.home.WorkspaceHomeRules
import com.meldiq.android.ui.screens.chats.NewChatScreen
import com.meldiq.android.ui.screens.conversation.ConversationInfoScreen
import com.meldiq.android.ui.screens.conversation.ConversationScreen
import com.meldiq.android.ui.screens.home.SearchScreen
import com.meldiq.android.ui.screens.onboarding.JoinWorkspaceScreen
import com.meldiq.android.ui.screens.onboarding.OnboardingFlow
import com.meldiq.android.ui.screens.onboarding.RevokedScreen
import com.meldiq.android.ui.screens.profile.DevicesScreen
import com.meldiq.android.ui.screens.profile.SecurityScreen
import com.meldiq.android.ui.screens.profile.ServersScreen
import com.meldiq.android.ui.screens.profile.UserProfileScreen
import com.meldiq.android.ui.screens.workspace.ActivityScreen
import com.meldiq.android.ui.screens.workspace.InvitesScreen
import com.meldiq.android.ui.screens.workspace.MembersScreen
import com.meldiq.android.ui.screens.workspace.WorkspaceScreen

val LocalContainer = staticCompositionLocalOf<AppContainer> { error("no container") }

/** Space the tab bar covers at the bottom of the tab screens (Home, DMs, Activity). Other screens don't use it. */
val LocalTabBarPadding = androidx.compose.runtime.compositionLocalOf { 0.dp }

object Routes {
    /** The Home tab: the selected workspace at a glance (UI-002). The start screen. */
    const val HOME = "home"
    /** The DMs tab: direct messages and groups (the chat list; the route keeps its old name for back stacks). */
    const val CHATS = "chats"
    /** The Activity tab: @mentions, missed calls, the workspace change log. Not [activity], one workspace's log. */
    const val ACTIVITY = "activity"
    /** The You tab: your profile, status, Later, reminders, drafts, calls and settings (Discord reference round). */
    const val YOU = "you"
    /** Call history and new calls; opens from Home's Calls card, Activity, the DMs menu and the profile menu. */
    const val CALLS = "calls"
    /** Messages saved for later, with reminders (Home's Later card, 2026-10-19). */
    const val LATER = "later"
    /** The first-run introduction, replayed from Settings (round 6). */
    const val INTRO = "intro"
    /** Reminders: upcoming, overdue and done (round 6, docs/REMINDERS.md). */
    const val REMINDERS = "reminders"
    /** Community settings, in groups (Discord reference round). */
    const val WORKSPACE = "workspace"
    /** Channels & categories: arranging the selected community's channel list. */
    const val CHANNELS_MANAGE = "workspace/channels"
    /** Settings (profile, account, privacy, appearance, notifications, calls, about), from your avatar on Home. */
    const val PROFILE = "profile"
    const val JOIN = "join"
    const val NEW_CHAT = "newchat"
    const val SEARCH = "search"
    const val DEVICES = "devices"
    const val SECURITY = "security"
    /** Servers on this phone: one profile per server, switched without deleting anything. */
    const val SERVERS = "servers"
    /** Kept for older links; the settings now live on the Settings tab. */
    const val SETTINGS = "settings"
    const val EDIT_PROFILE = "profile/edit"
    const val ACCOUNTS = "accounts"
    const val CHAT_SETTINGS = "settings/chats"
    const val NOTIFICATION_SETTINGS = "settings/notifications"
    const val CALL_SETTINGS = "settings/calls"
    const val LANGUAGE = "settings/language"
    const val STORAGE = "settings/storage"
    /** Platform admins only (round 7, docs/OPERATIONS.md). */
    const val SERVICE_HEALTH = "settings/health"
    const val CONNECTORS = "settings/connectors"
    const val CONTACTS = "contacts"
    /** Batch B6: message requests waiting for you, and your connections. */
    const val REQUESTS = "requests"
    const val PEOPLE = "people"
    /** Public communities to find and join (docs/COMMUNITY_REBUILD_2026-10-21.md). */
    const val DISCOVER = "discover"
    const val PRIVACY = "privacy"
    const val BLOCKED = "blocked"
    /** [message]: scroll to this message once it's loaded (batch B5 message links). */
    fun conversation(id: String, thread: String? = null, message: String? = null) =
        "conversation/$id" + listOfNotNull(thread?.let { "thread=$it" }, message?.let { "message=$it" }).joinToString("&").let { if (it.isEmpty()) "" else "?$it" }
    fun info(id: String) = "conversation/$id/info"
    /** Batch B14b: a channel's settings page (its details' gear). */
    fun channelSettings(id: String) = "conversation/$id/settings"
    fun members(orgId: String) = "members/$orgId"
    fun invites(orgId: String) = "invites/$orgId"
    fun activity(orgId: String) = "activity/$orgId"
    fun roles(orgId: String) = "roles/$orgId"
    /** Scheduled events in voice channels (round 7 meetings, docs/WORKSPACE_C5.md). */
    fun meetings(orgId: String, canSchedule: Boolean) = "meetings/$orgId?schedule=$canSchedule"
    /** Permission overwrites of a category ([category] true) or a channel. */
    fun permissions(category: Boolean, id: String, name: String) = "permissions/${if (category) "category" else "channel"}/$id?name=${android.net.Uri.encode(name)}"
    fun bans(orgId: String) = "bans/$orgId"
    fun audit(orgId: String) = "audit/$orgId"
    fun reports(orgId: String) = "reports/$orgId"
    fun applications(orgId: String) = "applications/$orgId"
    fun expressions(orgId: String) = "expressions/$orgId"
    fun usage(orgId: String) = "usage/$orgId"
    fun user(id: String) = "user/$id"
    /**
     * The bottom bar (2026-10-21): Home (communities), DMs, Activity and You. Everything else opens over them, with Back.
     */
    val tabs = setOf(HOME, CHATS, ACTIVITY, YOU)
}

@Composable
fun AppRoot(container: AppContainer, pendingConversation: String?, pendingInvite: String?, onPendingHandled: () -> Unit, pendingMessageLink: com.meldiq.android.data.model.MessageLinks.Target? = null) {
    CompositionLocalProvider(LocalContainer provides container) {
        val session by container.session.state.collectAsStateWithLifecycle()
        val call by container.calls.state.collectAsStateWithLifecycle()
        val minimized by container.calls.minimized.collectAsStateWithLifecycle()
        // In picture-in-picture only the call is drawn (CallPip), on top of the app, which stays composed underneath:
        // replacing the app with the call view used to drop navigation and the minimised state on the way back (UI-003).
        val pip by com.meldiq.android.call.CallPip.active.collectAsStateWithLifecycle()
        val inCall = call.phase != CallPhase.Idle
        val showPanel = inCall && minimized && call.phase != CallPhase.Incoming && !pip
        var panelRoutes by remember { mutableStateOf(false) }
        // Passing call notices ("Screen sharing stopped"), whether the call is full screen or minimised.
        val appContext = LocalContext.current
        LaunchedEffect(call.notice) { call.notice?.let { android.widget.Toast.makeText(appContext, it, android.widget.Toast.LENGTH_SHORT).show(); container.calls.clearNotice() } }
        run {
            Box(Modifier.fillMaxSize()) {
                AppBackground {
                    Column(Modifier.fillMaxSize()) {
                        // The minimised call takes its own space above the app (UI-003): the app moves down instead of
                        // being covered, so no back arrow or header action ends up under the call.
                        if (showPanel) {
                            com.meldiq.android.ui.screens.calls.MiniCallPanel(
                                call,
                                onExpand = container.calls::expand,
                                onMic = { container.calls.toggleMic() },
                                onAudio = { if (com.meldiq.android.ui.screens.calls.CallControlsRules.opensPicker(call)) panelRoutes = true else container.calls.toggleSpeaker() },
                                onEnd = container.calls::hangup,
                            )
                        }
                        Box(Modifier.weight(1f).fillMaxWidth().then(if (showPanel) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
                            when (val s = session) {
                                is SessionState.SignedOut -> OnboardingFlow(pendingInvite)
                                is SessionState.Revoked -> RevokedScreen(s.reason)
                                // Orbit 2.0: a new recovery key, the start choice or a legacy account's move come before the app.
                                is SessionState.SignedIn -> com.meldiq.android.ui.screens.account.AccountGate(container) { join ->
                                    MainNav(container, pendingConversation, pendingInvite ?: join, onPendingHandled, pendingMessageLink)
                                }
                            }
                        }
                    }
                    AnimatedVisibility(
                        visible = inCall && !pip && (!minimized || call.phase == CallPhase.Incoming),
                        enter = slideInVertically(Motion.enter()) { it / 3 } + fadeIn(Motion.enter(Motion.STANDARD)),
                        exit = slideOutVertically(Motion.exit(Motion.STANDARD)) { it / 3 } + fadeOut(Motion.exit(Motion.STANDARD)),
                    ) { CallPalette { CallOverlay() } }
                }
                if (pip && inCall) CallPalette { com.meldiq.android.ui.screens.calls.CallPipView(call) }
                if (panelRoutes && showPanel) {
                    com.meldiq.android.ui.screens.calls.AudioRouteSheet(
                        call, onPick = { container.calls.selectAudioRoute(it); panelRoutes = false },
                        onDismiss = { panelRoutes = false; container.calls.clearRouteError() },
                    )
                }
            }
        }
    }
}

/**
 * The call screen is always drawn dark (the chosen preset's dark palette, so its accent matches the app), with light
 * system-bar icons; the rest of the app follows the theme setting (docs/DESIGN_SYSTEM.md).
 */
@Composable
private fun CallPalette(content: @Composable () -> Unit) {
    val settings by LocalContainer.current.settings.state.collectAsStateWithLifecycle()
    ProvideGriipPalette(com.meldiq.android.ui.theme.MeldiqPalettes.colors(settings.palette, dark = true)) {
        DarkSurfaceSystemBars()
        content()
    }
}

@Composable
private fun MainNav(container: AppContainer, pendingConversation: String?, pendingInvite: String?, onPendingHandled: () -> Unit, pendingMessageLink: com.meldiq.android.data.model.MessageLinks.Target?) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val conversations = remember(container) { container.conversations.observeAll() }
    val convs by conversations.collectAsStateWithLifecycle(emptyList())
    // Home's "See all" opens the DMs tab filtered to unread.
    val dmRequest = remember { DmListRequest() }

    val linkContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(pendingConversation, pendingInvite, pendingMessageLink) {
        if (pendingMessageLink != null) {
            MessageLinkOpener.open(container, nav, linkContext, pendingMessageLink)
            onPendingHandled()
        } else if (pendingConversation == com.meldiq.android.MainActivity.TARGET_REMINDERS) {
            nav.navigate(Routes.REMINDERS)
            onPendingHandled()
        } else if (pendingConversation != null) {
            nav.navigate(Routes.conversation(pendingConversation))
            onPendingHandled()
        } else if (pendingInvite != null) {
            nav.navigate(Routes.JOIN + "?code=$pendingInvite")
            onPendingHandled()
        }
    }

    // The tab bar is drawn over the screens, not beside them, so every screen keeps the same height whether or not the
    // bar shows. (Before 2026-10-17 the bar's space came and went with it: opening a chat made the chat list taller for
    // a moment, which clamped its scroll position near the end, and the list came back shifted.) Tab screens add
    // LocalTabBarPadding below their content instead.
    val density = androidx.compose.ui.platform.LocalDensity.current
    var barHeight by androidx.compose.runtime.remember { androidx.compose.runtime.mutableIntStateOf(0) }
    Box(Modifier.fillMaxSize()) {
        val motion = rememberNavMotion()
        androidx.compose.runtime.CompositionLocalProvider(LocalTabBarPadding provides with(density) { barHeight.toDp() }) {
        NavHost(
            nav,
            startDestination = Routes.HOME,
            modifier = Modifier.fillMaxSize(),
            enterTransition = { motion.enter(this, forward = true) },
            exitTransition = { motion.exit(this, forward = true) },
            popEnterTransition = { motion.enter(this, forward = false) },
            popExitTransition = { motion.exit(this, forward = false) },
        ) {
            composable(Routes.HOME) { com.meldiq.android.ui.screens.community.CommunityHomeScreen(nav) }
            composable(Routes.YOU) { com.meldiq.android.ui.screens.you.YouScreen(nav) }
            composable(Routes.CHATS) { ChatsScreen(nav, dmRequest) }
            composable(Routes.ACTIVITY) { ActivityFeedScreen(nav) }
            composable(Routes.CALLS) { CallsScreen(nav) }
            composable(Routes.LATER) { com.meldiq.android.ui.screens.home.LaterScreen(nav) }
            composable(Routes.INTRO) { com.meldiq.android.ui.screens.onboarding.IntroScreen(onDone = { nav.popBackStack() }) }
            composable(Routes.REMINDERS) { com.meldiq.android.ui.screens.reminders.RemindersScreen(nav) }
            composable(Routes.WORKSPACE) { com.meldiq.android.ui.screens.community.CommunitySettingsScreen(nav) }
            composable(Routes.CHANNELS_MANAGE) { WorkspaceScreen(nav) }
            composable(Routes.CONTACTS) { com.meldiq.android.ui.screens.contacts.ContactsScreen(nav) }
            composable(Routes.REQUESTS) { com.meldiq.android.ui.screens.contacts.RequestsScreen(nav) }
            composable(Routes.PEOPLE) { com.meldiq.android.ui.screens.contacts.PeopleScreen(nav) }
            composable(Routes.PROFILE) { com.meldiq.android.ui.screens.profile.SettingsHub(nav) }
            composable(Routes.JOIN + "?code={code}") { JoinWorkspaceScreen(nav, it.arguments?.getString("code")) }
            // Batch B14: `with` picks someone already (a DM's "New group").
            composable(
                Routes.NEW_CHAT + "?mode={mode}&with={with}",
                arguments = listOf(
                    androidx.navigation.navArgument("mode") { type = androidx.navigation.NavType.StringType; nullable = true; defaultValue = null },
                    androidx.navigation.navArgument("with") { type = androidx.navigation.NavType.StringType; nullable = true; defaultValue = null },
                ),
            ) { NewChatScreen(nav, it.arguments?.getString("mode"), it.arguments?.getString("with")) }
            composable(Routes.SEARCH) { SearchScreen(nav) }
            composable("conversation/{id}?thread={thread}&message={message}") {
                ConversationScreen(nav, it.arguments!!.getString("id")!!, it.arguments?.getString("thread"), it.arguments?.getString("message"))
            }
            composable("conversation/{id}/info") { ConversationInfoScreen(nav, it.arguments!!.getString("id")!!) }
            composable("conversation/{id}/settings") { ConversationInfoScreen(nav, it.arguments!!.getString("id")!!, settings = true) }
            composable("members/{orgId}") { MembersScreen(nav, it.arguments!!.getString("orgId")!!) }
            composable("invites/{orgId}") { InvitesScreen(nav, it.arguments!!.getString("orgId")!!) }
            composable("activity/{orgId}") { ActivityScreen(nav, it.arguments!!.getString("orgId")!!) }
            // Custom roles, audit and usage (2026-10-19, docs/WORKSPACE_ROLES.md).
            composable("roles/{orgId}") { com.meldiq.android.ui.screens.workspace.roles.RolesScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable(
                "meetings/{orgId}?schedule={schedule}",
                arguments = listOf(androidx.navigation.navArgument("schedule") { type = androidx.navigation.NavType.BoolType; defaultValue = false }),
            ) { com.meldiq.android.ui.screens.workspace.meetings.MeetingsScreen(nav, it.arguments?.getString("orgId").orEmpty(), it.arguments?.getBoolean("schedule") ?: false) }
            composable(Routes.DISCOVER) { com.meldiq.android.ui.screens.workspace.DiscoverScreen(nav) }
            composable("bans/{orgId}") { com.meldiq.android.ui.screens.workspace.BansScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("permissions/{type}/{id}?name={name}") {
                com.meldiq.android.ui.screens.workspace.ChannelPermissionsScreen(
                    nav, it.arguments?.getString("type") == "category", it.arguments?.getString("id").orEmpty(), it.arguments?.getString("name").orEmpty(),
                )
            }
            composable("audit/{orgId}") { com.meldiq.android.ui.screens.workspace.AuditScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("reports/{orgId}") { com.meldiq.android.ui.screens.moderation.ReportsScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("expressions/{orgId}") { com.meldiq.android.ui.screens.community.ExpressionsScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("applications/{orgId}") { com.meldiq.android.ui.screens.moderation.ApplicationsScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("usage/{orgId}") { com.meldiq.android.ui.screens.workspace.UsageScreen(nav, it.arguments?.getString("orgId").orEmpty()) }
            composable("user/{id}") { UserProfileScreen(nav, it.arguments!!.getString("id")!!) }
            composable(Routes.DEVICES) { DevicesScreen(nav) }
            composable(Routes.SECURITY) { SecurityScreen(nav) }
            composable(Routes.SERVERS) { ServersScreen(nav) }
            composable(Routes.SETTINGS) { com.meldiq.android.ui.screens.profile.SettingsHub(nav) }
            composable(Routes.EDIT_PROFILE) { com.meldiq.android.ui.screens.profile.EditProfileScreen(nav) }
            composable(Routes.ACCOUNTS) { com.meldiq.android.ui.screens.profile.AccountsScreen(nav) }
            composable(Routes.CHAT_SETTINGS) { com.meldiq.android.ui.screens.profile.ChatSettingsScreen(nav) }
            composable(Routes.NOTIFICATION_SETTINGS) { com.meldiq.android.ui.screens.profile.NotificationSettingsScreen(nav) }
            composable(Routes.CALL_SETTINGS) { com.meldiq.android.ui.screens.profile.CallSettingsScreen(nav) }
            composable(Routes.LANGUAGE) { com.meldiq.android.ui.screens.profile.LanguageScreen(nav) }
            composable(Routes.STORAGE) { com.meldiq.android.ui.screens.profile.StorageScreen(nav) }
            composable(Routes.SERVICE_HEALTH) { com.meldiq.android.ui.screens.profile.ServiceHealthScreen(nav) }
            composable(Routes.CONNECTORS) { com.meldiq.android.ui.screens.profile.ConnectorsScreen(nav) }
            composable(Routes.PRIVACY) { com.meldiq.android.ui.screens.profile.PrivacyScreen(nav) }
            composable(Routes.BLOCKED) { com.meldiq.android.ui.screens.profile.BlockedUsersScreen(nav) }
        }
        }
        // The floating bar (UI-002). No action button: each tab offers its own New action where an existing flow
        // supports it. Batch B16: it slides away under a screen opened from a tab and back on return (still when
        // animations are off), instead of vanishing at once.
        val homeBadge = remember(convs) { WorkspaceHomeRules.homeBadge(convs) }
        val dmBadge = remember(convs) { WorkspaceHomeRules.dmBadge(convs) }
        val activityBadge = remember(convs) { WorkspaceHomeRules.activityBadge(convs) }
        val stillBar = com.meldiq.android.ui.theme.rememberReducedMotion()
        AnimatedVisibility(
            visible = route in Routes.tabs,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = if (stillBar) EnterTransition.None else slideInVertically(Motion.enter(Motion.STANDARD)) { it } + fadeIn(Motion.enter(Motion.QUICK)),
            exit = if (stillBar) ExitTransition.None else slideOutVertically(Motion.exit(Motion.QUICK)) { it } + fadeOut(Motion.exit(Motion.QUICK)),
        ) {
            FloatingNavBar(
                items = listOf(
                    NavItem(Routes.HOME, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nav_home), Icons.Outlined.Home, Icons.Rounded.Home, badge = homeBadge),
                    NavItem(Routes.CHATS, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nav_dms), Icons.AutoMirrored.Outlined.Chat, Icons.AutoMirrored.Rounded.Chat, badge = dmBadge),
                    NavItem(Routes.ACTIVITY, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nav_activity), Icons.Outlined.Notifications, Icons.Rounded.Notifications, badge = activityBadge),
                    NavItem(Routes.YOU, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_you), Icons.Outlined.AccountCircle, Icons.Rounded.AccountCircle),
                ),
                selectedRoute = route,
                onSelect = { item -> nav.switchTab(item.route) },
                modifier = Modifier.onSizeChanged { barHeight = it.height },
            )
        }
    }
}

fun NavHostController.switchTab(route: String) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Suppress("unused")
private val noTransition: EnterTransition = EnterTransition.None
@Suppress("unused")
private val noExit: ExitTransition = ExitTransition.None

/**
 * Screen transitions. Tab to tab: a short fade-through (the tabs keep their state and scroll position, so nothing
 * slides). Opening a screen: it slides in from the end edge while the previous one shifts slightly back; Back reverses
 * that. Directions follow the layout direction (right-to-left languages mirror them). With the system's animations
 * turned off (accessibility, or "Remove animations"), screens switch instantly.
 */
class NavMotion(private val animate: Boolean) {
    private fun tabs(scope: AnimatedContentTransitionScope<NavBackStackEntry>) =
        NavMotionRules.isTabSwitch(scope.initialState.destination.route, scope.targetState.destination.route)

    fun enter(scope: AnimatedContentTransitionScope<NavBackStackEntry>, forward: Boolean): EnterTransition = when {
        !animate -> EnterTransition.None
        tabs(scope) -> fadeIn(Motion.enter(Motion.QUICK, Motion.FADE_THROUGH_DELAY)) + scaleIn(Motion.enter(Motion.STANDARD, Motion.FADE_THROUGH_DELAY), initialScale = 0.985f)
        forward -> scope.slideIntoContainer(AnimatedContentTransitionScope.SlideDirection.Start, Motion.enter()) { it / 4 } + fadeIn(Motion.enter(Motion.STANDARD))
        else -> scope.slideIntoContainer(AnimatedContentTransitionScope.SlideDirection.End, Motion.enter()) { it / 10 } + fadeIn(Motion.enter(Motion.STANDARD))
    }

    fun exit(scope: AnimatedContentTransitionScope<NavBackStackEntry>, forward: Boolean): ExitTransition = when {
        !animate -> ExitTransition.None
        tabs(scope) -> fadeOut(Motion.exit(Motion.INSTANT))
        forward -> scope.slideOutOfContainer(AnimatedContentTransitionScope.SlideDirection.Start, Motion.exit()) { it / 10 } + fadeOut(Motion.exit(Motion.STANDARD))
        else -> scope.slideOutOfContainer(AnimatedContentTransitionScope.SlideDirection.End, Motion.exit(Motion.STANDARD)) { it / 4 } + fadeOut(Motion.exit(Motion.QUICK))
    }
}

/** Pure navigation-motion rules (unit-tested in `NavMotionTest`). */
object NavMotionRules {
    /** Switching between the bottom-bar tabs (Home, DMs, Activity). */
    fun isTabSwitch(from: String?, to: String?): Boolean = from in Routes.tabs && to in Routes.tabs

    /** Animations play unless the system animator scale is 0 ("Remove animations" / animations off). */
    fun animationsEnabled(animatorScale: Float): Boolean = animatorScale > 0f
}

/** Batch B16: the same "animations off" check as the rest of the app (`rememberReducedMotion`). */
@Composable
private fun rememberNavMotion(): NavMotion {
    val reduced = com.meldiq.android.ui.theme.rememberReducedMotion()
    return remember(reduced) { NavMotion(!reduced) }
}
