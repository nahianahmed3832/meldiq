package com.meldiq.android.ui.screens.community

import android.content.ClipData
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.InviteDto
import com.meldiq.android.data.api.MembersAddReq
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.scan.InviteCodes
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Expiry choices in hours (1 hour to 30 days, the server's range) and use limits (1 to 500), as Meldiq Web offers. */
private val EXPIRY_HOURS = listOf(1, 6, 12, 24, 72, 168, 720)
private val USE_LIMITS = listOf(1, 5, 10, 25, 50, 100, 500)
private const val DEFAULT_HOURS = 168
private const val DEFAULT_USES = 25
/** Pause after typing before searching. */
private const val SEARCH_DEBOUNCE_MS = 300L

/**
 * Invite people (API 0.42.0, as Meldiq Web's one Invite dialog): add people you know straight away, or make an
 * invitation link with an explicit expiry and use limit, then copy the link or the code, or share it. "Manage
 * invitations" opens the full list with revoking.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InvitePeopleSheet(org: OrgDto, canAddDirectly: Boolean, onManage: () -> Unit, onDismiss: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf(if (canAddDirectly) 0 else 1) }
    GlassSheet(onDismiss, title = stringResource(R.string.wp_inv_title)) {
        if (canAddDirectly) {
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TabChip(stringResource(R.string.wp_inv_tab_add), tab == 0, Modifier.weight(1f)) { tab = 0 }
                TabChip(stringResource(R.string.wp_inv_tab_link), tab == 1, Modifier.weight(1f)) { tab = 1 }
            }
        }
        if (tab == 0) AddPeople(org) else InviteLink(org, onManage)
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun TabChip(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Griip.colors
    Row(
        modifier.heightIn(min = 40.dp).clip(Shapes.pill).background(if (selected) c.primarySoft else c.surface)
            .border(1.dp, if (selected) c.primary else c.border, Shapes.pill)
            .selectable(selected, role = Role.Tab, onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) { Text(text, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = if (selected) c.textPrimary else c.textSecondary) }
}

@Composable
private fun AddPeople(org: OrgDto) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var picked by remember { mutableStateOf<Map<String, UserDto>>(emptyMap()) }
    var outcomes by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val me = container.session.session?.userId
    LaunchedEffect(q) {
        if (q.isBlank()) { found = emptyList(); return@LaunchedEffect }
        delay(SEARCH_DEBOUNCE_MS)
        found = runCatching { container.users.search(q.trim()) }.getOrDefault(emptyList()).filter { it.id != me }
    }
    Text(stringResource(R.string.wp_inv_add_sub), style = Griip.type.bodySmall, color = c.textSecondary)
    Spacer(Modifier.height(8.dp))
    GriipTextField(q, { q = it.take(40) }, stringResource(R.string.wp_inv_search), Modifier.fillMaxWidth(), leadingIcon = Icons.Outlined.Search)
    Spacer(Modifier.height(6.dp))
    val rows = (picked.values.toList() + found.filter { it.id !in picked }).distinctBy { it.id }
    LazyColumn(Modifier.heightIn(max = 300.dp)) {
        items(rows, key = { it.id }) { u ->
            val checked = u.id in picked
            val outcome = outcomes[u.id]
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(Shapes.small)
                    .toggleable(checked, enabled = outcome == null && (checked || picked.size < MembersAddReq.MAX), role = Role.Checkbox) { on ->
                        picked = if (on) picked + (u.id to u) else picked - u.id
                    }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked, onCheckedChange = null)
                UserAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, size = 36.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(u.displayName, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        when (outcome) {
                            "added" -> stringResource(R.string.wp_inv_added)
                            "already_member" -> stringResource(R.string.wp_inv_already)
                            "not_available" -> stringResource(R.string.wp_inv_not_available)
                            else -> "@${u.username}"
                        },
                        style = Griip.type.caption, color = if (outcome == "not_available") c.warning else if (outcome != null) c.success else c.textTertiary, maxLines = 1,
                    )
                }
            }
        }
    }
    if (picked.size >= MembersAddReq.MAX) Text(stringResource(R.string.wp_inv_max), style = Griip.type.caption, color = c.textTertiary)
    error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 4.dp)) }
    Spacer(Modifier.height(8.dp))
    val pending = picked.keys.filter { it !in outcomes }
    PillButton(
        stringResource(R.string.wp_inv_add_n, pending.size), {
            busy = true
            error = null
            scope.launch {
                runCatching { container.orgs.addMembers(org.id, pending) }
                    .onSuccess { results -> outcomes = outcomes + results.associate { it.userId to it.outcome } }
                    .onFailure { error = it.friendly() }
                busy = false
            }
        },
        Modifier.fillMaxWidth(), enabled = pending.isNotEmpty() && !busy, loading = busy, height = 48.dp,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InviteLink(org: OrgDto, onManage: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var hours by rememberSaveable { mutableStateOf(DEFAULT_HOURS) }
    var uses by rememberSaveable { mutableStateOf(DEFAULT_USES) }
    var created by remember { mutableStateOf<InviteDto?>(null) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    val copied = stringResource(R.string.wp_inv_copied)
    val invite = created
    if (invite?.code == null) {
        Text(stringResource(R.string.wp_inv_expires), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            EXPIRY_HOURS.forEach { h ->
                val label = when {
                    h < 24 -> stringResource(R.string.wp_inv_hours, h)
                    h == 24 -> stringResource(R.string.wp_inv_day)
                    else -> stringResource(R.string.wp_inv_days, h / 24)
                }
                TabChip(label, hours == h, Modifier) { hours = h }
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(stringResource(R.string.wp_inv_uses), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
        Spacer(Modifier.height(6.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            USE_LIMITS.forEach { n -> TabChip(if (n == 1) stringResource(R.string.wp_inv_once) else stringResource(R.string.wp_inv_uses_n, n), uses == n, Modifier) { uses = n } }
        }
        status?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(12.dp))
        PillButton(
            stringResource(R.string.wp_inv_create), {
                busy = true
                status = null
                scope.launch {
                    runCatching { container.orgs.createInvite(org.id, "MEMBER", uses, hours) }.onSuccess { created = it }.onFailure { status = it.friendly() }
                    busy = false
                }
            },
            Modifier.fillMaxWidth(), enabled = !busy, loading = busy, height = 48.dp,
        )
    } else {
        val code = invite.code
        val link = InviteCodes.link(code)
        Text(stringResource(R.string.wp_inv_shown_once), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(8.dp))
        Text(link, style = Griip.type.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, modifier = Modifier.fillMaxWidth().clip(Shapes.small).background(c.surfaceVariant).padding(12.dp))
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton(stringResource(R.string.wp_inv_copy_link), {
                scope.launch { clipboard.setClipEntry(ClipData.newPlainText("invite", link).toClipEntry()); status = copied }
            }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
            PillButton(stringResource(R.string.wp_inv_copy_code), {
                scope.launch { clipboard.setClipEntry(ClipData.newPlainText("invite", code).toClipEntry()); status = copied }
            }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
        }
        Spacer(Modifier.height(8.dp))
        val shareText = stringResource(R.string.wp_inv_share_text, org.name, link)
        PillButton(stringResource(R.string.wp_inv_share), {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, shareText)
            runCatching { ctx.startActivity(Intent.createChooser(send, null)) }
        }, Modifier.fillMaxWidth(), height = 48.dp)
        status?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp)) }
    }
    Spacer(Modifier.height(10.dp))
    PillButton(stringResource(R.string.wp_inv_manage), onManage, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 44.dp)
}
