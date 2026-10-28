package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.model.DetailsRules
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.media.MediaExport
import com.meldiq.android.ui.media.MediaGallery
import com.meldiq.android.ui.media.MediaKind
import com.meldiq.android.ui.screens.chats.ConversationAvatar
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Batch B14: a DM's or group's details (Discord-style reference: a clear header, a few actions, then tabs backed by what
 * the conversation holds). Things that belong to the chat (a pinned message, a photo, a file, search, the security
 * sheet) are done there: this screen hands the chat an action through its back-stack entry and goes back.
 */
const val DETAILS_ACTION = "b14_details_action"

object DetailsActions {
    const val SEARCH = "search"
    const val SECURITY = "security"
    private const val JUMP = "jump:"
    fun jump(messageId: String) = JUMP + messageId
    fun jumpTarget(action: String): String? = action.takeIf { it.startsWith(JUMP) }?.removePrefix(JUMP)
}

/** Hands [action] to the chat below this screen and goes back to it. */
fun returnToChat(nav: NavHostController, action: String) {
    nav.previousBackStackEntry?.savedStateHandle?.set(DETAILS_ACTION, action)
    nav.popBackStack()
}

@Composable
internal fun DetailsHeader(cv: ConversationEntity, me: String?, title: String, subtitle: String?, presence: String?) {
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ConversationAvatar(cv, me, size = 80.dp)
        Spacer(Modifier.height(10.dp))
        Text(title, style = Griip.type.headline, color = c.textPrimary, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        subtitle?.let { Text(it, style = Griip.type.bodySmall, color = c.textSecondary, textAlign = TextAlign.Center) }
        presence?.let { Text(it, style = Griip.type.caption, color = c.primary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 2.dp)) }
    }
}

/**
 * Batch B14b: a channel's top bar (search, notifications, settings on the right) and its header (icon, name and the
 * kind of channel), as in the owner's Discord reference, in Meldiq's own style.
 */
@Composable
internal fun ChannelDetailsTopBar(onBack: () -> Unit, onSearch: () -> Unit, muted: Boolean, onMute: () -> Unit, onSettings: () -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        com.meldiq.android.ui.components.CircleIconButton(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.b5_back), onBack)
        Spacer(Modifier.weight(1f))
        com.meldiq.android.ui.components.CircleIconButton(Icons.Outlined.Search, stringResource(R.string.b14_search), onSearch, tint = c.textSecondary)
        com.meldiq.android.ui.components.CircleIconButton(
            if (muted) Icons.Outlined.NotificationsOff else Icons.Outlined.Notifications,
            stringResource(if (muted) R.string.b14_unmute else R.string.b14_mute), onMute, tint = if (muted) c.primary else c.textSecondary,
        )
        com.meldiq.android.ui.components.CircleIconButton(Icons.Outlined.Settings, stringResource(R.string.b14b_channel_settings), onSettings, tint = c.textSecondary)
    }
}

@Composable
internal fun ChannelDetailsHeader(cv: ConversationEntity, me: String?, title: String) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        ConversationAvatar(cv, me, size = 52.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.headline, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                stringResource(
                    when {
                        cv.format == "forum" -> R.string.b14b_forum_channel
                        cv.kind == "ANNOUNCEMENT" -> R.string.b14b_announcement_channel
                        else -> R.string.b14b_text_channel
                    },
                ),
                style = Griip.type.bodySmall, color = c.textSecondary,
            )
            cv.topic?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = Griip.type.caption, color = c.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

/** Batch B14b: the first row of a channel's Members tab, for people who may change who sees the channel. */
@Composable
internal fun ManageAccessRow(onClick: () -> Unit) {
    val c = Griip.colors
    ListCard(
        stringResource(R.string.b14b_manage_access), Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.Settings, c.textPrimary, c.surfaceVariant, size = 40.dp) },
        trailing = { com.meldiq.android.ui.components.ArrowKnob() },
        onClick = onClick,
    )
}

/** A round action with its label under it (Search, Mute, Profile…). */
@Composable
internal fun DetailsAction(icon: ImageVector, label: String, onClick: () -> Unit, active: Boolean = false) {
    val c = Griip.colors
    Column(
        Modifier.width(76.dp).clip(Shapes.small).pressable(onClick, onClickLabel = label, role = Role.Button).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(if (active) c.primarySoft else c.surfaceVariant), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = if (active) c.primary else c.textPrimary, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(4.dp))
        Text(label, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun DetailsActionsRow(
    nav: NavHostController, cv: ConversationEntity, peerId: String?, onMute: () -> Unit, onAdd: (() -> Unit)?,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
        DetailsAction(Icons.Outlined.Search, stringResource(R.string.b14_search), { returnToChat(nav, DetailsActions.SEARCH) })
        DetailsAction(
            if (cv.muted) Icons.Outlined.NotificationsOff else Icons.Outlined.Notifications,
            stringResource(if (cv.muted) R.string.b14_unmute else R.string.b14_mute), onMute, active = cv.muted,
        )
        if (peerId != null) DetailsAction(Icons.Outlined.Person, stringResource(R.string.b14_profile), { nav.navigate(com.meldiq.android.ui.Routes.user(peerId)) })
        if (onAdd != null) DetailsAction(Icons.Outlined.PersonAdd, stringResource(R.string.b14_add), onAdd)
        DetailsAction(Icons.Outlined.Shield, stringResource(R.string.b14_security), { returnToChat(nav, DetailsActions.SECURITY) })
    }
}

/** A DM only: start a group with this person through the usual new-group screen, with them already picked. */
@Composable
internal fun NewGroupWithRow(name: String, onClick: () -> Unit) {
    val c = Griip.colors
    ListCard(
        stringResource(R.string.b14_new_group), Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        subtitle = stringResource(R.string.b14_new_group_with, name),
        leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.GroupAdd, c.lavender, c.lavenderSoft, size = 44.dp) },
        trailing = { com.meldiq.android.ui.components.ArrowKnob() },
        onClick = onClick,
    )
}

@Composable
internal fun DetailsTabRow(tabs: List<DetailsRules.Tab>, selected: DetailsRules.Tab, counts: Map<DetailsRules.Tab, Int>, onSelect: (DetailsRules.Tab) -> Unit) {
    com.meldiq.android.ui.components.ChipRow {
        tabs.forEach { t -> PillChip(stringResource(tabLabel(t)), t == selected, { onSelect(t) }, count = counts[t]?.takeIf { it > 0 }) }
    }
}

private fun tabLabel(t: DetailsRules.Tab) = when (t) {
    DetailsRules.Tab.MEMBERS -> R.string.b14_tab_members
    DetailsRules.Tab.MEDIA -> R.string.b14_tab_media
    DetailsRules.Tab.PINS -> R.string.b14_tab_pins
    DetailsRules.Tab.THREADS -> R.string.b5_threads
    DetailsRules.Tab.LINKS -> R.string.b14_tab_links
    DetailsRules.Tab.FILES -> R.string.b14_tab_files
}

/** Photos and videos, three to a row, the newest first; tapping one opens its message in the chat. */
internal fun LazyListScope.mediaGrid(items: List<DetailsRules.Item<AttachmentRef>>, localFile: (AttachmentRef) -> File?, onOpen: (String) -> Unit) {
    if (items.isEmpty()) {
        item(key = "media-none") { EmptyState(Icons.Rounded.Image, androidx.compose.ui.res.stringResource(R.string.b14_none_media), "", art = null) }
        return
    }
    items(items.chunked(3), key = { row -> "media-" + row.first().messageId + row.first().value.id }) { row ->
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            row.forEach { item -> MediaTile(item.value, localFile(item.value), Modifier.weight(1f)) { onOpen(item.messageId) } }
            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun MediaTile(a: AttachmentRef, local: File?, modifier: Modifier, onOpen: () -> Unit) {
    val c = Griip.colors
    val kind = MediaGallery.kindOf(a)
    val bitmap by produceState<ImageBitmap?>(null, local?.path) {
        value = withContext(Dispatchers.IO) {
            when {
                local == null -> null
                kind == MediaKind.Image -> MediaExport.decode(local, 360)?.asImageBitmap()
                kind == MediaKind.Video -> MediaExport.videoFrame(local, 360)?.asImageBitmap()
                else -> null
            }
        }
    }
    Box(
        modifier.aspectRatio(1f).clip(Shapes.small).background(c.surfaceVariant)
            .pressable(onOpen, onClickLabel = if (kind == MediaKind.Video) "Open video" else "Open photo"),
        contentAlignment = Alignment.Center,
    ) {
        val bmp = bitmap
        if (bmp != null) Image(bmp, a.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Icon(if (kind == MediaKind.Video) Icons.Rounded.Videocam else Icons.Rounded.Image, null, tint = c.textTertiary)
        if (kind == MediaKind.Video && bmp != null) {
            Box(Modifier.size(30.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Files that aren't photos, videos or voice notes; tapping one opens its message, where it downloads and opens. */
internal fun LazyListScope.fileRows(items: List<DetailsRules.Item<AttachmentRef>>, senderName: (String) -> String, onOpen: (String) -> Unit) {
    if (items.isEmpty()) {
        item(key = "files-none") { EmptyState(Icons.AutoMirrored.Rounded.InsertDriveFile, androidx.compose.ui.res.stringResource(R.string.b14_none_files), "", art = null) }
        return
    }
    items(items, key = { "file-" + it.messageId + it.value.id }) { item ->
        val c = Griip.colors
        ListCard(
            item.value.name, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
            subtitle = humanSize(item.value.size) + " · " + senderName(item.senderId) + " · " + TimeFmt.listStamp(item.sortTs),
            leading = { com.meldiq.android.ui.components.IconTile(Icons.AutoMirrored.Rounded.InsertDriveFile, c.primary, c.primarySoft, size = 40.dp) },
            onClick = { onOpen(item.messageId) },
        )
    }
}

/** Links shared here, each once; tapping one opens it the way Settings › Chats says. */
internal fun LazyListScope.linkRows(items: List<DetailsRules.Item<String>>, senderName: (String) -> String, onOpen: (String) -> Unit) {
    if (items.isEmpty()) {
        item(key = "links-none") { EmptyState(Icons.Outlined.Link, androidx.compose.ui.res.stringResource(R.string.b14_none_links), "", art = null) }
        return
    }
    items(items, key = { "link-" + it.value }) { item ->
        val c = Griip.colors
        ListCard(
            DetailsRules.host(item.value), Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
            subtitle = item.value,
            meta = { Text(senderName(item.senderId) + " · " + TimeFmt.listStamp(item.sortTs), style = Griip.type.caption, color = c.textTertiary) },
            leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.Link, c.lavender, c.lavenderSoft, size = 40.dp) },
            onClick = { onOpen(item.value) },
        )
    }
}

/** Pinned messages, newest first; tapping one opens it in the chat. */
internal fun LazyListScope.pinRows(pinned: List<com.meldiq.android.data.db.MessageEntity>, senderName: (String) -> String, preview: (com.meldiq.android.data.db.MessageEntity) -> String, onOpen: (String) -> Unit) {
    if (pinned.isEmpty()) {
        item(key = "pins-none") { EmptyState(Icons.Outlined.PushPin, androidx.compose.ui.res.stringResource(R.string.b14_none_pins), "", art = null) }
        return
    }
    items(pinned, key = { "pin-" + it.id }) { m ->
        val c = Griip.colors
        ListCard(
            preview(m), Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
            subtitle = senderName(m.senderUserId) + " · " + TimeFmt.listStamp(m.sortTs),
            leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.PushPin, c.peach, c.peachSoft, size = 40.dp) },
            onClick = { onOpen(m.id) },
        )
    }
}

@Composable
internal fun DetailsSectionTitle(text: String) {
    Text(
        text, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = Griip.colors.textSecondary,
        modifier = Modifier.padding(start = Space.gutter, top = 14.dp, bottom = 6.dp),
    )
}

/**
 * The whole details screen of a DM, a group or (batch B14b) a channel. The info screen hands it the settings card and
 * member rows. A channel's settings are on their own page ([onOpenSettings]); [onManageAccess] is set for people who
 * may change who sees the channel.
 */
@Composable
internal fun ConversationDetailsList(
    nav: NavHostController,
    cv: ConversationEntity,
    me: String?,
    title: String,
    members: List<com.meldiq.android.data.api.UserDto>,
    pinned: List<com.meldiq.android.data.db.MessageEntity>,
    error: String?,
    settingsCard: @Composable () -> Unit,
    memberItems: LazyListScope.(List<com.meldiq.android.data.api.UserDto>) -> Unit,
    onAdd: (() -> Unit)?,
    onManageAccess: (() -> Unit)? = null,
    onOpenSettings: (() -> Unit)? = null,
) {
    val container = com.meldiq.android.ui.LocalContainer.current
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val channel = cv.type == "CHANNEL"
    val tabs = DetailsRules.tabs(cv.type, forum = cv.format == "forum")
    var tabName by rememberSaveable(cv.id) { mutableStateOf(tabs.first().name) }
    val tab = DetailsRules.Tab.valueOf(tabName)
    val withFiles by remember(cv.id) { container.messages.observeWithFiles(cv.id, SHARED_SHOWN) }.collectAsStateWithLifecycle(emptyList())
    val withLinks by remember(cv.id) { container.messages.observeWithLinks(cv.id, SHARED_SHOWN) }.collectAsStateWithLifecycle(emptyList())
    fun msg(m: com.meldiq.android.data.db.MessageEntity) = DetailsRules.Msg(m.id, m.sortTs, m.senderUserId, m.text, container.messages.attachments(m), m.deleted)
    val isVisual: (AttachmentRef) -> Boolean = { MediaGallery.visualKind(it) != null }
    val media = remember(withFiles) { DetailsRules.media(withFiles.map(::msg), isVisual) }
    val files = remember(withFiles) { DetailsRules.files(withFiles.map(::msg), isVisual) { com.meldiq.android.voice.VoiceNote.isVoice(it) } }
    val links = remember(withLinks) { DetailsRules.links(withLinks.map(::msg)) }
    val youLabel = stringResource(R.string.conv_you)
    val someone = stringResource(R.string.b14_someone)
    val names = members.associate { it.id to it.displayName }
    val senderName: (String) -> String = { id -> if (id == me) youLabel else names[id] ?: someone }
    val attachmentLabel = stringResource(R.string.b14_attachment)
    val preview: (com.meldiq.android.data.db.MessageEntity) -> String = { m ->
        m.text.lineSequence().firstOrNull()?.takeIf { it.isNotBlank() } ?: container.messages.attachments(m).firstOrNull()?.name ?: attachmentLabel
    }
    val peer = if (cv.type == "DM") com.meldiq.android.data.repo.ConversationRepository.peer(cv, me) else null
    val peerUser = peer?.let { p -> members.firstOrNull { it.id == p.id } }
    val chat by container.settings.state.collectAsStateWithLifecycle()
    var linkToConfirm by remember { mutableStateOf<String?>(null) }
    val openLink: (String) -> Unit = { url ->
        if (com.meldiq.android.ui.LinkOpener.needsConfirmation(url, chat.linkOpening)) linkToConfirm = url
        else com.meldiq.android.ui.LinkOpener.open(ctx, url, chat.linkOpening == com.meldiq.android.data.repo.LinkOpening.IN_APP)
    }
    val open: (String) -> Unit = { id -> returnToChat(nav, DetailsActions.jump(id)) }
    // Batch B14b: a channel's threads (the chat no longer has its own Threads button).
    val threadRoots by remember(cv.id, channel) {
        if (channel) container.messages.observeThreadRoots(cv.id, com.meldiq.android.data.model.ThreadListRules.SHOWN) else kotlinx.coroutines.flow.flowOf(emptyList())
    }.collectAsStateWithLifecycle(emptyList())
    val threadFile = stringResource(R.string.b5_thread_file)
    val threads = remember(threadRoots) {
        threadRoots.map { t ->
            com.meldiq.android.data.model.ThreadListRules.Row(
                t.root.id, com.meldiq.android.data.model.ThreadListRules.title(container.messages.rich(t.root)?.title, t.root.text, threadFile),
                t.root.senderUserId, t.root.outgoing, t.replyCount, t.lastReplyTs,
            )
        }
    }
    var threadQuery by rememberSaveable(cv.id) { mutableStateOf("") }
    val onMute: () -> Unit = { scope.launch { container.navPrefs.setMuted(cv, !cv.muted) } }
    androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 40.dp)) {
        if (channel) {
            item(key = "bar") {
                ChannelDetailsTopBar(
                    onBack = { nav.popBackStack() }, onSearch = { returnToChat(nav, DetailsActions.SEARCH) }, muted = cv.muted, onMute = onMute,
                    onSettings = { onOpenSettings?.invoke() },
                )
            }
            item(key = "header") { ChannelDetailsHeader(cv, me, "#$title") }
        } else item(key = "bar") { com.meldiq.android.ui.components.GriipTopBar(stringResource(if (cv.type == "GROUP") R.string.b5_group_info else R.string.b5_contact), onBack = { nav.popBackStack() }) }
        if (!channel) item(key = "header") {
            DetailsHeader(
                cv, me, title,
                subtitle = if (peer != null) "@${peer.username}" else stringResource(R.string.b14_members_n, members.size.takeIf { it > 0 } ?: cv.memberCount),
                presence = if (peerUser?.online == true) stringResource(R.string.b14_online) else null,
            )
        }
        error?.let { item(key = "error") { com.meldiq.android.ui.components.StatusBanner(it, com.meldiq.android.ui.components.BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        if (!channel) item(key = "actions") { DetailsActionsRow(nav, cv, peer?.id, onMute = onMute, onAdd = onAdd) }
        if (peer != null) item(key = "new-group") {
            NewGroupWithRow(peer.displayName) { nav.navigate(com.meldiq.android.ui.Routes.NEW_CHAT + "?mode=group&with=${peer.id}") }
        }
        item(key = "tabs") {
            Spacer(Modifier.height(6.dp))
            DetailsTabRow(
                tabs, tab,
                counts = mapOf(
                    DetailsRules.Tab.MEMBERS to members.size, DetailsRules.Tab.MEDIA to media.size, DetailsRules.Tab.PINS to pinned.size,
                    DetailsRules.Tab.THREADS to threads.size, DetailsRules.Tab.LINKS to links.size, DetailsRules.Tab.FILES to files.size,
                ),
            ) { tabName = it.name }
            Spacer(Modifier.height(6.dp))
        }
        when (tab) {
            DetailsRules.Tab.MEMBERS -> {
                onManageAccess?.let { manage -> item(key = "manage-access") { ManageAccessRow(manage) } }
                memberItems(members)
                // A channel's AI agents under its people, with the AI badge (API 0.40.0, as Meldiq Web).
            }
            DetailsRules.Tab.MEDIA -> mediaGrid(media, { container.messages.localAttachment(it) }, open)
            DetailsRules.Tab.PINS -> pinRows(pinned, senderName, preview, open)
            DetailsRules.Tab.THREADS -> threadRows(
                threads, threadQuery, { threadQuery = it }, senderName = { r -> senderName(r.senderId) },
                onOpen = { root -> nav.navigate(com.meldiq.android.ui.Routes.conversation(cv.id, root)) },
            )
            DetailsRules.Tab.LINKS -> linkRows(links, senderName, openLink)
            DetailsRules.Tab.FILES -> fileRows(files, senderName, open)
        }
        if (channel) {
            // Batch B14b: the truthful security details stay one tap away, without a padlock in every header.
            item(key = "security") {
                val c = Griip.colors
                ListCard(
                    stringResource(R.string.b14b_security), Modifier.padding(horizontal = 8.dp, vertical = 10.dp),
                    subtitle = stringResource(R.string.b14b_security_sub),
                    leading = { com.meldiq.android.ui.components.IconTile(Icons.Outlined.Shield, c.textSecondary, c.surfaceVariant, size = 40.dp) },
                    onClick = { returnToChat(nav, DetailsActions.SECURITY) },
                )
            }
        } else {
            item(key = "settings-title") { DetailsSectionTitle(stringResource(R.string.b14_settings)) }
            item(key = "settings") { settingsCard() }
        }
    }
    linkToConfirm?.let { url ->
        com.meldiq.android.ui.components.ConfirmDialog(
            stringResource(R.string.b14_open_link_q), url, stringResource(R.string.b14_open),
            onConfirm = { linkToConfirm = null; com.meldiq.android.ui.LinkOpener.open(ctx, url, chat.linkOpening == com.meldiq.android.data.repo.LinkOpening.IN_APP) },
            onDismiss = { linkToConfirm = null },
        )
    }
}

/** How many recent messages the Media, Files and Links tabs look through. */
private const val SHARED_SHOWN = 300
