package com.meldiq.android.ui.screens.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ExitToApp
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDetailRes
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.media.MediaPrep
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.RoleBadge
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.StatTile
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.launch

/** The server's limits on a workspace's name and description (`zName`, `zText`). */
private const val NAME_MAX = 80
/** API 0.64.0: an animated community icon as sent (server COMMUNITY_IMAGE_LIMITS). */
private const val ANIMATED_ICON_MAX = 4L * 1024 * 1024
private const val DESCRIPTION_MAX = 500

/**
 * Community settings (docs/WORKSPACE_ADMINISTRATION.md, docs/COMMUNITY_REBUILD_2026-10-21.md): its details and your
 * role, editing its name, description and rules (owners and admins), who can find and join it (owners), and leaving it
 * (everyone but the last owner). The server checks each action again. [onChanged] reloads the caller's data; [onLeft]
 * gets the community's name once you've left.
 */
@Composable
fun WorkspaceSettingsSheet(detail: OrgDetailRes, onDismiss: () -> Unit, onChanged: () -> Unit, onLeft: (String) -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    val org = detail.org
    val canEdit = detail.permissions.canManageOrg
    var name by rememberSaveable(org.id) { mutableStateOf(org.name) }
    var description by rememberSaveable(org.id) { mutableStateOf(org.description.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    var photoRev by remember(org.id) { mutableStateOf(org.photoRev) }
    var photoBusy by remember { mutableStateOf(false) }
    var photosSupported by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { photosSupported = container.features.has(ServerFeatures.ORG_PHOTOS) == true }
    var rules by rememberSaveable(org.id) { mutableStateOf(org.rules.orEmpty()) }
    var visibility by remember(org.id, org.visibility) { mutableStateOf(org.visibility) }
    var joinPolicy by remember(org.id, org.joinPolicy) { mutableStateOf(org.joinPolicy) }
    val owner = org.myRole == "OWNER"
    val ctx = LocalContext.current
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            photoBusy = true
            error = null
            runCatching {
                // API 0.64.0: an animated GIF or WebP icon goes as it is; anything else is made a square JPEG.
                val type = ctx.contentResolver.getType(uri).orEmpty()
                val animated = (type == "image/gif" || type == "image/webp") && container.features.has(ServerFeatures.ANIMATED_COMMUNITY_IMAGES) == true
                container.orgs.setOrgPhoto(org.id, if (animated) MediaPrep.rawBytes(ctx, uri, ANIMATED_ICON_MAX) else MediaPrep.profilePhoto(ctx, uri))
            }
                .onSuccess { photoRev = it; onChanged() }.onFailure { error = it.friendly() }
            photoBusy = false
        }
    }
    val changed = name.trim() != org.name || description.trim() != org.description.orEmpty().trim() || rules.trim() != org.rules.orEmpty().trim() ||
        visibility != org.visibility || joinPolicy != org.joinPolicy

    GlassSheet(onDismiss, title = stringResource(R.string.ws_settings_title)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
            // Round 7 (docs/WORKSPACE_C5.md): who may be a guest, and for how long.
            if (canEdit) GuestPolicyCard(org.id, org.guestsAllowed, org.guestMaxDays, onChanged = onChanged)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OrgMark(org.id, org.name, WorkspaceList.colorSeed(org), photoRev, size = 52.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(org.name, style = Griip.type.title, color = c.textPrimary, maxLines = 2)
                    Text(
                        org.description?.takeIf { it.isNotBlank() } ?: stringResource(R.string.ws_no_description),
                        style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 3,
                    )
                }
                RoleBadge(org.myRole)
            }
            Spacer(Modifier.height(12.dp))
            Row {
                StatTile(stringResource(R.string.ws_stat_members), "${detail.stats.members}", Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                StatTile(stringResource(R.string.cm_stat_categories), "${detail.categories.size}", Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                StatTile(stringResource(R.string.ws_stat_channels), "${detail.stats.channels}", Modifier.weight(1f))
            }
            if (canEdit && photosSupported) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton(
                        stringResource(if (photoRev == null) R.string.ws_photo_add else R.string.ws_photo_change),
                        { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                        tone = ButtonTone.Glass, height = 40.dp, leadingIcon = Icons.Outlined.PhotoCamera, loading = photoBusy,
                    )
                    if (photoRev != null) PillButton(
                        stringResource(R.string.ws_photo_remove), {
                            scope.launch {
                                photoBusy = true
                                error = null
                                runCatching { container.orgs.removeOrgPhoto(org.id) }.onSuccess { photoRev = null; onChanged() }.onFailure { error = it.friendly() }
                                photoBusy = false
                            }
                        },
                        tone = ButtonTone.Glass, height = 40.dp, leadingIcon = Icons.Outlined.Delete,
                    )
                }
            }
            if (org.createdAt > 0) {
                Text(
                    stringResource(R.string.ws_created, TimeFmt.listStamp(org.createdAt)), style = Griip.type.caption, color = c.textTertiary,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            error?.let { Spacer(Modifier.height(8.dp)); StatusBanner(it, BannerKind.Error) }
            if (saved && !changed) { Spacer(Modifier.height(8.dp)); StatusBanner(stringResource(R.string.ws_saved), BannerKind.Success) }

            SectionHeader(stringResource(R.string.ws_edit), Modifier.padding(top = 16.dp, bottom = 6.dp))
            if (canEdit) {
                GriipTextField(name, { name = it.take(NAME_MAX); saved = false }, stringResource(R.string.ws_name))
                Spacer(Modifier.height(10.dp))
                GriipTextField(
                    description, { description = it.take(DESCRIPTION_MAX); saved = false }, stringResource(R.string.ws_description),
                    singleLine = false, minLines = 2,
                )
                Spacer(Modifier.height(10.dp))
                GriipTextField(rules, { rules = it.take(4000); saved = false }, stringResource(R.string.cs_rules), helper = stringResource(R.string.cs_rules_hint), singleLine = false, minLines = 3)
                // Who can find and join it: owners only (the server checks).
                SectionHeader(stringResource(R.string.cs_visibility), Modifier.padding(top = 12.dp, bottom = 6.dp))
                com.meldiq.android.ui.components.SegmentedPills(
                    listOf(stringResource(R.string.cs_private), stringResource(R.string.cs_public)),
                    if (visibility == com.meldiq.android.data.api.CommunityAccess.PUBLIC) 1 else 0,
                    { i -> if (owner) { visibility = if (i == 1) com.meldiq.android.data.api.CommunityAccess.PUBLIC else com.meldiq.android.data.api.CommunityAccess.PRIVATE; saved = false } },
                    Modifier.fillMaxWidth(),
                )
                SectionHeader(stringResource(R.string.cs_join), Modifier.padding(top = 12.dp, bottom = 6.dp))
                com.meldiq.android.ui.components.SegmentedPills(
                    listOf(stringResource(R.string.cs_invite), stringResource(R.string.cs_open)),
                    if (joinPolicy == com.meldiq.android.data.api.CommunityAccess.OPEN) 1 else 0,
                    { i -> if (owner) { joinPolicy = if (i == 1) com.meldiq.android.data.api.CommunityAccess.OPEN else com.meldiq.android.data.api.CommunityAccess.INVITE; saved = false } },
                    Modifier.fillMaxWidth(),
                )
                if (!owner) Text(stringResource(R.string.cs_owner_only), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.height(12.dp))
                PillButton(stringResource(R.string.ws_save), {
                    busy = true
                    error = null
                    scope.launch {
                        runCatching {
                            container.orgs.updateOrg(
                                org.id, name, description, rules,
                                visibility.takeIf { owner && it != org.visibility }, joinPolicy.takeIf { owner && it != org.joinPolicy },
                            )
                        }
                            .onSuccess { saved = true; onChanged() }
                            .onFailure { error = it.friendly() }
                        busy = false
                    }
                }, Modifier.fillMaxWidth(), enabled = changed && name.isNotBlank(), loading = busy, height = 50.dp)
            } else {
                Text(stringResource(R.string.ws_admin_only), style = Griip.type.bodySmall, color = c.textSecondary)
            }

            Spacer(Modifier.height(16.dp))
            GlassCard(Modifier.fillMaxWidth(), contentPadding = PaddingValues(6.dp)) {
                if (WorkspaceRoles.canLeave(detail)) {
                    MenuRow(
                        Icons.AutoMirrored.Outlined.ExitToApp, stringResource(R.string.ws_leave), subtitle = stringResource(R.string.ws_leave_sub),
                        tint = c.danger, tintBg = c.dangerSoft, onClick = { confirmLeave = true }, trailing = null,
                    )
                } else {
                    MenuRow(
                        Icons.Outlined.Info, stringResource(R.string.ws_leave), subtitle = stringResource(R.string.ws_leave_owner),
                        tint = c.textSecondary, tintBg = c.surfaceVariant, trailing = null,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
    if (confirmLeave) {
        ConfirmDialog(
            stringResource(R.string.ws_leave_confirm_title, org.name), stringResource(R.string.ws_leave_confirm_body), stringResource(R.string.ws_leave_confirm),
            onConfirm = {
                confirmLeave = false
                val me = container.session.session?.userId
                if (me == null) return@ConfirmDialog
                scope.launch {
                    runCatching { container.orgs.leave(org.id, me) }
                        .onSuccess { runCatching { container.navPrefs.forget(org.id) }; onLeft(org.name) }
                        .onFailure { error = it.friendly() }
                }
            },
            onDismiss = { confirmLeave = false }, destructive = true,
        )
    }
}
