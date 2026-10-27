package com.meldiq.android.ui.screens.conversation

import com.meldiq.android.data.model.MentionSpan
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Redo
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Done
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.db.UserEntity
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.model.CallHistory
import com.meldiq.android.data.model.CallInfo
import androidx.compose.runtime.remember
import com.meldiq.android.data.model.MessageStatus
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.media.MediaExport
import com.meldiq.android.ui.media.MediaGallery
import com.meldiq.android.ui.media.MediaKind
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.voice.VoiceNote
import com.meldiq.android.voice.VoicePlayer
import java.io.File

data class BubbleModel(
    val m: MessageEntity,
    val sender: UserEntity?,
    val showSender: Boolean,
    val showAvatar: Boolean,
    val firstInGroup: Boolean,
    val reply: MessageEntity?,
    val replySender: String?,
    val reactions: Map<String, List<String>>,
    val attachments: List<AttachmentRef>,
    val threadCount: Int,
    val isGroupConv: Boolean,
    val replyPreview: String? = null,
    /** Where the text mentions people (from the message's mentioned ids, docs/MENTIONS.md). */
    val mentions: List<MentionSpan> = emptyList(),
    /** A contact card, location, poll, sticker or animated emoji (docs/RICH_MESSAGES.md); its text is then only the fallback. */
    val rich: com.meldiq.android.data.model.RichContent? = null,
    val animateEmoji: Boolean = true,
    /** Chat settings › text size. */
    val textScale: Float = 1f,
    /** A translation shown under the text (made on this phone; the message itself is unchanged). */
    val translation: ConversationViewModel.Translated? = null,
    /** Settings › Chats › Message layout: the Stream layout (names and avatars, everything aligned left) or bubbles. */
    val stream: Boolean = false,
    /** Music and video links as cards that open the official app (Settings › Chats). */
    val mediaCards: Boolean = true,
    /** Whether you may vote in this conversation (where you can't post, the server refuses votes too). */
    val canVote: Boolean = true,
    /** Saved for later (Home › Later). */
    val saved: Boolean = false,
    /** It mentions you (or @everyone reached you): the row is tinted with an accent bar at its start. */
    val mentionsYou: Boolean = false,
)

/** A message that mentions you: a soft tint behind the whole row and a bar at its start edge, in both layouts. */
@Composable
private fun Modifier.mentionHighlight(on: Boolean): Modifier {
    if (!on) return this
    val c = Griip.colors
    val tint = c.warningSoft.copy(alpha = 0.55f)
    val bar = c.warning
    return this.drawBehind {
        drawRect(tint)
        val w = 3.dp.toPx()
        val x = if (layoutDirection == androidx.compose.ui.unit.LayoutDirection.Ltr) 0f else size.width - w
        drawRect(bar, topLeft = androidx.compose.ui.geometry.Offset(x, 0f), size = androidx.compose.ui.geometry.Size(w, size.height))
    }
}

/** What a message can do when touched; one set shared by both layouts. */
private class MessageCallbacks(
    val onLongPress: () -> Unit,
    val onReact: (String) -> Unit,
    val onOpenAttachment: (AttachmentRef) -> Unit,
    val onOpenThread: (() -> Unit)?,
    val onRetry: () -> Unit,
    val onReplyClick: (String) -> Unit,
    val onVoiceToggle: (AttachmentRef) -> Unit,
    val onVoiceSeek: (AttachmentRef, Long) -> Unit,
    val onMentionClick: (String) -> Unit,
    val onCopyText: (String) -> Unit,
    val onFindPhone: ((String) -> Unit)?,
    val onOpenLink: (String) -> Unit,
    val onVote: (List<String>) -> Unit,
    val linkDetails: (@Composable (String) -> Unit)?,
    val onDoubleTap: (() -> Unit)?,
    val onPlayVideo: ((String) -> Unit)?,
    val onShowReactions: ((String) -> Unit)?,
)

/**
 * One message, in the Stream layout (default since 2026-10-19: avatar and name beside each run, everything aligned
 * left, no bubbles) or as a bubble (outgoing soft accent on the right, incoming plain on the left). Both draw the same
 * body, so every kind of message works the same way in either.
 */
@Composable
fun MessageBubble(
    b: BubbleModel,
    me: String?,
    transfer: Float?,
    localFile: (AttachmentRef) -> File?,
    onLongPress: () -> Unit,
    onReact: (String) -> Unit,
    onOpenAttachment: (AttachmentRef) -> Unit,
    onOpenThread: (() -> Unit)?,
    onRetry: () -> Unit,
    onReplyClick: (String) -> Unit,
    voice: VoicePlayer.State = VoicePlayer.State(),
    onVoiceToggle: (AttachmentRef) -> Unit = {},
    onVoiceSeek: (AttachmentRef, Long) -> Unit = { _, _ -> },
    onMentionClick: (String) -> Unit = {},
    onCopyText: (String) -> Unit = {},
    onFindPhone: ((String) -> Unit)? = null,
    onOpenLink: (String) -> Unit = {},
    onVote: (List<String>) -> Unit = {},
    /** Extra details under a link, when the screen has any to show (none since apps were removed; kept as a slot). */
    linkDetails: (@Composable (String) -> Unit)? = null,
    /** Runs while a received message with files is on screen (cancelled when it scrolls away): loads its photos. */
    onShown: (suspend () -> Unit)? = null,
    /** Settings › Chats › Gestures: a double-tap adds the chosen reaction; null when off or not allowed here. */
    onDoubleTap: (() -> Unit)? = null,
    /** 2026-10-23: plays a YouTube video (its id) inside Meldiq; null opens the YouTube app instead. */
    onPlayVideo: ((String) -> Unit)? = null,
    /** A long press on a reaction: everyone who reacted, opened on that reaction (as Meldiq Web). */
    onShowReactions: ((String) -> Unit)? = null,
) {
    val m = b.m
    if (onShown != null && !m.outgoing && b.attachments.isNotEmpty()) LaunchedEffect(m.id) { onShown() }
    if (m.kind == "call") {
        CallChip(m, m.outgoing, b.sender)
        return
    }
    val cb = MessageCallbacks(
        onLongPress, onReact, onOpenAttachment, onOpenThread, onRetry, onReplyClick, onVoiceToggle, onVoiceSeek, onMentionClick,
        onCopyText, onFindPhone, onOpenLink, onVote, linkDetails, onDoubleTap, onPlayVideo, onShowReactions,
    )
    if (b.stream) StreamMessage(b, me, transfer, localFile, voice, cb) else BubbleMessage(b, me, transfer, localFile, voice, cb)
}

/** Drawn without a bubble or card: an animated emoji or a sticker on its own. */
private fun BubbleModel.standalone(): Boolean =
    (rich?.animoji != null || rich?.sticker != null || rich?.customSticker != null) && attachments.isEmpty() && !m.deleted && m.kind == "text" && reply == null

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BubbleMessage(b: BubbleModel, me: String?, transfer: Float?, localFile: (AttachmentRef) -> File?, voice: VoicePlayer.State, cb: MessageCallbacks) {
    val c = Griip.colors
    val m = b.m
    val out = m.outgoing
    val r = Shapes.bubble
    val tail = Shapes.bubbleTail
    val shape = if (out) RoundedCornerShape(r, if (b.firstInGroup) tail else r, r, r) else RoundedCornerShape(if (b.firstInGroup) tail else r, r, r, r)
    val sub = if (out) c.bubbleOutgoingMeta else c.textSecondary
    Row(
        Modifier.fillMaxWidth().mentionHighlight(b.mentionsYou).padding(start = if (out) 56.dp else 10.dp, end = if (out) 10.dp else 48.dp, top = if (b.firstInGroup) 8.dp else 2.dp),
        horizontalArrangement = if (out) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!out && b.isGroupConv) {
            if (b.showAvatar) com.meldiq.android.ui.components.LookAvatar(b.sender?.id, b.sender?.displayName ?: "?", b.sender?.avatarColor ?: 0, b.sender?.photoRev, com.meldiq.android.data.model.PersonLooks.of(b.sender?.lookJson), size = 30.dp)
            else Spacer(Modifier.width(30.dp))
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = if (out) Alignment.End else Alignment.Start) {
            val standalone = b.standalone()
            val bg = when {
                standalone -> Color.Transparent
                m.kind == "undecryptable" -> c.dangerSoft
                m.deleted -> c.surfaceVariant
                out -> c.bubbleOutgoing
                else -> c.bubbleIncoming
            }
            Column(
                Modifier
                    .widthIn(max = 310.dp)
                    .clip(shape)
                    .background(bg)
                    .combinedClickable(onClick = { if (m.status == MessageStatus.FAILED) cb.onRetry() }, onLongClick = cb.onLongPress, onLongClickLabel = "Message actions", onDoubleClick = cb.onDoubleTap)
                    .padding(horizontal = if (standalone) 0.dp else 12.dp, vertical = 7.dp),
            ) {
                if (b.showSender && !out && b.isGroupConv) {
                    com.meldiq.android.ui.components.StyledName(
                        b.sender?.displayName ?: "Unknown", com.meldiq.android.data.model.PersonLooks.of(b.sender?.lookJson),
                        Griip.type.label.copy(fontWeight = FontWeight.SemiBold), senderColor(b.sender?.avatarColor ?: 0),
                    )
                    Spacer(Modifier.height(2.dp))
                }
                MessageBody(b, me, tinted = out, transfer, localFile, voice, cb)
                Row(Modifier.align(Alignment.End).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    MetaMarks(b, sub)
                    Text(TimeFmt.clock(m.sortTs), style = Griip.type.caption, color = sub)
                    if (out) {
                        Spacer(Modifier.width(4.dp))
                        StatusIcon(m.status, sub)
                    }
                }
            }
            MessageExtras(b, me, alignEnd = out, cb)
        }
    }
}

/**
 * The Stream layout: the first message of a run carries the sender's avatar, name and time; the rest of the run lines
 * up under it. Your own messages sit on the same side (your name in the accent) with their delivery state at the end
 * of the row, so long conversations read like a document rather than a back-and-forth of bubbles.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StreamMessage(b: BubbleModel, me: String?, transfer: Float?, localFile: (AttachmentRef) -> File?, voice: VoicePlayer.State, cb: MessageCallbacks) {
    val c = Griip.colors
    val m = b.m
    val out = m.outgoing
    Row(
        Modifier.fillMaxWidth()
            .mentionHighlight(b.mentionsYou)
            .combinedClickable(onClick = { if (m.status == MessageStatus.FAILED) cb.onRetry() }, onLongClick = cb.onLongPress, onLongClickLabel = "Message actions", onDoubleClick = cb.onDoubleTap)
            .padding(start = 14.dp, end = 12.dp, top = if (b.firstInGroup) 10.dp else 1.dp, bottom = 1.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(StreamAvatar)) {
            if (b.firstInGroup) com.meldiq.android.ui.components.LookAvatar(b.sender?.id, b.sender?.displayName ?: "?", b.sender?.avatarColor ?: 0, b.sender?.photoRev, com.meldiq.android.data.model.PersonLooks.of(b.sender?.lookJson), size = StreamAvatar)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f).widthIn(max = 640.dp)) {
            if (b.firstInGroup) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 1.dp)) {
                    // Name styles and the worn tag (API 0.46.0), as Meldiq Web shows them in messages.
                    com.meldiq.android.ui.components.StyledName(
                        b.sender?.displayName?.takeIf { it.isNotBlank() } ?: if (out) androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_you) else "Unknown",
                        com.meldiq.android.data.model.PersonLooks.of(b.sender?.lookJson),
                        Griip.type.bodyMedium.copy(fontWeight = FontWeight.Bold), if (out) c.primary else c.textPrimary,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(TimeFmt.clock(m.sortTs), style = Griip.type.caption, color = c.textSecondary)
                }
            }
            val flagged = m.kind == "undecryptable"
            Column(
                if (flagged) Modifier.clip(Shapes.small).background(c.dangerSoft).padding(horizontal = 8.dp, vertical = 6.dp) else Modifier.padding(vertical = 1.dp),
            ) {
                MessageBody(b, me, tinted = false, transfer, localFile, voice, cb)
            }
            if (m.pinned || (m.editedAt != null && !m.deleted) || b.saved) {
                Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) { MetaMarks(b, c.textSecondary) }
            }
            MessageExtras(b, me, alignEnd = false, cb)
        }
        if (out) {
            Box(Modifier.padding(start = 6.dp, top = if (b.firstInGroup) 26.dp else 4.dp)) { StatusIcon(m.status, c.textSecondary) }
        }
    }
}

private val StreamAvatar = 36.dp

/** Pinned, saved and edited marks before the time. */
@Composable
private fun MetaMarks(b: BubbleModel, tint: Color) {
    val m = b.m
    if (m.pinned) {
        Icon(Icons.Outlined.PushPin, "Pinned", tint = tint, modifier = Modifier.size(11.dp))
        Spacer(Modifier.width(3.dp))
    }
    if (b.saved) {
        Icon(Icons.Outlined.BookmarkBorder, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.later_saved_toast), tint = tint, modifier = Modifier.size(12.dp))
        Spacer(Modifier.width(3.dp))
    }
    if (m.editedAt != null && !m.deleted) Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_edited) + " · ", style = Griip.type.caption, color = tint)
}

/**
 * What the message says: the forwarded mark, the quoted message, its content (files, a card, a poll, a sticker, text),
 * link previews and a translation. [tinted] draws it for an outgoing bubble (its own text colours).
 */
@Composable
private fun MessageBody(b: BubbleModel, me: String?, tinted: Boolean, transfer: Float?, localFile: (AttachmentRef) -> File?, voice: VoicePlayer.State, cb: MessageCallbacks) {
    if (!b.m.forwarded || b.m.deleted) {
        MessageContent(b, me, tinted, transfer, localFile, voice, cb)
        return
    }
    // 2026-10-23 (the reference's forwards): "↪ Forwarded", the message inside a quote bar, then where it came from.
    val c = Griip.colors
    val sub = if (tinted) c.bubbleOutgoingMeta else c.textSecondary
    val origin = b.rich?.origin
    Row(Modifier.height(IntrinsicSize.Min)) {
        Box(Modifier.width(3.dp).fillMaxHeight().clip(Shapes.pill).background(c.border))
        Column(Modifier.padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 3.dp)) {
                Icon(Icons.AutoMirrored.Rounded.Redo, null, tint = sub, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_forwarded), style = Griip.type.caption.copy(fontStyle = FontStyle.Italic), color = sub)
            }
            MessageContent(b, me, tinted, transfer, localFile, voice, cb)
            origin?.place?.let { place ->
                val link = if (origin.conversationId != null && origin.messageId != null) com.meldiq.android.data.model.MessageLinks.link(origin.conversationId, origin.messageId) else null
                val time = origin.at?.let { " • " + TimeFmt.listStamp(it).let { s -> if (TimeFmt.sameDay(it, System.currentTimeMillis())) s else s + " " + TimeFmt.clock(it) } }.orEmpty()
                Text(
                    place + time + if (link != null) "  ›" else "",
                    style = Griip.type.caption, color = sub, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 4.dp).then(if (link != null) Modifier.pressable({ cb.onOpenLink(link) }, onClickLabel = "Open original message") else Modifier),
                )
            }
        }
    }
}

@Composable
private fun MessageContent(b: BubbleModel, me: String?, tinted: Boolean, transfer: Float?, localFile: (AttachmentRef) -> File?, voice: VoicePlayer.State, cb: MessageCallbacks) {
    val c = Griip.colors
    val m = b.m
    val fg = if (tinted) c.onBubbleOutgoing else c.textPrimary
    val sub = if (tinted) c.bubbleOutgoingMeta else c.textSecondary
    if (b.reply != null) {
        Row(
            Modifier.padding(bottom = 6.dp).height(IntrinsicSize.Min).clip(Shapes.small)
                .background(if (tinted) c.primary.copy(alpha = 0.10f) else c.surfaceVariant)
                .pressable({ cb.onReplyClick(b.reply.id) }, onClickLabel = "Go to quoted message"),
        ) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(c.primary))
            Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text(b.replySender ?: "", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primaryDeep, maxLines = 1)
                Text(if (b.reply.deleted) "Deleted message" else b.reply.text.ifEmpty { b.replyPreview ?: "📎 Attachment" }, style = Griip.type.caption, color = sub, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    when {
        m.kind == "undecryptable" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.GppMaybe, null, tint = c.danger, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(m.text, style = Griip.type.bodySmall, color = c.danger)
        }
        m.deleted -> Text("This message was deleted", style = Griip.type.bodySmall.copy(fontStyle = FontStyle.Italic), color = c.textSecondary)
        else -> {
            // Two or more photos and videos: an album grid; other files and voice notes stay rows below it.
            val visuals = b.attachments.filter { MediaGallery.visualKind(it) != null }
            val album = visuals.size >= 2
            if (album) {
                AlbumGrid(visuals, transfer, localFile, cb.onOpenAttachment)
                if (transfer != null && m.status == MessageStatus.SENDING) {
                    Text("Sending ${visuals.size} · ${(transfer * 100).toInt()}%", style = Griip.type.caption, color = sub, modifier = Modifier.padding(top = 4.dp))
                }
                Spacer(Modifier.height(6.dp))
            }
            b.attachments.filter { !album || it !in visuals }.forEach { a ->
                if (VoiceNote.isVoice(a)) {
                    VoiceMessageView(a, tinted, transfer, voice.takeIf { it.key == m.id }, { cb.onVoiceToggle(a) }, { cb.onVoiceSeek(a, it) })
                } else AttachmentView(a, tinted, transfer, localFile(a), cb.onOpenAttachment)
                if (m.text.isNotEmpty()) Spacer(Modifier.height(6.dp))
            }
            val rich = b.rich
            when {
                rich?.contact != null -> ContactCardView(rich.contact, tinted, cb.onCopyText, cb.onFindPhone, onOpenProfile = cb.onMentionClick)
                rich?.location != null -> LocationCardView(rich.location, tinted)
                rich?.poll != null -> PollCard(rich, me, b.canVote, cb.onVote)
                rich?.sticker != null -> StickerView(com.meldiq.android.data.model.StickerCatalog.find(rich.sticker), m.text, animate = b.animateEmoji)
                rich?.customSticker != null -> com.meldiq.android.ui.components.CustomStickerView(rich.customSticker, m.text)
                rich?.animoji != null -> AnimojiView(rich.animoji, b.animateEmoji, size = 110)
                m.text.isNotEmpty() -> {
                    val body = Griip.type.body
                    // Batch B9: a community's own emoji drawn inside the text (their `:name:` while loading or if they can't be shown).
                    val emoji = rich?.customEmoji.orEmpty()
                    Text(
                        richText(m.text, tinted, b.mentions, me, cb.onMentionClick, cb.onOpenLink, emoji),
                        style = body.copy(fontSize = body.fontSize * b.textScale, lineHeight = body.lineHeight * b.textScale), color = fg,
                        inlineContent = com.meldiq.android.ui.components.customEmojiInline(emoji),
                    )
                }
            }
            val mediaLink = if (b.mediaCards && rich?.structured != true) com.meldiq.android.data.model.MediaLinks.find(m.text) else null
            if (mediaLink != null) MediaLinkCard(mediaLink, rich?.link?.takeIf { it.url == mediaLink.url }, cb.onOpenLink, onPlay = mediaLink.videoId?.let { id -> cb.onPlayVideo?.let { play -> { play(id) } } })
            else rich?.link?.let { LinkPreviewCard(it, tinted, cb.onOpenLink) }
            if (cb.linkDetails != null) (rich?.link?.url ?: com.meldiq.android.data.model.LinkRules.find(m.text).firstOrNull()?.url)?.let { cb.linkDetails.invoke(it) }
            b.translation?.let { t ->
                Column(Modifier.padding(top = 6.dp)) {
                    androidx.compose.material3.HorizontalDivider(thickness = 1.dp, color = if (tinted) c.primary.copy(alpha = 0.2f) else c.border)
                    Text(
                        androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.translate_label), style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold),
                        color = c.primaryDeep, modifier = Modifier.padding(top = 4.dp),
                    )
                    when {
                        t.working -> Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.translate_working), style = Griip.type.bodySmall, color = sub)
                        t.error != null -> Text(t.error, style = Griip.type.bodySmall, color = c.danger)
                        t.text != null -> Text(t.text, style = Griip.type.body.copy(fontSize = Griip.type.body.fontSize * b.textScale), color = fg)
                    }
                }
            }
        }
    }
}

/** Below the message: why it's paused or failed, its reactions, and its thread. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageExtras(b: BubbleModel, me: String?, alignEnd: Boolean, cb: MessageCallbacks) {
    val c = Griip.colors
    val m = b.m
    if (m.status == MessageStatus.HELD) {
        Text(m.errorText ?: "Paused: a security key changed", style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 3.dp, end = 4.dp))
    }
    if (m.status == MessageStatus.FAILED) {
        Text(
            // A small corner radius, not a pill: a pill's half-height corners clipped the first and last letters of a
            // reason that wraps onto several lines (UI-003, the owner's screenshot).
            (m.errorText ?: "Not sent") + " · Tap to retry", style = Griip.type.caption, color = c.danger,
            modifier = Modifier.padding(top = 3.dp, end = 4.dp).clip(Shapes.small).pressable(cb.onRetry).padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
    if (b.reactions.isNotEmpty()) {
        // Batch B16: a reaction added or taken away grows or shrinks the row smoothly (still when animations are off).
        val still = com.meldiq.android.ui.theme.rememberReducedMotion()
        FlowRow(
            Modifier.padding(top = 4.dp).then(if (still) Modifier else Modifier.animateContentSize(com.meldiq.android.ui.theme.Motion.quick())), horizontalArrangement = Arrangement.spacedBy(4.dp, if (alignEnd) Alignment.End else Alignment.Start),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val communityEmoji = com.meldiq.android.ui.components.LocalCommunityEmoji.current
            b.reactions.forEach { (emoji, users) ->
                val mine = me in users
                // Batch B12: a community emoji reaction (`:name:`) shows its image; a removed one shows its name.
                val custom = com.meldiq.android.data.model.ExpressionRules.reactionName(emoji)?.let(communityEmoji::get)
                Row(
                    Modifier.heightIn(min = 30.dp).clip(Shapes.pill).background(if (mine) c.primarySoft else c.surface).border(1.dp, if (mine) c.primary else c.border, Shapes.pill)
                        // A tap adds or takes back yours; a long press shows who reacted (community-first brief §B).
                        .combinedClickable(
                            onClick = { cb.onReact(emoji) },
                            onLongClick = cb.onShowReactions?.let { show -> { show(emoji) } },
                            onLongClickLabel = if (cb.onShowReactions != null) androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_react_dialog_title) else null,
                        )
                        .padding(horizontal = 9.dp, vertical = 3.dp)
                        .semantics { contentDescription = "$emoji reaction, ${users.size}${if (mine) ", including you" else ""}" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (custom != null) com.meldiq.android.ui.components.CustomEmojiImage(custom, 18.dp) else Text(emoji, style = Griip.type.label)
                    Spacer(Modifier.width(4.dp))
                    Text("${users.size}", style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = if (mine) c.primaryDeep else c.textSecondary)
                }
            }
        }
    }
    if (b.threadCount > 0 && cb.onOpenThread != null) {
        val label = if (b.threadCount == 1) androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_reply_one) else androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_replies, b.threadCount)
        Row(
            Modifier.padding(top = 4.dp).heightIn(min = 32.dp).clip(Shapes.small).border(1.dp, c.border, Shapes.small).background(c.surface)
                .pressable(cb.onOpenThread, onClickLabel = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_view_thread))
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Forum, null, tint = c.primary, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(label, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
            Text(" · " + androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_view_thread), style = Griip.type.label, color = c.textSecondary)
        }
    }
}

@Composable
private fun StatusIcon(status: String, tint: Color) {
    val c = Griip.colors
    when (status) {
        MessageStatus.SENDING -> Icon(Icons.Outlined.Schedule, "Sending", tint = tint, modifier = Modifier.size(13.dp))
        MessageStatus.SENT -> Icon(Icons.Rounded.Done, "Sent", tint = tint, modifier = Modifier.size(14.dp))
        MessageStatus.DELIVERED -> Icon(Icons.Rounded.DoneAll, "Delivered", tint = tint, modifier = Modifier.size(15.dp))
        MessageStatus.READ -> Icon(Icons.Rounded.DoneAll, "Read", tint = c.readReceipt, modifier = Modifier.size(15.dp))
        MessageStatus.FAILED -> Icon(Icons.Outlined.ErrorOutline, "Failed", tint = c.danger, modifier = Modifier.size(14.dp))
        MessageStatus.HELD -> Icon(Icons.Outlined.Schedule, "Paused", tint = c.warning, modifier = Modifier.size(13.dp))
    }
}

/**
 * Message text with its mentions drawn: only spans that resolve to the message's mentioned ids (a stray "@word" stays
 * plain). A mention of you is highlighted; tapping a person's mention opens their profile.
 */
@Composable
private fun richText(
    text: String, out: Boolean, spans: List<MentionSpan>, me: String?, onMentionClick: (String) -> Unit, onOpenLink: (String) -> Unit,
    emoji: List<com.meldiq.android.data.model.CustomEmojiRef> = emptyList(),
): AnnotatedString {
    val c = Griip.colors
    // Web links (http/https only, docs/LINKS.md) are tappable; the text itself is shown exactly as sent.
    val links = com.meldiq.android.data.model.LinkRules.find(text)
    val tokens = com.meldiq.android.data.model.ExpressionRules.tokens(text, emoji)
    if (spans.isEmpty() && links.isEmpty() && tokens.isEmpty()) return AnnotatedString(text)
    val base = SpanStyle(fontWeight = FontWeight.SemiBold, color = if (out) c.onBubbleOutgoing else c.primaryDeep)
    val mine = base.copy(background = c.primary.copy(alpha = if (out) 0.18f else 0.16f))
    val linkStyle = SpanStyle(color = if (out) c.onBubbleOutgoing else c.primaryDeep, textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline)
    data class Piece(val start: Int, val end: Int, val mention: MentionSpan?, val url: String?, val emoji: com.meldiq.android.data.model.CustomEmojiRef? = null)
    val pieces = (spans.map { Piece(it.start, it.end, it, null) } + links.map { Piece(it.start, it.end, null, it.url) } + tokens.map { Piece(it.start, it.end, null, null, it.ref) })
        .sortedBy { it.start }
    return buildAnnotatedString {
        var last = 0
        for (p in pieces) {
            if (p.start < last || p.end > text.length) continue // overlapping: the earlier one wins
            append(text.substring(last, p.start))
            val sp = p.mention
            val url = p.url
            when {
                p.emoji != null -> appendInlineContent(com.meldiq.android.ui.components.customEmojiKey(p.emoji), text.substring(p.start, p.end))
                url != null -> withLink(LinkAnnotation.Clickable("url:$url", TextLinkStyles(linkStyle)) { onOpenLink(url) }) { append(text.substring(p.start, p.end)) }
                sp?.userId != null -> {
                    val id = sp.userId
                    val style = if (id == me) mine else base
                    withLink(LinkAnnotation.Clickable("mention:$id", TextLinkStyles(style)) { onMentionClick(id) }) { append(text.substring(p.start, p.end)) }
                }
                else -> withStyle(mine) { append(text.substring(p.start, p.end)) }
            }
            last = p.end
        }
        append(text.substring(last))
    }
}

private fun senderColor(i: Int): Color = com.meldiq.android.ui.theme.AvatarGradients[((i % 8) + 8) % 8].second

@Composable
private fun AttachmentView(a: AttachmentRef, out: Boolean, transfer: Float?, local: File?, onOpen: (AttachmentRef) -> Unit) {
    val c = Griip.colors
    val kind = MediaGallery.kindOf(a)
    // Thumbnails: photos decoded at bubble size with their EXIF rotation, videos as their first frame.
    val bitmap by produceState<ImageBitmap?>(null, local?.path) {
        value = when {
            local == null -> null
            kind == MediaKind.Image -> MediaExport.decode(local, 1080)?.asImageBitmap()
            kind == MediaKind.Video -> MediaExport.videoFrame(local, 720)?.asImageBitmap()
            else -> null
        }
    }
    val bmp = bitmap
    // Batch B16: the sender's size for this photo or video, when it sent one: its space is kept before the picture is
    // downloaded or decoded, so nothing jumps when it appears.
    val reserved = if (kind != null && com.meldiq.android.media.MediaDims.valid(a.w, a.h)) MediaGallery.previewRatio(a.w!!, a.h!!) else null
    if (bmp == null && reserved != null) {
        Box(
            Modifier.width(MEDIA_PREVIEW_WIDTH).aspectRatio(reserved).clip(Shapes.tile).background(if (out) c.primary.copy(alpha = 0.10f) else c.surfaceVariant)
                .pressable(if (a.id != "pending") ({ onOpen(a) }) else null, onClickLabel = if (kind == MediaKind.Video) "Play video" else "View photo"),
            contentAlignment = Alignment.Center,
        ) {
            if (transfer != null) CircularProgressIndicator(progress = { transfer }, modifier = Modifier.size(36.dp), color = c.primary, strokeWidth = 3.dp)
            else Icon(
                if (local == null && a.id != "pending") Icons.Rounded.Download else if (kind == MediaKind.Video) Icons.Rounded.Videocam else Icons.Rounded.Image,
                if (local == null && a.id != "pending") "Download" else null, tint = c.textSecondary, modifier = Modifier.size(28.dp),
            )
            Text(humanSize(a.size), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp))
        }
        return
    }
    if (bmp != null) {
        // Batch B14: one width for every photo and video, its own shape within 3:4 and 16:9 (MediaGallery.previewRatio).
        Box(
            Modifier.width(MEDIA_PREVIEW_WIDTH).aspectRatio(reserved ?: MediaGallery.previewRatio(bmp.width, bmp.height)).clip(Shapes.tile)
                .pressable({ onOpen(a) }, onClickLabel = if (kind == MediaKind.Video) "Play video" else "View photo"),
        ) {
            Image(bmp, a.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            if (kind == MediaKind.Video) {
                Box(Modifier.align(Alignment.Center).size(52.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(32.dp))
                }
            }
        }
        return
    }
    val label = when (kind) {
        MediaKind.Image -> "Photo"
        MediaKind.Video -> "Video"
        null -> null
    }
    Row(
        Modifier.widthIn(min = 200.dp, max = 270.dp).clip(Shapes.small).background(if (out) c.primary.copy(alpha = 0.10f) else c.surfaceVariant)
            .pressable(if (a.id != "pending") ({ onOpen(a) }) else null, onClickLabel = if (kind != null) "Open ${label!!.lowercase()}" else "Open file").padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(Shapes.small).background(c.surface), contentAlignment = Alignment.Center) {
            if (transfer != null) CircularProgressIndicator(progress = { transfer }, modifier = Modifier.size(26.dp), color = c.primary, strokeWidth = 3.dp)
            else Icon(
                when {
                    local == null && a.id != "pending" -> Icons.Rounded.Download
                    kind == MediaKind.Video -> Icons.Rounded.Videocam
                    kind == MediaKind.Image -> Icons.Rounded.Image
                    else -> Icons.AutoMirrored.Rounded.InsertDriveFile
                },
                if (local == null && a.id != "pending") "Download" else null, tint = c.primary,
            )
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(label ?: a.name, style = Griip.type.bodyMedium, color = if (out) c.onBubbleOutgoing else c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                humanSize(a.size) + if (transfer != null) " · ${(transfer * 100).toInt()}%" else if (kind != null && local == null) " · tap to view" else "",
                style = Griip.type.caption, color = if (out) c.bubbleOutgoingMeta else c.textSecondary,
            )
        }
    }
}

private val MEDIA_PREVIEW_WIDTH = 240.dp

fun humanSize(b: Long): String = when {
    b >= 1_048_576 -> "%.1f MB".format(b / 1_048_576.0)
    b >= 1024 -> "${b / 1024} KB"
    else -> "$b B"
}

/** A call history line (docs/CALL_HISTORY.md): outcome, duration when recorded, and for groups who started it. */
@Composable
private fun CallChip(m: MessageEntity, out: Boolean, starterUser: com.meldiq.android.data.db.UserEntity?) {
    val c = Griip.colors
    val starter = starterUser?.displayName
    val info = remember(m.callJson) { com.meldiq.android.data.db.MessageColumns.call(m) }
    val video = info?.video ?: m.text.startsWith("Video")
    val line = info?.let { CallHistory.line(it, out, starter) } ?: CallHistory.Line("${if (out) "Outgoing" else "Incoming"} ${m.text.lowercase()}", null, false)
    val tint = if (line.missed) c.danger else c.primary
    val detail = listOfNotNull(line.detail, TimeFmt.dayHeader(m.sortTs) + ", " + TimeFmt.clock(m.sortTs)).joinToString(" — ")
    // 2026-10-23 (the reference's call cards): a card in the timeline with the call's outcome, how long and when, and who
    // started it; missed calls in red.
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp).clip(Shapes.card).background(c.surfaceVariant)
            .padding(horizontal = 14.dp, vertical = 12.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            when { line.missed -> Icons.Rounded.CallEnd; video -> Icons.Rounded.Videocam; else -> Icons.Rounded.Call },
            null, tint = tint, modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(line.title, style = Griip.type.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        starterUser?.let { u ->
            Spacer(Modifier.width(10.dp))
            com.meldiq.android.ui.components.UserAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, size = 30.dp)
        }
    }
}

/** A link preview the sender's phone made (recipients never fetch the page themselves). */
@Composable
fun LinkPreviewCard(p: com.meldiq.android.data.model.LinkPreview, out: Boolean, onOpen: (String) -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.padding(top = 6.dp).widthIn(max = 280.dp).height(IntrinsicSize.Min).clip(Shapes.small)
            .background(if (out) c.primary.copy(alpha = 0.10f) else c.surfaceVariant).pressable({ onOpen(p.url) }, onClickLabel = "Open link"),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(c.primary))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(p.siteName ?: com.meldiq.android.data.model.LinkRules.domain(p.url) ?: "", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primaryDeep, maxLines = 1)
            p.title?.let { Text(it, style = Griip.type.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = if (out) c.onBubbleOutgoing else c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            p.description?.let { Text(it, style = Griip.type.caption, color = if (out) c.bubbleOutgoingMeta else c.textSecondary, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
    }
}
