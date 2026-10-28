package com.meldiq.android.ui.screens.conversation

import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.model.ContactCard
import com.meldiq.android.data.model.RichRules
import com.meldiq.android.data.model.SharedLocation
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.screens.chats.ConversationAvatar
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

// ───────────────────────────── Contact cards ─────────────────────────────

// Round 7: new cards are Meldiq profile cards (ProfileCards.kt). The address-book picker that sent phone numbers is
// gone; cards with numbers received from older apps still show below.

@Composable
fun ContactCardView(card: ContactCard, out: Boolean, onCopy: (String) -> Unit, onFindOnMeldiq: ((String) -> Unit)?, onOpenProfile: (String) -> Unit = {}) {
    card.userId?.let { id ->
        ProfileCardView(card, id, out, onOpenProfile)
        return
    }
    val c = Griip.colors
    val ctx = LocalContext.current
    Column(Modifier.widthIn(min = 220.dp, max = 270.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(if (out) c.primary.copy(alpha = 0.15f) else c.primarySoft), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Person, null, tint = c.primaryDeep)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(card.name, style = Griip.type.titleSmall, color = if (out) c.onBubbleOutgoing else c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                card.phones.forEach { Text(it, style = Griip.type.bodySmall, color = if (out) c.bubbleOutgoingMeta else c.textSecondary) }
                card.emails.forEach { Text(it, style = Griip.type.bodySmall, color = if (out) c.bubbleOutgoingMeta else c.textSecondary) }
            }
        }
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PillButton("Add to contacts", {
                val i = Intent(ContactsContract.Intents.Insert.ACTION).setType(ContactsContract.RawContacts.CONTENT_TYPE)
                    .putExtra(ContactsContract.Intents.Insert.NAME, card.name)
                card.phones.firstOrNull()?.let { i.putExtra(ContactsContract.Intents.Insert.PHONE, it) }
                card.emails.firstOrNull()?.let { i.putExtra(ContactsContract.Intents.Insert.EMAIL, it) }
                runCatching { ctx.startActivity(i) }
            }, tone = ButtonTone.Glass, height = 34.dp, leadingIcon = Icons.Outlined.PersonAdd)
            card.phones.firstOrNull()?.let { ph ->
                PillButton("Copy", { onCopy(ph) }, tone = ButtonTone.Glass, height = 34.dp, leadingIcon = Icons.Outlined.ContentCopy)
                if (onFindOnMeldiq != null && ph.startsWith("+")) PillButton("Find on Meldiq", { onFindOnMeldiq(ph) }, tone = ButtonTone.Glass, height = 34.dp)
            }
        }
    }
}

// ───────────────────────────── Locations ─────────────────────────────

/** Confirmation before sharing a location once: what will be sent, an optional place name, Send or Cancel. */
@Composable
fun LocationShareSheet(loc: SharedLocation?, locating: Boolean, problem: String?, onRetry: () -> Unit, onSend: (SharedLocation) -> Unit, onDismiss: () -> Unit) {
    val c = Griip.colors
    var label by rememberSaveable { mutableStateOf("") }
    GlassSheet(onDismiss, title = "Share location") {
        LocationPreview(loc)
        Spacer(Modifier.height(10.dp))
        when {
            locating -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.primary)
                Spacer(Modifier.width(8.dp))
                Text("Finding your location…", style = Griip.type.bodySmall, color = c.textSecondary)
            }
            problem != null -> Text(problem, style = Griip.type.bodySmall, color = c.danger)
            loc != null -> Text(RichRules.describe(loc), style = Griip.type.bodySmall, color = c.textSecondary)
        }
        Spacer(Modifier.height(8.dp))
        GriipTextField(label, { label = it.take(RichRules.MAX_LABEL) }, "Place name (optional)", placeholder = "Office, home, café…")
        Text(
            "Sent once and kept with the message. Meldiq doesn't track your location or share it again. No map service is contacted to show this.",
            style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(vertical = 8.dp),
        )
        if (problem != null && !locating) PillButton("Try again", onRetry, Modifier.fillMaxWidth(), tone = ButtonTone.Glass)
        PillButton(
            "Send location", { loc?.let { onSend(it.copy(label = label.trim().ifEmpty { null })) } }, Modifier.fillMaxWidth().padding(top = 6.dp),
            enabled = loc != null && !locating,
        )
        Spacer(Modifier.height(16.dp))
    }
}

/** A drawn map pin (no map tiles are downloaded, so viewing a location never tells a map service where it is). */
@Composable
private fun LocationPreview(loc: SharedLocation?, height: Int = 120) {
    val c = Griip.colors
    Box(
        Modifier.fillMaxWidth().height(height.dp).clip(Shapes.tile).background(c.primarySoft),
        contentAlignment = Alignment.Center,
    ) {
        // Grid lines suggest a map without pretending to be one.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.SpaceEvenly) {
            repeat(4) { Box(Modifier.fillMaxWidth().height(1.dp).background(c.primary.copy(alpha = 0.12f))) }
        }
        Icon(Icons.Outlined.LocationOn, null, tint = if (loc != null) c.primaryDeep else c.textTertiary, modifier = Modifier.size(40.dp))
    }
}

@Composable
fun LocationCardView(loc: SharedLocation, out: Boolean) {
    val c = Griip.colors
    val ctx = LocalContext.current
    Column(Modifier.widthIn(min = 220.dp, max = 270.dp)) {
        LocationPreview(loc, height = 100)
        Spacer(Modifier.height(6.dp))
        loc.label?.let { Text(it, style = Griip.type.titleSmall, color = if (out) c.onBubbleOutgoing else c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        Text(RichRules.describe(loc), style = Griip.type.caption, color = if (out) c.bubbleOutgoingMeta else c.textSecondary)
        Spacer(Modifier.height(6.dp))
        PillButton("Open in maps", {
            val geo = Intent(Intent.ACTION_VIEW, Uri.parse(RichRules.geoUri(loc)))
            runCatching { ctx.startActivity(Intent.createChooser(geo, "Open with")) }
        }, tone = ButtonTone.Glass, height = 34.dp, leadingIcon = Icons.Outlined.Map)
    }
}

// ───────────────────────────── Animated emoji ─────────────────────────────

/** Emoji with a matching motion; any other single emoji is shown large and still. */
object Animoji {
    enum class Motion { Beat, Bounce, Wave, Spin, Wobble }

    val SET: List<Pair<String, Motion>> = listOf(
        "❤️" to Motion.Beat, "😂" to Motion.Wobble, "👍" to Motion.Bounce, "🎉" to Motion.Wobble, "🔥" to Motion.Beat,
        "👋" to Motion.Wave, "😮" to Motion.Bounce, "😢" to Motion.Wobble, "🙏" to Motion.Beat, "🥳" to Motion.Bounce,
        "😍" to Motion.Beat, "🤣" to Motion.Wobble, "👏" to Motion.Wave, "🚀" to Motion.Bounce, "⭐" to Motion.Spin,
        "🌸" to Motion.Spin, "☕" to Motion.Wobble, "🎂" to Motion.Bounce, "💯" to Motion.Beat, "😎" to Motion.Bounce,
    )

    fun motionOf(e: String): Motion? = SET.firstOrNull { it.first == e }?.second
}

/**
 * An animated emoji: drawn by the app with a short motion (no downloaded or executable content). With [animate] off
 * (the "Animated emoji" setting, or the system's remove-animations setting) it's shown still.
 */
@Composable
fun AnimojiView(emoji: String, animate: Boolean, size: Int = 96) {
    val motion = Animoji.motionOf(emoji)
    val t = rememberInfiniteTransition(label = "animoji")
    val p by if (animate && motion != null) t.animateFloat(
        0f, 1f, infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart), label = "p",
    ) else remember { mutableStateOf(0f) }
    val beat = when (motion) {
        Animoji.Motion.Beat -> 1f + 0.12f * kotlin.math.sin(p * 2 * Math.PI.toFloat() * 2).coerceAtLeast(0f)
        Animoji.Motion.Bounce -> 1f + 0.08f * kotlin.math.abs(kotlin.math.sin(p * Math.PI.toFloat() * 2))
        else -> 1f
    }
    val angle = when (motion) {
        Animoji.Motion.Wave -> 18f * kotlin.math.sin(p * 2 * Math.PI.toFloat() * 2)
        Animoji.Motion.Wobble -> 8f * kotlin.math.sin(p * 2 * Math.PI.toFloat() * 3)
        Animoji.Motion.Spin -> 360f * p
        else -> 0f
    }
    Box(Modifier.size(size.dp).semantics { contentDescription = "Animated emoji $emoji" }, contentAlignment = Alignment.Center) {
        Text(emoji, fontSize = (size * 0.62f).sp, modifier = Modifier.scale(beat).rotate(angle))
    }
}

/**
 * Stickers and animated emoji to send on their own, and emoji to type into the message (2026-10-19: Stickers added,
 * docs/STICKERS.md; 2026-10-21: the full Unicode picker, [EmojiPanel], docs/EMOJI.md). Opens on Stickers.
 */
@Composable
fun EmojiPickerSheet(
    animationsOn: Boolean,
    onInsert: (String) -> Unit,
    onSendAnimated: (String) -> Unit,
    onDismiss: () -> Unit,
    stickers: com.meldiq.android.data.repo.StickerPrefs? = null,
    onSendSticker: (com.meldiq.android.data.model.Sticker) -> Unit = {},
    emoji: com.meldiq.android.data.repo.EmojiPrefs,
    /** Batch B9: the community's own emoji (tap inserts `:name:`) and stickers (tap sends). */
    community: List<com.meldiq.android.data.api.ExpressionDto> = emptyList(),
    onSendCommunitySticker: (com.meldiq.android.data.api.ExpressionDto) -> Unit = {},
) {
    val c = Griip.colors
    val hasStickers = stickers != null && com.meldiq.android.data.model.StickerCatalog.packs.isNotEmpty()
    var tab by rememberSaveable { mutableStateOf(if (hasStickers) 0 else 1) }
    GlassSheet(onDismiss, title = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.emoji_tab)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (hasStickers) com.meldiq.android.ui.components.PillChip(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.stickers_tab), tab == 0, { tab = 0 })
            com.meldiq.android.ui.components.PillChip(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.animated_tab), tab == 1, { tab = 1 })
            com.meldiq.android.ui.components.PillChip(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.emoji_tab), tab == 2, { tab = 2 })
            if (community.isNotEmpty()) com.meldiq.android.ui.components.PillChip(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b9_community_tab), tab == 3, { tab = 3 })
        }
        Spacer(Modifier.height(10.dp))
        // The full picker scrolls by itself (a lazy grid), so it isn't put in the scrolling column below.
        if (tab == 2) EmojiPanel(emoji, onInsert, Modifier.fillMaxWidth().height(440.dp))
        else Column(Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(androidx.compose.foundation.rememberScrollState())) {
        when {
            tab == 0 && stickers != null -> {
                val recent by stickers.recent.collectAsState()
                val favourites by stickers.favourites.collectAsState()
                StickerPicker(recent, favourites, onSend = { s -> stickers.used(s.ref); onSendSticker(s) }, onToggleFavourite = { s -> stickers.toggleFavourite(s.ref) })
            }
            tab == 1 -> {
                Text(
                    if (animationsOn) "Tap to send. They move in the chat; turn that off under Settings › Chats."
                    else "Animations are off (Settings › Chats): they're sent animated but shown still here.",
                    style = Griip.type.caption, color = c.textSecondary,
                )
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Animoji.SET.forEach { (e, _) ->
                        Box(Modifier.size(60.dp).clip(Shapes.tile).background(c.surfaceVariant).pressable({ onSendAnimated(e) }, onClickLabel = "Send animated $e"), contentAlignment = Alignment.Center) {
                            AnimojiView(e, animate = false, size = 52)
                        }
                    }
                }
            }
            tab == 3 -> CommunityExpressionsPicker(community, onInsert = { e -> onInsert(":${e.name}:") }, onSendSticker = onSendCommunitySticker)
            else -> Unit
        }
        }
        Spacer(Modifier.height(16.dp))
    }
}

// ───────────────────────────── Forwarding ─────────────────────────────

/** Choose where to forward: several chats, a preview, an optional note (2026-10-23). */
@Composable
fun ForwardSheet(
    conversations: List<ConversationEntity>,
    me: String?,
    preview: String,
    filesNote: String?,
    onSend: (List<ConversationEntity>, String) -> Unit,
    onCopyLink: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    // 2026-10-23 (the reference's Forward To): tick up to MAX_FORWARD chats, see what's going, add a note, Send.
    val c = Griip.colors
    var q by rememberSaveable { mutableStateOf("") }
    var picked by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var note by rememberSaveable { mutableStateOf("") }
    GlassSheet(onDismiss, title = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.ux_forward_to)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SearchPill(q, { q = it }, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.ux_search_chats), Modifier.weight(1f))
            onCopyLink?.let {
                com.meldiq.android.ui.components.CircleIconButton(
                    androidx.compose.material.icons.Icons.Outlined.ContentCopy, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b5_copy_link), it, tint = c.textSecondary,
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        val shown = conversations.filter { !it.removed && it.canPost && (q.isBlank() || ConversationRepository.title(it, me).contains(q, ignoreCase = true)) }
        if (shown.isEmpty()) Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.ux_no_chats_to_forward), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(12.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 340.dp)) {
            items(shown, key = { it.id }) { conv ->
                val title = ConversationRepository.title(conv, me).let { if (conv.type == "CHANNEL") "#$it" else it }
                val on = conv.id in picked
                val canAdd = on || picked.size < MAX_FORWARD
                Row(
                    Modifier.fillMaxWidth().clip(Shapes.small)
                        .pressable(if (canAdd) ({ picked = if (on) picked - conv.id else picked + conv.id }) else null, role = androidx.compose.ui.semantics.Role.Checkbox)
                        .padding(horizontal = 6.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ConversationAvatar(conv, me, size = 40.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(title, style = Griip.type.bodyMedium, color = if (canAdd) c.textPrimary else c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    androidx.compose.material3.Checkbox(on, onCheckedChange = null, enabled = canAdd)
                }
            }
        }
        // What is being forwarded, quoted, so the person knows before sending.
        Row(Modifier.fillMaxWidth().padding(top = 8.dp).clip(Shapes.small).background(c.surfaceVariant).height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(c.warning))
            Text(preview, style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
        }
        filesNote?.let { Text(it, style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 4.dp)) }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            GriipTextField(note, { note = it.take(2000) }, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.ux_forward_note), Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            PillButton(
                androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.ux_send),
                { onSend(conversations.filter { it.id in picked }, note) }, enabled = picked.isNotEmpty(), height = 48.dp, showKnob = false,
            )
        }
        Spacer(Modifier.height(12.dp))
    }
}

/** The most chats one forward goes to at once. */
const val MAX_FORWARD = 5


/** Batch B9: the community's own emoji (tap to insert) and stickers (tap to send), each with its `:name:`. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun CommunityExpressionsPicker(
    all: List<com.meldiq.android.data.api.ExpressionDto>,
    onInsert: (com.meldiq.android.data.api.ExpressionDto) -> Unit,
    onSendSticker: (com.meldiq.android.data.api.ExpressionDto) -> Unit,
) {
    val c = Griip.colors
    val container = com.meldiq.android.ui.LocalContainer.current
    val emoji = all.filter { it.kind == "emoji" }
    val stickers = all.filter { it.kind == "sticker" }
    if (emoji.isNotEmpty()) {
        Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b9_emoji), style = Griip.type.label, color = c.textSecondary)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            emoji.forEach { e ->
                Box(Modifier.size(52.dp).clip(Shapes.tile).background(c.surfaceVariant).pressable({ onInsert(e) }, onClickLabel = ":${e.name}:"), contentAlignment = Alignment.Center) {
                    com.meldiq.android.ui.components.CustomEmojiImage(container.expressions.ref(e), 32.dp)
                }
            }
        }
    }
    if (stickers.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.stickers_tab), style = Griip.type.label, color = c.textSecondary)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            stickers.forEach { s ->
                Box(Modifier.size(92.dp).clip(Shapes.tile).background(c.surfaceVariant).pressable({ onSendSticker(s) }, onClickLabel = ":${s.name}:"), contentAlignment = Alignment.Center) {
                    com.meldiq.android.ui.components.CustomEmojiImage(container.expressions.ref(s), 80.dp)
                }
            }
        }
    }
}
