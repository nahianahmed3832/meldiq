package com.meldiq.android.ui.screens.you

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.LocalTabBarPadding
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.ArrowKnob
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.ValueChevron
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.SegmentedPills
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.screens.chats.ConversationAvatar
import com.meldiq.android.ui.screens.chats.listTitle
import com.meldiq.android.ui.screens.home.HomeViewModel
import com.meldiq.android.ui.screens.home.QuickAccessRow
import com.meldiq.android.ui.screens.home.QuickCard
import com.meldiq.android.ui.screens.home.StartChecklist
import com.meldiq.android.ui.screens.home.StartRules
import com.meldiq.android.ui.screens.home.StartStep
import com.meldiq.android.ui.screens.home.WorkspaceHomeRules
import com.meldiq.android.ui.switchTab
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** The sheets You can show. */
private enum class YouSheet { Status, Pause, Drafts, Presence }

/**
 * The You tab (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §1): your profile and status, pausing notifications, your own
 * things (threads, Later, reminders, drafts and sent messages, calls), Get started, and every settings screen. These
 * were Home's cards and its profile sheet before Home became the communities' channel list.
 */
@Composable
fun YouScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val vm = containerViewModel(key = "you") { HomeViewModel(it) }
    val loaded by vm.conversations.collectAsStateWithLifecycle()
    val convs = loaded.orEmpty()
    val meUser by vm.me.collectAsStateWithLifecycle()
    val callLog by vm.callLog.collectAsStateWithLifecycle()
    val threadUnseen by vm.threadUnseen.collectAsStateWithLifecycle()
    val recentSent by vm.recentSent.collectAsStateWithLifecycle()
    val saved by vm.saved.collectAsStateWithLifecycle()
    val orgs by vm.orgs.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val myStatus by container.profiles.mine.collectAsStateWithLifecycle()
    var presenceModes by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { presenceModes = container.features.has(com.meldiq.android.data.repo.ServerFeatures.PRESENCE_MODES) == true }
    val reminderList by container.reminders.reminders.collectAsStateWithLifecycle()
    val remindersOn by container.reminders.available.collectAsStateWithLifecycle()
    val me = container.session.session?.userId
    val myName = meUser?.displayName?.takeIf { it.isNotBlank() } ?: container.session.session?.displayName.orEmpty()
    val handle = meUser?.username?.takeIf { it.isNotBlank() } ?: container.session.session?.username
    var sheet by rememberSaveable { mutableStateOf<YouSheet?>(null) }
    var statusFeatures by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        statusFeatures = container.features.has(ServerFeatures.STATUS_EXPIRY) == true
        if (statusFeatures) container.profiles.refreshStatus()
    }
    val now = System.currentTimeMillis()
    val drafts = remember(convs) { WorkspaceHomeRules.drafts(convs) }
    val missed = remember(callLog) { WorkspaceHomeRules.missedCalls(callLog, now, WorkspaceHomeRules.MISSED_CALLS_CARD_WINDOW_MS).size }
    val openSaved = saved.count { !it.done }
    val overdue = saved.count { com.meldiq.android.data.model.ReminderTimes.overdue(it.remindAt, it.done, now) }
    val reminderGroups = remember(reminderList) { com.meldiq.android.data.model.ReminderRules.group(reminderList.filter { it.content?.source != "later" }) }
    val cards = listOfNotNull(
        QuickCard(
            Icons.Outlined.Forum, stringResource(R.string.home_card_threads),
            if (threadUnseen > 0) stringResource(R.string.home_threads_new, threadUnseen) else stringResource(R.string.home_threads_none),
            active = threadUnseen > 0, onClick = { nav.switchTab(Routes.ACTIVITY) },
        ),
        QuickCard(
            Icons.Outlined.BookmarkBorder, stringResource(R.string.later_title),
            when {
                overdue > 0 -> stringResource(R.string.later_overdue_count, overdue)
                openSaved > 0 -> stringResource(R.string.later_saved_count, openSaved)
                else -> stringResource(R.string.later_none)
            },
            active = overdue > 0, onClick = { nav.navigate(Routes.LATER) },
        ),
        if (!remindersOn) null else QuickCard(
            Icons.Outlined.NotificationsActive, stringResource(R.string.rem_title),
            when {
                reminderGroups.overdue.isNotEmpty() -> stringResource(R.string.rem_overdue_count, reminderGroups.overdue.size)
                reminderGroups.upcoming.isNotEmpty() -> stringResource(R.string.rem_upcoming_count, reminderGroups.upcoming.size)
                else -> stringResource(R.string.rem_none)
            },
            active = reminderGroups.overdue.isNotEmpty(), onClick = { nav.navigate(Routes.REMINDERS) },
        ),
        QuickCard(
            Icons.AutoMirrored.Outlined.Send, stringResource(R.string.home_card_drafts_sent),
            if (drafts.isNotEmpty()) stringResource(R.string.home_drafts_n, drafts.size) else stringResource(R.string.home_recent_sent),
            active = drafts.isNotEmpty(), onClick = { sheet = YouSheet.Drafts },
        ),
        QuickCard(
            Icons.Outlined.Call, stringResource(R.string.home_card_calls),
            if (missed > 0) stringResource(R.string.home_missed_today, missed) else stringResource(R.string.home_history),
            active = missed > 0, onClick = { nav.navigate(Routes.CALLS) },
        ),
    )
    val firstOrg = orgs?.firstOrNull()
    val startSteps = listOf(
        StartStep(stringResource(R.string.start_profile), done = meUser?.photoRev != null) { nav.navigate(Routes.EDIT_PROFILE) },
        StartStep(stringResource(R.string.start_workspace), done = !orgs.isNullOrEmpty()) { nav.navigate(Routes.JOIN + "?code=") },
        StartStep(stringResource(R.string.start_invite), done = (firstOrg?.memberCount ?: 0) > 1) { firstOrg?.id?.let { nav.navigate(Routes.invites(it)) } ?: nav.navigate(Routes.JOIN + "?code=") },
        StartStep(stringResource(R.string.start_notifications), done = settings.notifications && vm.notificationsAllowed()) { nav.navigate(Routes.NOTIFICATION_SETTINGS) },
        StartStep(stringResource(R.string.cm_discover), done = (orgs?.size ?: 0) > 1, optional = true) { nav.navigate(Routes.DISCOVER) },
    )
    val barPadding = LocalTabBarPadding.current

    LazyColumn(Modifier.fillMaxSize().background(c.background).statusBarsPadding(), contentPadding = PaddingValues(bottom = barPadding + 16.dp)) {
        item(key = "title") {
            Text(
                stringResource(R.string.nv_you), style = Griip.type.title, color = c.textPrimary,
                modifier = Modifier.padding(horizontal = Space.gutter, vertical = 12.dp).semantics { heading() },
            )
        }
        item(key = "profile") {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 4.dp), shape = Shapes.hero) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    UserAvatar(me, myName.ifBlank { "?" }, meUser?.avatarColor ?: 0, meUser?.photoRev, size = 64.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(myName, style = Griip.type.title, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        handle?.let { Text("@$it", style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 1) }
                        if (statusFeatures) {
                            com.meldiq.android.ui.screens.profile.StatusRules.line(myStatus, now)?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, maxLines = 1) }
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                PillButton(stringResource(R.string.settings_edit_profile), { nav.navigate(Routes.EDIT_PROFILE) }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 44.dp)
            }
        }
        if (statusFeatures) item(key = "status") {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(6.dp)) {
                val line = com.meldiq.android.ui.screens.profile.StatusRules.line(myStatus, now)
                val until = myStatus?.statusExpiresAt?.takeIf { line != null }
                MenuRow(
                    Icons.Outlined.EmojiEmotions, line ?: stringResource(R.string.r3_status_set),
                    subtitle = until?.let { stringResource(R.string.r3_status_until, TimeFmt.clock(it)) }, onClick = { sheet = YouSheet.Status },
                )
                val pausedUntil = myStatus?.notificationsPausedUntil?.takeIf { com.meldiq.android.ui.screens.profile.StatusRules.paused(it, now) }
                MenuRow(
                    Icons.Outlined.NotificationsOff,
                    pausedUntil?.let { stringResource(R.string.r3_paused_until, TimeFmt.clock(it)) } ?: stringResource(R.string.r3_pause),
                    tint = c.peach, tintBg = c.peachSoft, onClick = { sheet = YouSheet.Pause },
                )
                // Batch B6b: online automatically, idle, do not disturb or invisible.
                if (presenceModes) com.meldiq.android.ui.screens.profile.PresenceRow(myStatus?.presenceMode, myStatus?.presenceUntil, now) { sheet = YouSheet.Presence }
            }
        }
        item(key = "cards") { QuickAccessRow(cards, Modifier.padding(vertical = 8.dp)) }
        if (orgs != null && StartRules.visible(settings.setupDismissed, startSteps)) item(key = "start") {
            StartChecklist(startSteps, onHide = { container.settings.update { it.copy(setupDismissed = true) } })
        }
        item(key = "settings") {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(6.dp)) {
                MenuRow(Icons.Outlined.Settings, stringResource(R.string.settings_title), onClick = { nav.navigate(Routes.PROFILE) })
                MenuRow(Icons.Outlined.Notifications, stringResource(R.string.settings_notifications), tint = c.peach, tintBg = c.peachSoft, onClick = { nav.navigate(Routes.NOTIFICATION_SETTINGS) }, trailing = { ValueChevron(com.meldiq.android.ui.screens.profile.notificationsValue()) })
                MenuRow(Icons.Outlined.Palette, stringResource(R.string.chat_appearance), onClick = { nav.navigate(Routes.CHAT_SETTINGS) }, trailing = { ValueChevron(com.meldiq.android.ui.screens.profile.appearanceValue()) })
                MenuRow(Icons.Outlined.Lock, stringResource(R.string.settings_privacy), tint = c.lavender, tintBg = c.lavenderSoft, onClick = { nav.navigate(Routes.PRIVACY) })
                MenuRow(
                    Icons.Outlined.Language, stringResource(R.string.settings_language), tint = c.textSecondary, tintBg = c.surfaceVariant, onClick = { nav.navigate(Routes.LANGUAGE) },
                    trailing = { ValueChevron(com.meldiq.android.ui.screens.profile.languageValue()) },
                )
            }
        }
        item(key = "people") {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(6.dp)) {
                MenuRow(Icons.Outlined.People, stringResource(R.string.contacts_title), onClick = { nav.navigate(Routes.CONTACTS) })
                MenuRow(Icons.Outlined.Call, stringResource(R.string.home_call_history), onClick = { nav.navigate(Routes.CALLS) })
                MenuRow(Icons.Outlined.AccountCircle, stringResource(R.string.settings_edit_profile), onClick = { nav.navigate(Routes.EDIT_PROFILE) })
                MenuRow(androidx.compose.material.icons.Icons.Outlined.Palette, stringResource(R.string.wp_style_title), onClick = { nav.navigate(Routes.PROFILE_STYLE) })
                MenuRow(
                    Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.home_accounts), tint = c.textSecondary, tintBg = c.surfaceVariant,
                    onClick = { nav.navigate(Routes.ACCOUNTS) },
                )
            }
        }
    }

    when (sheet) {
        YouSheet.Status -> com.meldiq.android.ui.screens.profile.StatusSheet(myStatus, onDismiss = { sheet = null })
        YouSheet.Pause -> com.meldiq.android.ui.screens.profile.PauseSheet(myStatus?.notificationsPausedUntil, onDismiss = { sheet = null })
        YouSheet.Presence -> com.meldiq.android.ui.screens.profile.PresenceSheet(myStatus?.presenceMode, onDismiss = { sheet = null })
        YouSheet.Drafts -> DraftsSentSheet(drafts, recentSent, convs, me, onDismiss = { sheet = null }) { id -> sheet = null; nav.navigate(Routes.conversation(id)) }
        null -> Unit
    }
}

/** Unsent drafts saved on this phone, and your recently sent messages; opening one goes to its conversation. */
@Composable
private fun DraftsSentSheet(
    drafts: List<ConversationEntity>,
    sent: List<MessageEntity>,
    convs: List<ConversationEntity>,
    me: String?,
    onDismiss: () -> Unit,
    onOpen: (String) -> Unit,
) {
    val c = Griip.colors
    var tab by rememberSaveable { mutableStateOf(if (drafts.isEmpty() && sent.isNotEmpty()) 1 else 0) }
    val byId = remember(convs) { convs.associateBy { it.id } }
    GlassSheet(onDismiss, title = stringResource(R.string.home_card_drafts_sent)) {
        SegmentedPills(listOf("${stringResource(R.string.sent_tab_drafts)} · ${drafts.size}", stringResource(R.string.sent_tab_sent)), tab, { tab = it })
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp)) {
            if (tab == 0) {
                if (drafts.isEmpty()) item { Text(stringResource(R.string.drafts_empty), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(vertical = 12.dp)) }
                items(drafts, key = { "d-" + it.id }) { conv ->
                    ListCard(
                        listTitle(conv, me), Modifier.padding(vertical = 2.dp), subtitle = conv.draft?.trim()?.replace('\n', ' '),
                        leading = { ConversationAvatar(conv, me, size = 40.dp) }, trailing = { ArrowKnob() }, onClick = { onOpen(conv.id) },
                    )
                }
            } else {
                if (sent.isEmpty()) item { Text(stringResource(R.string.sent_empty), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(vertical = 12.dp)) }
                items(sent, key = { "s-" + it.id }) { m ->
                    val conv = byId[m.conversationId]
                    ListCard(
                        conv?.let { listTitle(it, me) } ?: "—", Modifier.padding(vertical = 2.dp),
                        subtitle = m.text.trim().replace('\n', ' ').ifEmpty { "📎" } + " · " + TimeFmt.listStamp(m.sortTs),
                        leading = { conv?.let { ConversationAvatar(it, me, size = 40.dp) } }, trailing = { ArrowKnob() }, onClick = { onOpen(m.conversationId) },
                    )
                }
            }
        }
    }
}
