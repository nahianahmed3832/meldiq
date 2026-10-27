package com.meldiq.android.ui.screens.community

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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.model.AccentRules
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.media.MediaPrep
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/** A community tag: 2–4 letters or digits (server `orgs.tag`), stored in capitals. */
private val TAG = Regex("^[A-Za-z0-9]{2,4}$")

/**
 * Community settings › Appearance (API 0.44.0 and 0.46.0, as Meldiq Web's Overview › Appearance and Community tag): the
 * accent (Meldiq's presets; text stays readable whatever is picked), the banner and the tag members can wear. For people
 * with `workspace.edit`; the server checks it again.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CommunityAppearanceCard(org: OrgDto, onChanged: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var tag by remember(org.tag) { mutableStateOf(org.tag.orEmpty()) }
    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onSuccess { onChanged() }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val pickBanner = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        run { container.orgs.setBanner(org.id, MediaPrep.bannerJpeg(ctx, uri)) }
    }
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.wp_appearance), style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Spacer(Modifier.height(8.dp))
            Box(Modifier.fillMaxWidth().clip(Shapes.small)) { CommunityBanner(org.id, org.accent, org.bannerRev) }
            Spacer(Modifier.height(10.dp))
            Text(stringResource(R.string.wp_accent), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
            Text(stringResource(R.string.wp_accent_sub), style = Griip.type.caption, color = c.textTertiary)
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AccentChoice(null, org.accent == null, stringResource(R.string.wp_meldiq_theme)) { run { container.orgs.setBranding(org.id, clearAccent = true) } }
                AccentRules.PRESETS.forEach { hex ->
                    AccentChoice(hex, org.accent.equals(hex, ignoreCase = true), hex) { run { container.orgs.setBranding(org.id, accent = hex) } }
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.wp_community_banner), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(R.string.wp_style_choose), { pickBanner.launch("image/*") }, Modifier.weight(1f), tone = ButtonTone.Glass, enabled = !busy, loading = busy, height = 44.dp)
                if (org.bannerRev != null) PillButton(stringResource(R.string.wp_style_remove), { run { container.orgs.removeBanner(org.id) } }, Modifier.weight(1f), tone = ButtonTone.Danger, enabled = !busy, height = 44.dp)
            }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.wp_style_tag), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
            Text(stringResource(R.string.wp_community_tag_sub), style = Griip.type.caption, color = c.textTertiary)
            Spacer(Modifier.height(6.dp))
            val tagOk = tag.isEmpty() || TAG.matches(tag)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                GriipTextField(
                    tag, { v -> tag = v.filter(Char::isLetterOrDigit).take(4).uppercase() }, stringResource(R.string.wp_style_tag), Modifier.weight(1f),
                    error = if (tagOk) null else stringResource(R.string.wp_tag_invalid),
                )
                PillButton(
                    stringResource(R.string.wp_save), { run { if (tag.isEmpty()) container.orgs.setBranding(org.id, clearTag = true) else container.orgs.setBranding(org.id, tag = tag) } },
                    enabled = !busy && tagOk && tag != org.tag.orEmpty(), height = 44.dp,
                )
            }
            error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
        }
    }
}

/** One accent to pick; null is Meldiq's own theme. */
@Composable
private fun AccentChoice(hex: String?, selected: Boolean, label: String, onClick: () -> Unit) {
    val c = Griip.colors
    val fill = hex?.let { LookRules.argb(it) }?.let(::Color) ?: c.primary
    Box(
        Modifier.size(40.dp).clip(CircleShape).border(if (selected) 3.dp else 1.dp, if (selected) c.textPrimary else c.border, CircleShape)
            .padding(4.dp).clip(CircleShape).background(if (hex == null) c.surfaceVariant else fill)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (hex == null) Box(Modifier.size(14.dp).clip(CircleShape).background(c.primary))
    }
}
