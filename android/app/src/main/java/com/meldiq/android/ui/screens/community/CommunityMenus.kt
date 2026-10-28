package com.meldiq.android.ui.screens.community

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.MarkChatRead
import androidx.compose.material.icons.outlined.MarkChatUnread
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material.icons.outlined.PostAdd
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.UnfoldLess
import androidx.compose.material.icons.rounded.UnfoldMore
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.screens.workspace.WorkspaceList
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** One line of a menu sheet: an icon and a label; destructive lines are red and come last. */
@Composable
fun SheetItem(icon: ImageVector, label: String, onClick: () -> Unit, danger: Boolean = false, subtitle: String? = null) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().clip(Shapes.small).pressable(onClick).heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (danger) c.danger else c.textSecondary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = Griip.type.bodyMedium, color = if (danger) c.danger else c.textPrimary)
            subtitle?.let { Text(it, style = Griip.type.caption, color = c.textSecondary) }
        }
    }
}

/** A switch line inside a menu sheet (Hide muted channels, Unread only). */
@Composable
internal fun SheetSwitch(icon: ImageVector, label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().clip(Shapes.small).pressable({ onChange(!checked) }, role = Role.Switch).heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = c.textSecondary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, style = Griip.type.bodyMedium, color = c.textPrimary, modifier = Modifier.weight(1f))
        GriipSwitch(checked, onChange)
    }
}

@Composable
internal fun SheetDivider() = HorizontalDivider(Modifier.padding(vertical = 6.dp), thickness = 1.dp, color = Griip.colors.border)

/** The big buttons at the top of the community sheet (Invite, Notifications, Settings). */
@Composable
private fun SheetButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Griip.colors
    Column(
        modifier.clip(Shapes.card).background(c.surfaceVariant).pressable(onClick).padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, tint = c.textPrimary, modifier = Modifier.size(22.dp))
        Spacer(Modifier.height(4.dp))
        Text(label, style = Griip.type.caption, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** What the community sheet can do; null hides an item (the person may not do it, or the server doesn't offer it). */
class CommunityMenuActions(
    val onInvite: (() -> Unit)?,
    val onToggleMute: (() -> Unit)?,
    val onSettings: () -> Unit,
    val onMarkRead: (() -> Unit)?,
    val onNewChannel: (() -> Unit)?,
    val onNewCategory: (() -> Unit)?,
    val onEvents: () -> Unit,
    val onMembers: (() -> Unit)?,
    val onHideMuted: (Boolean) -> Unit,
    val onUnreadOnly: (Boolean) -> Unit,
    val onCopyName: () -> Unit,
    val onLeave: (() -> Unit)?,
    /** Batch B2: the community's notification settings; null on servers that can't keep them. */
    val onNotifications: (() -> Unit)? = null,
    /** Batch B2: arrange the rail. */
    val onArrange: (() -> Unit)? = null,
    /** Batch B3: choose which channels appear in the list. */
    val onBrowse: (() -> Unit)? = null,
    /** Meldiq Spark: the server's level and giving a Spark (docs/MOJO_ANDROID.md). */
    val onSpark: (() -> Unit)? = null,
)

/**
 * The community sheet (tap the panel's header): the community's mark, name and size; Invite, Notifications and
 * Settings; then the community-wide actions and your view switches (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §3).
 */
@Composable
fun CommunityMenuSheet(org: OrgDto, memberCount: Int, allMuted: Boolean, hideMuted: Boolean, unreadOnly: Boolean, actions: CommunityMenuActions, onDismiss: () -> Unit) {
    val c = Griip.colors
    fun run(f: () -> Unit): () -> Unit = { onDismiss(); f() }
    GlassSheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 14.dp)) {
                OrgMark(org.id, org.name, WorkspaceList.colorSeed(org), org.photoRev, size = 52.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(org.name, style = Griip.type.title, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                    Text(memberCountLabel(memberCount), style = Griip.type.caption, color = c.textSecondary)
                }
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                actions.onInvite?.let { SheetButton(Icons.Outlined.PersonAddAlt, stringResource(R.string.nv_invite), run(it), Modifier.weight(1f)); Spacer(Modifier.width(8.dp)) }
                actions.onToggleMute?.let {
                    SheetButton(
                        if (allMuted) Icons.Outlined.Notifications else Icons.Outlined.NotificationsOff,
                        stringResource(if (allMuted) R.string.nv_unmute else R.string.nv_mute), run(it), Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                }
                SheetButton(Icons.Outlined.Settings, stringResource(R.string.settings_title), run(actions.onSettings), Modifier.weight(1f))
            }
            actions.onSpark?.let { SheetItem(Icons.Outlined.Bolt, stringResource(R.string.mojo_spark_open), run(it)) }
            actions.onMarkRead?.let { SheetItem(Icons.Outlined.MarkChatRead, stringResource(R.string.nv_mark_read), run(it)) }
            actions.onNotifications?.let { SheetItem(Icons.Outlined.Notifications, stringResource(R.string.cn_title), run(it)) }
            actions.onBrowse?.let { SheetItem(Icons.Outlined.Visibility, stringResource(R.string.hc_browse), run(it)) }
            actions.onNewChannel?.let { SheetItem(Icons.Outlined.PostAdd, stringResource(R.string.cm_new_channel), run(it)) }
            actions.onNewCategory?.let { SheetItem(Icons.Outlined.CreateNewFolder, stringResource(R.string.cm_new_category), run(it)) }
            SheetItem(Icons.Outlined.Event, stringResource(R.string.cm_events), run(actions.onEvents))
            actions.onMembers?.let { SheetItem(Icons.Outlined.People, stringResource(R.string.cm_stat_members), run(it)) }
            SheetDivider()
            SheetSwitch(Icons.Outlined.VisibilityOff, stringResource(R.string.nv_hide_muted), hideMuted, actions.onHideMuted)
            SheetSwitch(Icons.Outlined.MarkChatUnread, stringResource(R.string.home_unread_only), unreadOnly, actions.onUnreadOnly)
            SheetItem(Icons.Outlined.ContentCopy, stringResource(R.string.nv_copy_name), run(actions.onCopyName))
            actions.onArrange?.let { SheetItem(Icons.Outlined.SwapVert, stringResource(R.string.rail_arrange), run(it)) }
            actions.onLeave?.let {
                SheetDivider()
                SheetItem(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.nv_leave_community), run(it), danger = true)
            }
        }
    }
}

/** A category's long-press menu ([CommunityMenuRules.category] decides the items). */
@Composable
fun CategoryMenuSheet(title: String, items: List<CategoryMenuItem>, onDismiss: () -> Unit, onPick: (CategoryMenuItem) -> Unit) {
    GlassSheet(onDismiss, title = title) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            items.forEach { item ->
                if (item == CategoryMenuItem.NEW_CHANNEL || item == CategoryMenuItem.DELETE) SheetDivider()
                val (icon, label) = categoryItem(item)
                SheetItem(icon, label, { onDismiss(); onPick(item) }, danger = item == CategoryMenuItem.DELETE)
            }
        }
    }
}

@Composable
private fun categoryItem(item: CategoryMenuItem): Pair<ImageVector, String> = when (item) {
    CategoryMenuItem.MARK_READ -> Icons.Outlined.MarkChatRead to stringResource(R.string.nv_mark_read)
    CategoryMenuItem.COLLAPSE -> Icons.Rounded.UnfoldLess to stringResource(R.string.nv_collapse)
    CategoryMenuItem.EXPAND -> Icons.Rounded.UnfoldMore to stringResource(R.string.nv_expand)
    CategoryMenuItem.COLLAPSE_ALL -> Icons.Rounded.UnfoldLess to stringResource(R.string.home_collapse_all)
    CategoryMenuItem.MUTE -> Icons.Outlined.NotificationsOff to stringResource(R.string.nv_mute_category)
    CategoryMenuItem.UNMUTE -> Icons.Outlined.Notifications to stringResource(R.string.nv_unmute_category)
    CategoryMenuItem.NOTIFY -> Icons.Outlined.Tune to stringResource(R.string.cn_title)
    CategoryMenuItem.NEW_CHANNEL -> Icons.Outlined.PostAdd to stringResource(R.string.cm_new_channel)
    CategoryMenuItem.RENAME -> Icons.Outlined.Edit to stringResource(R.string.nv_edit_category)
    CategoryMenuItem.PERMISSIONS -> Icons.Outlined.AdminPanelSettings to stringResource(R.string.cm_permissions)
    CategoryMenuItem.MOVE_UP -> Icons.Rounded.KeyboardArrowUp to stringResource(R.string.cm_move_up)
    CategoryMenuItem.MOVE_DOWN -> Icons.Rounded.KeyboardArrowDown to stringResource(R.string.cm_move_down)
    CategoryMenuItem.DELETE -> Icons.Outlined.DeleteOutline to stringResource(R.string.nv_delete_category)
}

/** A channel's long-press menu: its identity on top, then [CommunityMenuRules.channel]'s items. */
@Composable
fun ChannelMenuSheet(ch: PanelChannel, items: List<ChannelMenuItem>, onDismiss: () -> Unit, onPick: (ChannelMenuItem) -> Unit) {
    val c = Griip.colors
    GlassSheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 10.dp)) {
                IconTile(panelIcon(ch.kind, ch.voice, ch.format), c.textPrimary, c.surfaceVariant, size = 40.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(ch.name, style = Griip.type.titleSmall.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    (ch.topic ?: ch.categoryName)?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
            }
            items.forEach { item ->
                if (item == ChannelMenuItem.EDIT || item == ChannelMenuItem.DELETE || (item == ChannelMenuItem.MOVE_TO && ChannelMenuItem.EDIT !in items)) SheetDivider()
                val (icon, label) = channelItem(item)
                SheetItem(icon, label, { onDismiss(); onPick(item) }, danger = item == ChannelMenuItem.DELETE)
            }
        }
    }
}

@Composable
private fun channelItem(item: ChannelMenuItem): Pair<ImageVector, String> = when (item) {
    ChannelMenuItem.MARK_READ -> Icons.Outlined.MarkChatRead to stringResource(R.string.nv_mark_read)
    ChannelMenuItem.FAVOURITE -> Icons.Outlined.StarBorder to stringResource(R.string.nv_favourite)
    ChannelMenuItem.UNFAVOURITE -> Icons.Rounded.Star to stringResource(R.string.nv_unfavourite)
    ChannelMenuItem.MUTE -> Icons.Outlined.NotificationsOff to stringResource(R.string.nv_mute_channel)
    ChannelMenuItem.UNMUTE -> Icons.Outlined.Notifications to stringResource(R.string.nv_unmute_channel)
    ChannelMenuItem.HIDE -> Icons.Outlined.VisibilityOff to stringResource(R.string.hc_hide)
    ChannelMenuItem.SHOW -> Icons.Outlined.Visibility to stringResource(R.string.hc_show)
    ChannelMenuItem.COPY_NAME -> Icons.Outlined.ContentCopy to stringResource(R.string.nv_copy_name)
    ChannelMenuItem.EDIT -> Icons.Outlined.Edit to stringResource(R.string.nv_edit_channel)
    ChannelMenuItem.PERMISSIONS -> Icons.Outlined.AdminPanelSettings to stringResource(R.string.cm_permissions)
    ChannelMenuItem.MOVE_TO -> Icons.AutoMirrored.Outlined.DriveFileMove to stringResource(R.string.cm_move_to)
    ChannelMenuItem.MOVE_UP -> Icons.Rounded.KeyboardArrowUp to stringResource(R.string.cm_move_up)
    ChannelMenuItem.MOVE_DOWN -> Icons.Rounded.KeyboardArrowDown to stringResource(R.string.cm_move_down)
    ChannelMenuItem.ARCHIVE -> Icons.Outlined.Archive to stringResource(R.string.nv_archive_channel)
    ChannelMenuItem.RESTORE -> Icons.Outlined.Unarchive to stringResource(R.string.nv_restore_channel)
    ChannelMenuItem.DELETE -> Icons.Outlined.DeleteOutline to stringResource(R.string.nv_delete_channel)
}
