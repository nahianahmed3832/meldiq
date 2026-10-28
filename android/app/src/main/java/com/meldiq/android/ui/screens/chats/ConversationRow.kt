package com.meldiq.android.ui.screens.chats

import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.data.repo.PreviewMode

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Headset
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

fun channelIcon(kind: String?, voice: Boolean = false, format: String? = null): ImageVector = when {
    voice -> Icons.Outlined.Headset
    format == "forum" -> Icons.Outlined.Forum
    kind == "PRIVATE" -> Icons.Outlined.Lock
    kind == "ANNOUNCEMENT" -> Icons.Outlined.Campaign
    else -> Icons.Outlined.Tag
}

/**
 * People are circles with initials, groups are circles with a group icon, and org channels are rounded
 * squares with their channel mark, so a personal group never looks like an organisation channel.
 */
@Composable
fun ConversationAvatar(conv: ConversationEntity, myUserId: String?, size: androidx.compose.ui.unit.Dp = 52.dp, online: Boolean? = null, presence: String? = null) {
    val c = Griip.colors
    when (conv.type) {
        "DM" -> {
            val peer = ConversationRepository.peer(conv, myUserId)
            com.meldiq.android.ui.components.UserAvatar(peer?.id, peer?.displayName ?: "?", peer?.avatarColor ?: 0, peer?.photoRev, size = size, online = online, presence = presence)
        }
        // Batch B6b: a group's own photo, when it has one.
        "GROUP" -> if (conv.photoRev != null) GroupPhoto(conv.id, conv.photoRev, size) else Box(Modifier.size(size).clip(CircleShape).background(c.lavenderSoft).semantics { contentDescription = "Group" }, contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Groups, null, tint = c.lavender, modifier = Modifier.size(size * 0.5f))
        }
        else -> {
            val (fg, bg) = when (conv.kind) {
                "ANNOUNCEMENT" -> c.peach to c.peachSoft
                "PRIVATE" -> c.lavender to c.lavenderSoft
                else -> c.primaryDeep to c.primarySoft
            }
            IconTile(channelIcon(conv.kind, conv.voice, conv.format), fg, bg, size = size, modifier = Modifier.semantics { contentDescription = "Channel" })
        }
    }
}

/** What the second line of a chat row shows, in priority order. Pure, so it is unit-tested. */
data class ChatPreview(val prefix: String?, val text: String, val kind: Kind) {
    enum class Kind { Typing, Draft, Message, Empty, Hidden }

    companion object {
        /** [mode] (Settings › Appearance): message text always, only while unread, or never; typing and drafts always show. */
        fun of(conv: ConversationEntity, typingNames: List<String>, mode: PreviewMode = PreviewMode.ALL): ChatPreview {
            if (typingNames.isNotEmpty()) {
                return ChatPreview(null, if (conv.type == "DM") "typing…" else "${typingNames.first()} is typing…", Kind.Typing)
            }
            val draft = conv.draft?.trim().orEmpty()
            if (draft.isNotEmpty()) return ChatPreview("Draft", draft.replace('\n', ' '), Kind.Draft)
            val last = conv.lastMessagePreview
            if (mode == PreviewMode.NONE || (mode == PreviewMode.UNREAD && conv.unreadCount == 0)) return ChatPreview(null, "", Kind.Hidden)
            if (last != null) {
                val who = conv.lastSenderName
                val prefix = when {
                    who == "You" -> "You"
                    conv.type != "DM" && who != null -> who
                    else -> null
                }
                return ChatPreview(prefix, last.replace('\n', ' '), Kind.Message)
            }
            if (conv.type == "CHANNEL") {
                val about = listOfNotNull(conv.scopeName, conv.topic).joinToString(" · ")
                if (about.isNotEmpty()) return ChatPreview(null, about, Kind.Empty)
            }
            return ChatPreview(null, "No messages yet", Kind.Empty)
        }
    }
}

private val RowAvatar = 56.dp
private val RowMinHeight = 80.dp

/**
 * A chat-list row: avatar, name, time, preview, and the indicators that apply (live call, muted, @mention, unread).
 * Since UI-002 (Cocoa home) rows are separated by space rather than dividers; [showDivider] keeps the old look on demand.
 */
@Composable
fun ConversationRow(
    conv: ConversationEntity,
    myUserId: String?,
    typingNames: List<String>,
    online: Boolean?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    showDivider: Boolean = false,
) {
    val c = Griip.colors
    val title = ConversationRepository.title(conv, myUserId).let { if (conv.type == "CHANNEL") "#$it" else it }
    val unread = conv.unreadCount > 0
    val container = com.meldiq.android.ui.LocalContainer.current
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val liveCalls by container.calls.live.collectAsStateWithLifecycle()
    // The same rule as channel rows and Meldiq Web: a DM or group counts from its first message, a mention is "@".
    val marker = com.meldiq.android.data.model.UnreadRules.marker(conv.unreadCount, conv.mentionCount, conv.muted, direct = conv.type != "CHANNEL")
    val preview = ChatPreview.of(conv, typingNames, settings.previewMode)
    val stamp = TimeFmt.listStamp(if (conv.lastMessageAt > 0) conv.lastMessageAt else conv.serverUpdatedAt)
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = RowMinHeight)
                .combinedClickable(
                    interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                    indication = ripple(),
                    onClick = onClick,
                    onLongClick = onLongClick,
                    onLongClickLabel = if (onLongClick != null) "More actions" else null,
                )
                .padding(horizontal = Space.gutter + 4.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ConversationAvatar(conv, myUserId, size = RowAvatar, online = online)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            title,
                            style = Griip.type.titleSmall.copy(fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold),
                            color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                        )
                        if (conv.muted) {
                            Spacer(Modifier.width(4.dp))
                            Icon(Icons.Rounded.NotificationsOff, "Muted", tint = c.textTertiary, modifier = Modifier.size(15.dp))
                        }
                        if (conv.activeCallId != null) {
                            Spacer(Modifier.width(6.dp))
                            com.meldiq.android.ui.components.LiveCallBadge(liveCalls[conv.id], conv.activeCallVideo)
                        }
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(stamp, style = Griip.type.caption.copy(fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium), color = if (unread && !conv.muted) c.primary else c.textSecondary)
                }
                if (preview.kind != ChatPreview.Kind.Hidden || conv.mentionCount > 0 || unread) Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val line = buildAnnotatedString {
                        preview.prefix?.let { p ->
                            withStyle(SpanStyle(color = if (preview.kind == ChatPreview.Kind.Draft) c.danger else c.textSecondary, fontWeight = FontWeight.SemiBold)) { append("$p: ") }
                        }
                        append(preview.text)
                    }
                    Text(
                        line, style = Griip.type.bodySmall,
                        color = when {
                            preview.kind == ChatPreview.Kind.Typing -> c.primary
                            unread -> c.textPrimary
                            else -> c.textSecondary
                        },
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    if (marker.highlighted) {
                        Spacer(Modifier.width(6.dp))
                        val spoken = when {
                            conv.mentionCount > 0 -> androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_unread_mentions, conv.mentionCount)
                            else -> androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_unread_messages, conv.unreadCount)
                        }
                        com.meldiq.android.ui.components.UnreadMarkerView(marker, Modifier.semantics { contentDescription = spoken })
                    }
                }
                // API 0.56.0: what the other person is playing (docs/ACTIVITY_STATUS.md).
                if (conv.type == "DM") {
                    val peer = remember(conv.membersJson, myUserId) { ConversationRepository.peer(conv, myUserId)?.id }
                    com.meldiq.android.ui.components.PlayingLine(com.meldiq.android.ui.components.rememberActivity(peer), Modifier.padding(top = 2.dp), withElapsed = false)
                }
            }
        }
        if (showDivider) HorizontalDivider(Modifier.padding(start = Space.gutter + 4.dp + RowAvatar + 14.dp), thickness = 1.dp, color = c.border)
    }
}



/** A group's photo, loaded and cached like people's (batch B6b); the group icon while it loads or if it can't. */
@Composable
private fun GroupPhoto(conversationId: String, rev: Long, size: androidx.compose.ui.unit.Dp) {
    val container = com.meldiq.android.ui.LocalContainer.current
    val c = Griip.colors
    val key = "$conversationId@$rev"
    val photo = androidx.compose.runtime.produceState(com.meldiq.android.ui.components.AvatarMemory.get(key), key) {
        if (value != null) return@produceState
        val file = runCatching { container.profiles.groupPhoto(conversationId, rev) }.getOrNull() ?: return@produceState
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            android.graphics.BitmapFactory.decodeFile(file.path)?.asImageBitmap()
        }?.also { com.meldiq.android.ui.components.AvatarMemory.put(key, it) }
    }
    val p = photo.value
    if (p != null) {
        androidx.compose.foundation.Image(
            p, null, contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            modifier = Modifier.size(size).clip(CircleShape).semantics { contentDescription = "Group" },
        )
    } else {
        Box(Modifier.size(size).clip(CircleShape).background(c.lavenderSoft).semantics { contentDescription = "Group" }, contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Groups, null, tint = c.lavender, modifier = Modifier.size(size * 0.5f))
        }
    }
}
