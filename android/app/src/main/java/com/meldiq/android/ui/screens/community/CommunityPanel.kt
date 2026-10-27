package com.meldiq.android.ui.screens.community

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.db.UserEntity
import com.meldiq.android.data.model.ChannelType
import com.meldiq.android.data.model.ChannelTypes
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** Start padding of channel rows inside a category (the reference indents them under the header). */
private val RowIndent = 8.dp

/** The channel type's icon: # text, lock for private, megaphone, forum bubbles, speaker for voice. */
fun panelIcon(kind: String?, voice: Boolean, format: String): ImageVector = when (ChannelTypes.of(kind, voice, format)) {
    ChannelType.VOICE -> Icons.AutoMirrored.Outlined.VolumeUp
    ChannelType.FORUM -> Icons.Outlined.Forum
    ChannelType.ANNOUNCEMENT -> Icons.Outlined.Campaign
    ChannelType.TEXT -> if (kind == "PRIVATE") Icons.Outlined.Lock else Icons.Outlined.Tag
}

/** A community banner's height above its channel list. */
private val BannerHeight = 84.dp

/**
 * A community's banner (API 0.44.0, as Meldiq Web): its picture, else a soft band in its accent, else nothing. Scoped to
 * this community's panel; it never recolours the app.
 */
@Composable
fun CommunityBanner(orgId: String, accent: String?, bannerRev: Long?) {
    val colors = com.meldiq.android.data.model.AccentRules.colors(accent)
    if (bannerRev == null && colors == null) return
    val container = com.meldiq.android.ui.LocalContainer.current
    val image by androidx.compose.runtime.produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, orgId, bannerRev) {
        val rev = bannerRev ?: return@produceState
        val file = runCatching { container.profiles.orgBanner(orgId, rev) }.getOrNull() ?: return@produceState
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { android.graphics.BitmapFactory.decodeFile(file.path)?.asImageBitmap() }
    }
    val band = colors?.let {
        val fill = androidx.compose.ui.graphics.Color(it.fill)
        androidx.compose.ui.graphics.Brush.linearGradient(listOf(fill, androidx.compose.ui.graphics.Color(com.meldiq.android.data.model.AccentRules.mix(it.fill, 0xFF8B5CF6L, 0.55))))
    } ?: androidx.compose.ui.graphics.Brush.linearGradient(listOf(Griip.colors.surfaceVariant, Griip.colors.surfaceVariant))
    Box(Modifier.fillMaxWidth().height(BannerHeight).background(band)) {
        image?.let { androidx.compose.foundation.Image(it, null, contentScale = androidx.compose.ui.layout.ContentScale.Crop, modifier = Modifier.matchParentSize()) }
    }
}

/** The panel's header: the community's name (opens its sheet), search and invite. */
@Composable
fun PanelHeader(name: String, memberLine: String?, onMenu: () -> Unit, onSearch: () -> Unit, onInvite: (() -> Unit)?) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).clip(Shapes.small).pressable(onMenu, onClickLabel = stringResource(R.string.nv_community_menu)).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f, fill = false)) {
                Text(name, style = Griip.type.titleSmall.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                memberLine?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, maxLines = 1) }
            }
            Icon(Icons.Rounded.KeyboardArrowRight, null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
        }
        CircleIconButton(Icons.Outlined.Search, stringResource(R.string.nv_search_community), onSearch, tint = c.textSecondary, size = 40.dp)
        onInvite?.let { CircleIconButton(Icons.Outlined.PersonAddAlt, stringResource(R.string.nv_invite), it, tint = c.textSecondary, size = 40.dp) }
    }
}

/** Events, Members: a quiet row above the channels. */
@Composable
fun PanelShortcut(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 6.dp).clip(Shapes.small).pressable(onClick).heightIn(min = 40.dp).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(label, style = Griip.type.bodyMedium, color = c.textSecondary, maxLines = 1)
    }
}

/**
 * A category header: tap to collapse or expand, long-press for its menu, "+" to create a channel in it (for people
 * who may). Collapsed, it still shows its unread count.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PanelSectionHeader(
    title: String,
    collapsed: Boolean,
    unreadWhileCollapsed: Int,
    onToggle: () -> Unit,
    onLongPress: () -> Unit,
    onAdd: (() -> Unit)?,
) {
    val c = Griip.colors
    val state = stringResource(if (collapsed) R.string.nv_collapsed else R.string.nv_expanded)
    Row(
        Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 36.dp)
            .combinedClickable(onClick = onToggle, onLongClick = onLongPress, onLongClickLabel = stringResource(R.string.nv_category_menu))
            .semantics { stateDescription = state; heading() }
            .padding(start = 8.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (collapsed) Icons.Rounded.KeyboardArrowRight else Icons.Rounded.KeyboardArrowDown, null, tint = c.textTertiary, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(2.dp))
        Text(
            title.uppercase(), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold, letterSpacing = Griip.type.caption.letterSpacing),
            color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        if (collapsed && unreadWhileCollapsed > 0) {
            Text("$unreadWhileCollapsed", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, modifier = Modifier.padding(end = 6.dp))
        }
        if (onAdd != null) CircleIconButton(Icons.Rounded.Add, stringResource(R.string.nv_create_in, title), onAdd, tint = c.textSecondary, size = 32.dp)
    }
}

/** Favourites: your starred channels in this community, above the categories. */
@Composable
fun PanelFavouritesHeader() {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 14.dp, bottom = 2.dp).semantics { heading() }, verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Star, null, tint = c.warning, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(stringResource(R.string.nv_favourites).uppercase(), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.textSecondary)
    }
}

/**
 * One channel: its type icon and name; something unread in bold and the primary text colour, with the unread marker
 * ([com.meldiq.android.data.model.UnreadRules], as Meldiq Web: a dot for one, a light count for more, "@" for mentions); muted dimmed; the one you have open highlighted; one you haven't joined dimmed until you open it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PanelChannelRow(
    ch: PanelChannel, selected: Boolean, onClick: () -> Unit, onLongPress: () -> Unit,
    /** The channel's live call as rows show it (kind, people, screen sharing), when its details have arrived. */
    live: com.meldiq.android.call.LiveCall? = null,
) {
    val c = Griip.colors
    val strong = ch.hasNews && !ch.muted
    val tint = when {
        selected || strong -> c.textPrimary
        ch.muted -> c.textTertiary
        else -> c.textSecondary
    }
    val status = buildList {
        if (!ch.joined) add(stringResource(R.string.nv_not_joined))
        if (ch.mentions > 0) add(stringResource(R.string.home_mention_count, ch.mentions))
        else if (ch.unread > 0) add(stringResource(R.string.home_unread_messages, ch.unread))
        if (ch.muted) add(stringResource(R.string.nv_muted))
        if (ch.liveCall) add(stringResource(R.string.nv_live_call))
    }.joinToString(", ")
    Row(
        Modifier.fillMaxWidth().padding(start = RowIndent, end = 6.dp, top = 1.dp, bottom = 1.dp)
            .clip(Shapes.small)
            .background(if (selected) c.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongPress, onLongClickLabel = stringResource(R.string.nv_channel_menu))
            .semantics { this.selected = selected; if (status.isNotEmpty()) stateDescription = status }
            .heightIn(min = 40.dp)
            .alpha(if (ch.joined) 1f else 0.7f)
            .padding(start = 8.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(panelIcon(ch.kind, ch.voice, ch.format), null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            ch.name, style = Griip.type.bodyMedium.copy(fontWeight = if (strong || selected) FontWeight.SemiBold else FontWeight.Normal),
            color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        if (ch.liveCall) com.meldiq.android.ui.components.LiveCallBadge(live, video = live?.video ?: false, modifier = Modifier.padding(end = 6.dp))
        com.meldiq.android.ui.components.UnreadMarkerView(com.meldiq.android.data.model.UnreadRules.marker(ch.unread, ch.mentions, ch.muted))
    }
}

/** The people in a voice channel's call, under its row (avatars and names, at most [shown]). */
@Composable
fun PanelVoicePeople(people: List<String>, users: Map<String, UserEntity>, shown: Int = 6) {
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(start = RowIndent + 38.dp, end = 12.dp, bottom = 4.dp)) {
        people.take(shown).forEach { id ->
            val u = users[id]
            Row(Modifier.heightIn(min = 28.dp).semantics { contentDescription = u?.displayName ?: "" }, verticalAlignment = Alignment.CenterVertically) {
                Avatar(u?.displayName ?: "?", u?.avatarColor ?: id.hashCode(), size = 20.dp)
                Spacer(Modifier.width(8.dp))
                Text(u?.displayName ?: "…", style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (people.size > shown) Text(stringResource(R.string.nv_and_more, people.size - shown), style = Griip.type.caption, color = c.textTertiary)
    }
}

/** Shown under an empty category for the people who may add channels to it. */
@Composable
fun PanelEmptyCategory() {
    Text(
        stringResource(R.string.cm_empty_category), style = Griip.type.caption, color = Griip.colors.textTertiary,
        modifier = Modifier.padding(start = RowIndent + 16.dp, top = 2.dp, bottom = 4.dp),
    )
}

/** A thin spacer between groups of rows. */
@Composable
fun PanelGap() = Spacer(Modifier.height(4.dp))

/** "1 member" / "N members". */
@Composable
fun memberCountLabel(n: Int): String = if (n == 1) stringResource(R.string.nv_member_one) else stringResource(R.string.nv_member_count, n)

/** "1 person" / "n people" (batch B12: "1 people" was shown on roles and events). */
@Composable
fun peopleCountLabel(n: Int): String = if (n == 1) stringResource(R.string.b12_one_person) else stringResource(R.string.roles_people, n)
