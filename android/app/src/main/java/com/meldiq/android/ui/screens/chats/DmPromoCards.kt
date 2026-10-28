package com.meldiq.android.ui.screens.chats

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.scan.InviteCodes
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** The Meldiq invitation's text (unit-tested in `DmPromoRulesTest`): a link to Meldiq, and your username to add you by. */
object DmPromoRules {
    const val MELDIQ_URL = "https://" + InviteCodes.WEB_HOST

    /** The username to add you by, without its "@"; null when there's none to share. */
    fun handle(username: String?): String? = username?.trim()?.removePrefix("@")?.takeIf { it.isNotEmpty() }
}

/**
 * Invite friends to Meldiq itself (the floating redesign, 2026-10-28): the phone's share sheet with a link to Meldiq and
 * your username. Invitations to a community stay in that community (its menu › Invite).
 */
@Composable
fun MeldiqInviteCard(modifier: Modifier = Modifier) {
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val c = Griip.colors
    val username = container.session.session?.username
    val chooser = stringResource(R.string.dm_invite_title)
    val share = {
        val text = DmPromoRules.handle(username)?.let { ctx.getString(R.string.dm_invite_text, DmPromoRules.MELDIQ_URL, it) }
            ?: ctx.getString(R.string.dm_invite_text_plain, DmPromoRules.MELDIQ_URL)
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        runCatching { ctx.startActivity(Intent.createChooser(send, chooser)) }
        Unit
    }
    Row(
        modifier.fillMaxWidth().clip(Shapes.card).background(c.primarySoft).border(1.dp, c.border, Shapes.card).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(Shapes.pill).background(c.surface), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.PersonAddAlt, null, tint = c.primary, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.dm_invite_title), style = Griip.type.titleSmall, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(stringResource(R.string.dm_invite_body), style = Griip.type.caption, color = c.textSecondary, maxLines = 2)
        }
        Spacer(Modifier.width(8.dp))
        PillButton(stringResource(R.string.dm_invite_action), share, height = 40.dp)
    }
}

/** A small Meldiq Mojo card under the invitation: your plan, or what Mojo adds; opens the plans. */
@Composable
fun MojoPromoCard(onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val mojo = LocalContainer.current.mojo
    val state by mojo.state.collectAsState()
    LaunchedEffect(Unit) { if (state.entitlements == null) mojo.refresh() }
    val c = Griip.colors
    val key = MojoPlans.currentKey(state.entitlements)
    val name = state.catalog?.plan(key)?.name
    val line = if (key != MojoPlans.FREE && name != null) stringResource(R.string.mojo_entry_sub_plan, name) else stringResource(R.string.mojo_entry_sub_free)
    Row(
        modifier.fillMaxWidth().clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card)
            .pressable(onOpen, onClickLabel = stringResource(R.string.dm_mojo_action)).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(Shapes.pill).background(Brush.linearGradient(listOf(c.accentStart, c.accentEnd))), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.AutoAwesome, null, tint = c.onAccent, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.mojo_title), style = Griip.type.titleSmall.copy(fontWeight = FontWeight.Bold), color = c.textPrimary)
            Text(line, style = Griip.type.caption, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Text(stringResource(R.string.dm_mojo_action), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
    }
}
