package com.meldiq.android.ui.screens.profile

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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.model.AccentRules
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.data.model.PersonLook
import com.meldiq.android.data.model.ProfileStyleDto
import com.meldiq.android.data.model.WornTag
import com.meldiq.android.media.MediaPrep
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.LookAvatar
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.ProfileBannerHeight
import com.meldiq.android.ui.components.ProfileBannerView
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.StyledName
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The server's size limits for what's picked here (docs/PROFILE_MEDIA.md). */
private const val AVATAR_MEDIA_MAX = 12L * 1024 * 1024
private const val ANIMATED_BANNER_MAX = 6L * 1024 * 1024

/**
 * Settings › Profile style (API 0.45.0–0.46.0, as Meldiq Web's Profile style and Name style cards): a live preview, the
 * animated avatar and banner, the avatar frame, banner effect and colour, the name's font, colours and effect, and the
 * community tag worn by the name. Each choice is saved at once, as on the web.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileStyleScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val me by container.profiles.mine.collectAsStateWithLifecycle()
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val orgs by androidx.compose.runtime.produceState<List<com.meldiq.android.data.api.OrgDto>?>(null) {
        value = container.orgs.cachedOrgs()
        value = runCatching { container.orgs.orgs() }.getOrNull() ?: value
    }
    LaunchedEffect(Unit) { runCatching { container.profiles.me() }.onFailure { error = it.friendly() } }
    val style = me?.profileStyle ?: ProfileStyleDto()

    fun save(changes: kotlinx.serialization.json.JsonObject) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching { container.profiles.setProfileStyle(changes) }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    fun upload(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { e -> error = if (e.message == "too_large") ctx.getString(R.string.wp_style_too_large) else e.friendly() }
            busy = false
        }
    }
    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        upload { container.profiles.setAvatarMedia(MediaPrep.rawBytes(ctx, uri, AVATAR_MEDIA_MAX)) }
    }
    val pickBanner = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        upload {
            // An animated GIF or WebP goes as it is; anything else is made a 1200 × 480 JPEG under 1 MB.
            val type = ctx.contentResolver.getType(uri).orEmpty()
            val bytes = if (type == "image/gif" || type == "image/webp") MediaPrep.rawBytes(ctx, uri, ANIMATED_BANNER_MAX) else MediaPrep.bannerJpeg(ctx, uri)
            container.profiles.setProfileBanner(bytes)
        }
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar(stringResource(R.string.wp_style_title), onBack = { nav.popBackStack() }) }
        item { Text(stringResource(R.string.wp_style_sub), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) } }
        val u = me ?: return@LazyColumn
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), shape = Shapes.hero) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.wp_style_preview), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.align(Alignment.Start))
                    Spacer(Modifier.height(6.dp))
                    ProfileBannerView(u.id, u.profileBanner, style, Modifier.fillMaxWidth().height(ProfileBannerHeight).clip(Shapes.small))
                    Spacer(Modifier.height(10.dp))
                    val look = PersonLook(u.avatarMedia, style, u.tag)
                    LookAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, look, size = 76.dp)
                    Spacer(Modifier.height(8.dp))
                    StyledName(u.displayName, look, Griip.type.headline, c.textPrimary)
                }
            }
        }
        item {
            MediaCard(
                stringResource(R.string.wp_style_avatar), stringResource(R.string.wp_style_avatar_sub), has = u.avatarMedia != null, busy = busy,
                onChoose = { pickAvatar.launch("*/*") }, onRemove = { upload { container.profiles.removeAvatarMedia() } },
            )
        }
        item {
            MediaCard(
                stringResource(R.string.wp_style_banner), stringResource(R.string.wp_style_banner_sub), has = u.profileBanner != null, busy = busy,
                onChoose = { pickBanner.launch("image/*") }, onRemove = { upload { container.profiles.removeProfileBanner() } },
            )
        }
        item {
            // API 0.60.0: Meldiq's own, community and your own decorations (DecorationPicker.kt).
            DecorationSection(u, style.decoration, busy, classicLabel = ::label) { d -> save(buildJsonObject { put("decoration", d?.let(::JsonPrimitive) ?: JsonNull) }) }
        }
        item {
            ChoiceCard(stringResource(R.string.wp_style_effect)) {
                Choice(stringResource(R.string.wp_style_none), style.effect == null) { save(buildJsonObject { put("effect", JsonNull) }) }
                LookRules.EFFECTS.forEach { e -> Choice(label(e), style.effect == e) { save(buildJsonObject { put("effect", JsonPrimitive(e)) }) } }
            }
        }
        item {
            ChoiceCard(stringResource(R.string.wp_style_color)) {
                Choice(stringResource(R.string.wp_style_none), style.accent == null) { save(buildJsonObject { put("accent", JsonNull) }) }
                AccentRules.PRESETS.forEach { hex -> Swatch(listOf(hex), style.accent.equals(hex, ignoreCase = true)) { save(buildJsonObject { put("accent", JsonPrimitive(hex)) }) } }
            }
        }
        item {
            ChoiceCard(stringResource(R.string.wp_style_name_font)) {
                Choice(stringResource(R.string.wp_style_none), style.nameFont == null) { save(buildJsonObject { put("nameFont", JsonNull) }) }
                LookRules.NAME_FONTS.forEach { f ->
                    Choice(label(f), style.nameFont == f, preview = { StyledName(u.displayName.take(10), PersonLook(style = ProfileStyleDto(nameFont = f)), Griip.type.label, c.textPrimary) }) {
                        save(buildJsonObject { put("nameFont", JsonPrimitive(f)) })
                    }
                }
            }
        }
        item {
            ChoiceCard(stringResource(R.string.wp_style_name_colors)) {
                Choice(stringResource(R.string.wp_style_none), style.nameColors.isNullOrEmpty()) { save(buildJsonObject { put("nameColors", JsonNull) }) }
                LookRules.COLOR_PRESETS.forEach { (_, colors) ->
                    Swatch(colors, style.nameColors?.map { it.lowercase() } == colors) { save(buildJsonObject { put("nameColors", JsonArray(colors.map(::JsonPrimitive))) }) }
                }
            }
        }
        item {
            ChoiceCard(stringResource(R.string.wp_style_name_effect)) {
                Choice(stringResource(R.string.wp_style_none), style.nameEffect == null) { save(buildJsonObject { put("nameEffect", JsonNull) }) }
                Choice(stringResource(R.string.wp_effect_glow), style.nameEffect == "glow") { save(buildJsonObject { put("nameEffect", JsonPrimitive("glow")) }) }
                Choice(stringResource(R.string.wp_effect_shimmer), style.nameEffect == "shimmer") { save(buildJsonObject { put("nameEffect", JsonPrimitive("shimmer")) }) }
            }
        }
        item(key = "about-${u.aboutMe}-${u.links}") { AboutEditor(u.aboutMe, u.links.orEmpty()) }
        val tagged = orgs.orEmpty().filter { !it.tag.isNullOrBlank() }
        if (tagged.isNotEmpty()) item {
            ChoiceCard(stringResource(R.string.wp_style_tag), stringResource(R.string.wp_style_tag_sub)) {
                Choice(stringResource(R.string.wp_style_none), style.tagOrgId == null) { save(buildJsonObject { put("tagOrgId", JsonNull) }) }
                tagged.forEach { o ->
                    Choice(o.name, style.tagOrgId == o.id, preview = { com.meldiq.android.ui.components.WornTagChip(WornTag(o.id, o.tag.orEmpty(), o.accent)) }) {
                        save(buildJsonObject { put("tagOrgId", JsonPrimitive(o.id)) })
                    }
                }
            }
        }
    }
}

/** A chosen id as shown (Meldiq's own names for frames, effects and fonts). */
private fun label(id: String): String = when (id) {
    "mono" -> "Code"
    else -> id.replaceFirstChar { it.uppercase() }
}

@Composable
private fun MediaCard(title: String, sub: String, has: Boolean, busy: Boolean, onChoose: () -> Unit, onRemove: () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(title, style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Text(sub, style = Griip.type.caption, color = c.textSecondary)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(R.string.wp_style_choose), onChoose, Modifier.weight(1f), tone = ButtonTone.Glass, enabled = !busy, loading = busy, height = 44.dp)
                if (has) PillButton(stringResource(R.string.wp_style_remove), onRemove, Modifier.weight(1f), tone = ButtonTone.Danger, enabled = !busy, height = 44.dp)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceCard(title: String, sub: String? = null, content: @Composable () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(title, style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            sub?.let { Text(it, style = Griip.type.caption, color = c.textSecondary) }
            Spacer(Modifier.height(10.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
        }
    }
}

@Composable
private fun Choice(text: String, selected: Boolean, preview: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    val c = Griip.colors
    Column(
        Modifier.heightIn(min = 44.dp).clip(Shapes.small).background(if (selected) c.primarySoft else c.surface)
            .border(1.dp, if (selected) c.primary else c.border, Shapes.small)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        preview?.invoke()
        Text(text, style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = if (selected) c.textPrimary else c.textSecondary, maxLines = 1)
    }
}

/** A colour or gradient to pick; its hex values are what's spoken. */
@Composable
private fun Swatch(hex: List<String>, selected: Boolean, onClick: () -> Unit) {
    val c = Griip.colors
    val colors = hex.mapNotNull { LookRules.argb(it)?.let(::Color) }
    val fill = if (colors.size > 1) Brush.linearGradient(colors) else Brush.linearGradient(listOf(colors.first(), colors.first()))
    Box(
        Modifier.size(44.dp).clip(CircleShape).border(if (selected) 3.dp else 1.dp, if (selected) c.textPrimary else c.border, CircleShape)
            .padding(4.dp).clip(CircleShape).background(fill)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = hex.joinToString(" ") },
    )
}

/** The most links a profile shows (server `PROFILE_LINKS_MAX`), and About me's length. */
private const val LINKS_MAX = 5
private const val ABOUT_MAX = 300

/** About me and up to five https links (API 0.46.0), as Meldiq Web's My Profile; Save sends both. */
@Composable
private fun AboutEditor(about: String?, links: List<com.meldiq.android.data.api.ProfileLinkDto>) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(about.orEmpty()) }
    var rows by remember { mutableStateOf(links.map { it.label to it.url }) }
    var status by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val savedLabel = stringResource(R.string.wp_style_saved)
    val badLink = rows.any { (_, url) -> url.isNotBlank() && !url.trim().startsWith("https://") }
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.wp_about_me), style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Spacer(Modifier.height(8.dp))
            com.meldiq.android.ui.components.GriipTextField(
                text, { text = it.take(ABOUT_MAX) }, stringResource(R.string.wp_about_hint), Modifier.fillMaxWidth(), singleLine = false, minLines = 3,
                helper = "${text.length}/$ABOUT_MAX",
            )
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.wp_links), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
            rows.forEachIndexed { i, (label, url) ->
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    com.meldiq.android.ui.components.GriipTextField(label, { v -> rows = rows.toMutableList().also { it[i] = v.take(40) to url } }, stringResource(R.string.wp_link_label), Modifier.weight(0.4f))
                    com.meldiq.android.ui.components.GriipTextField(url, { v -> rows = rows.toMutableList().also { it[i] = label to v.take(300) } }, stringResource(R.string.wp_link_url), Modifier.weight(0.6f))
                }
            }
            if (rows.size < LINKS_MAX) {
                Spacer(Modifier.height(6.dp))
                PillButton(stringResource(R.string.wp_link_add), { rows = rows + ("" to "https://") }, tone = ButtonTone.Glass, height = 40.dp)
            }
            if (badLink) Text(stringResource(R.string.wp_links_https), style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp))
            status?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp)) }
            Spacer(Modifier.height(10.dp))
            PillButton(
                stringResource(R.string.wp_save), {
                    saving = true
                    scope.launch {
                        val kept = rows.map { (l, u) -> l.trim() to u.trim() }.filter { (_, u) -> u.startsWith("https://") && u.length > "https://".length }
                            .map { (l, u) -> com.meldiq.android.data.api.ProfileLinkDto(l.ifBlank { u.removePrefix("https://").substringBefore('/') }, u) }
                        status = runCatching { container.profiles.setAbout(text, kept) }.fold({ savedLabel }, { it.friendly() })
                        saving = false
                    }
                },
                Modifier.fillMaxWidth(), enabled = !saving && !badLink, loading = saving, height = 44.dp,
            )
        }
    }
}
