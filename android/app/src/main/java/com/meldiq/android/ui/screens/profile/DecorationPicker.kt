package com.meldiq.android.ui.screens.profile

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Brush
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.model.DecorationCatalogDto
import com.meldiq.android.data.model.DecorationRules
import com.meldiq.android.data.model.DecorationSubmissionDto
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.data.model.MyDecorationsDto
import com.meldiq.android.data.model.PersonLook
import com.meldiq.android.data.model.ProfileStyleDto
import com.meldiq.android.media.MediaPrep
import com.meldiq.android.ui.LinkOpener
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.DecorationImage
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.LookAvatar
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class DecoTab { Meldiq, Community, Yours }

/**
 * Settings › Profile style › Avatar decoration (API 0.60.0, server docs/PROFILE_DECORATIONS.md, as Meldiq Web's
 * picker): Meldiq's own (the classic frames and the newer images), community ones with their maker's name, and your own
 * submissions with how their review went. Each tile shows the decoration on your own avatar; picking one saves it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DecorationSection(me: UserDto, current: String?, busy: Boolean, classicLabel: (String) -> String, onPick: (String?) -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(DecoTab.Meldiq) }
    var version by remember { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    var making by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<DecorationSubmissionDto?>(null) }
    val catalog by produceState<Result<DecorationCatalogDto>?>(null, version) { value = runCatching { container.profiles.decorationCatalog() } }
    val mine by produceState<MyDecorationsDto?>(null, version) { value = runCatching { container.profiles.myDecorations() }.getOrNull() }
    val all = catalog?.getOrNull()?.decorations.orEmpty()

    @Composable
    fun tile(id: String?, label: String, by: String? = null) = DecorationTile(me, id, label, by, current == id, busy) { onPick(id) }

    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Text(stringResource(R.string.deco_title), style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
        Spacer(Modifier.height(10.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            listOf(DecoTab.Meldiq to R.string.deco_tab_meldiq, DecoTab.Community to R.string.deco_tab_community, DecoTab.Yours to R.string.deco_tab_yours).forEach { (t, label) ->
                TabChip(stringResource(label), tab == t) { tab = t }
            }
        }
        Spacer(Modifier.height(8.dp))
        PillButton(stringResource(R.string.deco_make), onClick = { making = true }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Brush, height = 40.dp)
        Spacer(Modifier.height(10.dp))
        if (catalog?.isFailure == true) StatusBanner(stringResource(R.string.deco_load_failed), BannerKind.Error)
        error?.let { StatusBanner(it, BannerKind.Error) }
        when (tab) {
            DecoTab.Meldiq -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                tile(null, stringResource(R.string.wp_style_none))
                LookRules.DECORATIONS.forEach { tile(it, classicLabel(it)) }
                all.filter { it.kind == "meldiq" }.forEach { tile(it.id, it.name) }
            }
            DecoTab.Community -> {
                GriipTextField(query, { query = it }, label = stringResource(R.string.deco_search), placeholder = stringResource(R.string.deco_search))
                Spacer(Modifier.height(8.dp))
                val q = query.trim().lowercase()
                val shown = all.filter { it.kind == "community" && (q.isEmpty() || it.name.lowercase().contains(q) || it.creator?.username.orEmpty().lowercase().contains(q)) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    shown.forEach { tile(it.id, it.name, it.creator?.username) }
                }
                if (catalog?.isSuccess == true && shown.isEmpty()) {
                    Text(stringResource(if (q.isEmpty()) R.string.deco_community_empty else R.string.deco_no_match), style = Griip.type.bodySmall, color = c.textSecondary)
                }
            }
            DecoTab.Yours -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                mine?.let { m ->
                    val waiting = stringResource(R.string.deco_waiting, m.pending, m.pendingLimit)
                    Text((if (m.artist) stringResource(R.string.deco_artist_you) + " " else "") + waiting, style = Griip.type.bodySmall, color = c.textSecondary)
                    if (m.submissions.isEmpty()) Text(stringResource(R.string.deco_mine_empty), style = Griip.type.bodySmall, color = c.textSecondary)
                    m.submissions.forEach { s ->
                        SubmissionRow(me, s, current == s.id, busy, onWear = { onPick(s.id) }, onWithdraw = { confirm = s })
                    }
                }
            }
        }
    }

    confirm?.let { s ->
        ConfirmDialog(
            title = s.name,
            text = if (s.status == "approved") stringResource(R.string.deco_withdraw_approved, s.name) else stringResource(R.string.deco_withdraw_confirm, s.name),
            confirmLabel = stringResource(R.string.deco_withdraw),
            destructive = true,
            onConfirm = {
                confirm = null
                scope.launch {
                    runCatching { container.profiles.withdrawDecoration(s.id) }.onSuccess { version++ }.onFailure { error = it.friendly() }
                }
            },
            onDismiss = { confirm = null },
        )
    }
    if (making) {
        MakeDecorationSheet(me, catalog?.getOrNull()?.templateUrl ?: "/v2/decorations/template", onDismiss = { making = false }) {
            making = false
            tab = DecoTab.Yours
            version++
        }
    }
}

@Composable
private fun TabChip(text: String, selected: Boolean, onClick: () -> Unit) {
    val c = Griip.colors
    Text(
        text,
        style = Griip.type.label,
        color = if (selected) c.textPrimary else c.textSecondary,
        modifier = Modifier.clip(Shapes.pill).background(if (selected) c.primarySoft else c.surface).border(1.dp, if (selected) c.primary else c.border, Shapes.pill)
            .selectable(selected, role = Role.Tab, onClick = onClick).padding(horizontal = 14.dp, vertical = 7.dp),
    )
}

/** A decoration on your own avatar, with its name (and maker), to pick. */
@Composable
private fun DecorationTile(me: UserDto, id: String?, label: String, by: String?, selected: Boolean, busy: Boolean, onClick: () -> Unit) {
    val c = Griip.colors
    Column(
        Modifier.width(92.dp).clip(Shapes.small).background(if (selected) c.primarySoft else c.surface).border(1.dp, if (selected) c.primary else c.border, Shapes.small)
            .selectable(selected, enabled = !busy, role = Role.RadioButton, onClick = onClick).padding(top = 14.dp, bottom = 8.dp, start = 4.dp, end = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        LookAvatar(me.id, me.displayName, me.avatarColor, me.photoRev, PersonLook(style = ProfileStyleDto(decoration = id)), size = 46.dp)
        Spacer(Modifier.height(8.dp))
        Text(label, style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = if (selected) c.textPrimary else c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        by?.let { Text(stringResource(R.string.deco_by, it), style = Griip.type.caption, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
private fun SubmissionRow(me: UserDto, s: DecorationSubmissionDto, wearing: Boolean, busy: Boolean, onWear: () -> Unit, onWithdraw: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val approved = s.status == "approved"
    val own by produceState<java.io.File?>(null, s.id, approved) { if (!approved) value = runCatching { container.profiles.ownDecorationImage(s.id) }.getOrNull() }
    Row(Modifier.fillMaxWidth().clip(Shapes.small).border(1.dp, c.border, Shapes.small).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(52.dp), contentAlignment = Alignment.Center) {
            LookAvatar(me.id, me.displayName, me.avatarColor, me.photoRev, PersonLook(style = ProfileStyleDto(decoration = if (approved) s.id else null)), size = 40.dp)
            own?.let { DecorationImage(s.id, 40.dp, it) }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(s.name, style = Griip.type.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val status = when (s.status) {
                "approved" -> R.string.deco_status_approved
                "rejected" -> R.string.deco_status_rejected
                "removed" -> R.string.deco_status_removed
                else -> R.string.deco_status_pending
            }
            Text(stringResource(status), style = Griip.type.caption, color = if (approved) c.success else if (s.status == "pending") c.primary else c.danger)
            s.reason?.let { Text(it, style = Griip.type.caption, color = c.textSecondary) }
            if (approved) Text(if (s.wearers == 1) stringResource(R.string.deco_wearers_one) else stringResource(R.string.deco_wearers_many, s.wearers), style = Griip.type.caption, color = c.textSecondary)
        }
        if (approved) PillButton(stringResource(if (wearing) R.string.deco_wearing else R.string.deco_wear), onClick = onWear, tone = ButtonTone.Glass, enabled = !busy && !wearing, height = 36.dp)
        if (s.status == "pending" || approved) {
            IconButton(onClick = onWithdraw) { Icon(Icons.Outlined.Delete, stringResource(R.string.deco_withdraw), tint = c.textSecondary) }
        }
    }
}

/** Checks a picked picture as the server will (type, size, a square of 128 to 1024 px); the problem, or null. */
private suspend fun problemWith(ctx: android.content.Context, uri: Uri, bytes: ByteArray): Int? = withContext(Dispatchers.IO) {
    val type = ctx.contentResolver.getType(uri).orEmpty()
    if (type !in DecorationRules.TYPES) return@withContext R.string.deco_err_type
    if (bytes.size > DecorationRules.MAX_BYTES) return@withContext R.string.deco_err_size
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
    when {
        o.outWidth <= 0 || o.outHeight <= 0 -> R.string.deco_err_read
        o.outWidth != o.outHeight -> -1
        o.outWidth < DecorationRules.MIN_SIDE || o.outWidth > DecorationRules.MAX_SIDE -> R.string.deco_err_side
        else -> null
    }
}

/**
 * Make your own decoration (as Meldiq Web's dialog): what makes a good one, the template, the picture over your own
 * avatar, a name, and your word that you made it. It's sent in for review.
 */
@Composable
private fun MakeDecorationSheet(me: UserDto, templateUrl: String, onDismiss: () -> Unit, onSent: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var picked by remember { mutableStateOf<Pair<ByteArray, java.io.File>?>(null) }
    var name by remember { mutableStateOf("") }
    var original by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        error = null
        scope.launch {
            val bytes = runCatching { MediaPrep.rawBytes(ctx, uri, DecorationRules.MAX_BYTES) }.getOrElse { error = ctx.getString(R.string.deco_err_size); return@launch }
            when (val problem = problemWith(ctx, uri, bytes)) {
                null -> {
                    val file = withContext(Dispatchers.IO) { java.io.File.createTempFile("decoration", ".img", ctx.cacheDir).apply { writeBytes(bytes); deleteOnExit() } }
                    picked = bytes to file
                }
                -1 -> {
                    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
                    error = ctx.getString(R.string.deco_err_square, o.outWidth, o.outHeight)
                }
                else -> error = ctx.getString(problem)
            }
        }
    }
    val bullets = listOf(R.string.deco_rule_size, R.string.deco_rule_middle, R.string.deco_rule_bottom, R.string.deco_rule_original, R.string.deco_rule_content)
    GlassSheet(onDismiss = onDismiss, title = stringResource(R.string.deco_make_title)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.deco_make_intro), style = Griip.type.bodySmall, color = c.textSecondary)
            bullets.forEach { Text("• " + stringResource(it), style = Griip.type.bodySmall, color = c.textPrimary) }
            Text(
                stringResource(R.string.deco_template),
                style = Griip.type.label,
                color = c.primary,
                modifier = Modifier.clip(Shapes.small).selectable(false, role = Role.Button) { LinkOpener.open(ctx, container.api.serverAddress() + templateUrl, inApp = false) }.padding(vertical = 4.dp),
            )
            StatusBanner(stringResource(R.string.deco_perks), BannerKind.Info)
            Box(Modifier.fillMaxWidth().height(170.dp), contentAlignment = Alignment.Center) {
                PreviewAvatar(me, picked?.second, 120.dp)
            }
            PillButton(stringResource(if (picked == null) R.string.deco_pick else R.string.deco_pick_again), onClick = { pick.launch("image/*") }, tone = ButtonTone.Glass, enabled = !sending, height = 44.dp)
            GriipTextField(name, { if (it.length <= 32) name = it }, label = stringResource(R.string.deco_name), placeholder = stringResource(R.string.deco_name), enabled = !sending)
            Row(Modifier.fillMaxWidth().toggleable(original, enabled = !sending, role = Role.Checkbox) { original = it }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(original, onCheckedChange = null)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.deco_original), style = Griip.type.bodySmall, color = c.textPrimary)
            }
            error?.let { StatusBanner(it, BannerKind.Error) }
            PillButton(
                stringResource(R.string.deco_send),
                onClick = {
                    val image = picked?.first ?: return@PillButton
                    sending = true
                    error = null
                    scope.launch {
                        runCatching { container.profiles.submitDecoration(name, image) }.onSuccess { onSent() }.onFailure { error = it.friendly() }
                        sending = false
                    }
                },
                enabled = picked != null && name.trim().length >= 2 && original && !sending,
                loading = sending,
            )
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun PreviewAvatar(me: UserDto, file: java.io.File?, size: Dp) {
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        LookAvatar(me.id, me.displayName, me.avatarColor, me.photoRev, null, size = size)
        file?.let { DecorationImage("preview-${it.name.hashCode().toUInt()}", size, it) }
    }
}

/**
 * An artist's decorations on their profile (API 0.60.0): each shown on your own avatar, so you try it on just by
 * looking, with a button to wear it. [section] is the profile card's own section frame.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ArtistDecorations(userId: String, name: String, section: @Composable (String, @Composable () -> Unit) -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    val me by container.profiles.mine.collectAsStateWithLifecycle()
    val list by produceState<List<com.meldiq.android.data.model.DecorationDto>?>(null, userId) { value = runCatching { container.profiles.userDecorations(userId) }.getOrNull() }
    var worn by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val self = me ?: return
    val items = list?.takeIf { it.isNotEmpty() } ?: return
    section(stringResource(R.string.deco_by_artist, name)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items.forEach { d ->
                Column(
                    Modifier.width(96.dp).clip(Shapes.small).border(1.dp, c.border, Shapes.small).padding(top = 14.dp, bottom = 8.dp, start = 4.dp, end = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LookAvatar(self.id, self.displayName, self.avatarColor, self.photoRev, PersonLook(style = ProfileStyleDto(decoration = d.id)), size = 46.dp)
                    Spacer(Modifier.height(8.dp))
                    Text(d.name, style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(6.dp))
                    PillButton(
                        stringResource(if (worn == d.id) R.string.deco_wearing else R.string.deco_wear),
                        onClick = {
                            scope.launch {
                                runCatching { container.profiles.setProfileStyle(kotlinx.serialization.json.buildJsonObject { put("decoration", kotlinx.serialization.json.JsonPrimitive(d.id)) }) }
                                    .onSuccess { worn = d.id }.onFailure { error = it.friendly() }
                            }
                        },
                        tone = ButtonTone.Glass,
                        enabled = worn != d.id,
                        height = 34.dp,
                    )
                }
            }
        }
        error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(top = 8.dp)) }
    }
}
