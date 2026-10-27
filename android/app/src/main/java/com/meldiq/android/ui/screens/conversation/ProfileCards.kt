package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.db.UserEntity
import com.meldiq.android.data.model.ContactCard
import com.meldiq.android.data.model.RichRules
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/**
 * Share a Meldiq profile (round 7, replacing the address-book contact picker): yours, or someone you already talk to.
 * The card carries the display name, user id and username only, never a phone number, and needs no contacts
 * permission. The recipient opens the profile, where Meldiq's own privacy and blocking rules apply.
 */
@Composable
fun ProfileShareSheet(people: List<UserEntity>, me: UserEntity?, onSend: (ContactCard) -> Unit, onDismiss: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim().lowercase()
    val shown = people.filter { it.id != me?.id }
        .filter { q.isEmpty() || it.displayName.lowercase().contains(q) || it.username.lowercase().contains(q) }
        .sortedBy { it.displayName.lowercase() }
    fun send(u: UserEntity) { RichRules.profileCard(u.id, u.displayName, u.username)?.let(onSend) }
    GlassSheet(onDismiss, title = stringResource(R.string.card_share_title)) {
        Text(stringResource(R.string.card_share_note), style = Griip.type.caption, color = Griip.colors.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
        SearchPill(query, { query = it }, stringResource(R.string.card_share_search))
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
            if (me != null && q.isEmpty()) item(key = "me") { PersonRow(me, stringResource(R.string.card_share_mine)) { send(me) } }
            items(shown, key = { it.id }) { u -> PersonRow(u, null) { send(u) } }
        }
        if (shown.isEmpty() && q.isNotEmpty()) {
            Text(stringResource(R.string.card_share_none), style = Griip.type.bodySmall, color = Griip.colors.textSecondary, modifier = Modifier.padding(vertical = 12.dp))
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun PersonRow(u: UserEntity, label: String?, onClick: () -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().clip(Shapes.small).pressable(onClick, onClickLabel = stringResource(R.string.card_share_send, u.displayName)).padding(vertical = 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        com.meldiq.android.ui.components.LookAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, com.meldiq.android.data.model.PersonLooks.of(u.lookJson), size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label ?: u.displayName, style = Griip.type.body.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("@${u.username}", style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A received or sent profile card: name, @username and one action, View profile. No phone number, ever. */
@Composable
fun ProfileCardView(card: ContactCard, userId: String, out: Boolean, onOpenProfile: (String) -> Unit) {
    val c = Griip.colors
    Column(Modifier.widthIn(min = 220.dp, max = 270.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            UserAvatar(userId, card.name, 0, null, size = 40.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(card.name, style = Griip.type.titleSmall, color = if (out) c.onBubbleOutgoing else c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                card.username?.let { Text("@$it", style = Griip.type.bodySmall, color = if (out) c.bubbleOutgoingMeta else c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                Text(stringResource(R.string.card_label), style = Griip.type.caption, color = if (out) c.bubbleOutgoingMeta else c.textTertiary)
            }
        }
        Spacer(Modifier.height(8.dp))
        PillButton(stringResource(R.string.card_view_profile), { onOpenProfile(userId) }, tone = ButtonTone.Glass, height = 34.dp, leadingIcon = Icons.Outlined.AccountCircle)
    }
}
