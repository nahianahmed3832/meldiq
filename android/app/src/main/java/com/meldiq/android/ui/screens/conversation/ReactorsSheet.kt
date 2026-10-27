package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.db.UserEntity
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/**
 * Everyone who reacted to a message, one tab per reaction (community-first brief §B, as Meldiq Web's reactions dialog):
 * opened on the reaction that was long-pressed. Reactions travel end-to-end encrypted, so this is the phone's own copy.
 */
@Composable
fun ReactorsSheet(
    reactions: Map<String, List<String>>,
    initial: String,
    me: String?,
    users: Map<String, UserEntity>,
    onDismiss: () -> Unit,
    onOpenProfile: (String) -> Unit,
) {
    val c = Griip.colors
    val emojis = reactions.keys.toList()
    var tab by rememberSaveable(initial) { mutableStateOf(initial.takeIf { it in reactions } ?: emojis.firstOrNull().orEmpty()) }
    val communityEmoji = com.meldiq.android.ui.components.LocalCommunityEmoji.current
    GlassSheet(onDismiss, title = stringResource(R.string.wp_react_dialog_title)) {
        if (emojis.isEmpty()) return@GlassSheet
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 10.dp)) {
            items(emojis, key = { it }) { e ->
                val selected = e == tab
                val count = reactions[e].orEmpty().size
                Row(
                    Modifier.heightIn(min = 36.dp).clip(Shapes.pill).background(if (selected) c.primarySoft else c.surface)
                        .border(1.dp, if (selected) c.primary else c.border, Shapes.pill)
                        .selectable(selected, role = Role.Tab, onClick = { tab = e })
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val custom = com.meldiq.android.data.model.ExpressionRules.reactionName(e)?.let(communityEmoji::get)
                    if (custom != null) com.meldiq.android.ui.components.CustomEmojiImage(custom, 18.dp) else Text(e, style = Griip.type.label)
                    Spacer(Modifier.width(6.dp))
                    Text("$count", style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = if (selected) c.primaryDeep else c.textSecondary)
                }
            }
        }
        val people = reactions[tab].orEmpty()
        Text(stringResource(R.string.wp_react_count, people.size), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(bottom = 4.dp))
        LazyColumn(Modifier.heightIn(max = REACTORS_LIST_MAX)) {
            items(people, key = { it }) { id ->
                val u = users[id]
                val name = if (id == me) stringResource(R.string.wp_react_you) else u?.displayName ?: stringResource(R.string.wp_react_someone)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(Shapes.small)
                        .then(if (id != me) Modifier.selectable(false, onClick = { onOpenProfile(id) }) else Modifier)
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    UserAvatar(id, u?.displayName ?: name, u?.avatarColor ?: 0, u?.photoRev, size = 36.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(name, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    u?.username?.takeIf { id != me }?.let { Text("@$it", style = Griip.type.caption, color = c.textTertiary, maxLines = 1) }
                }
            }
        }
        Spacer(Modifier.heightIn(min = 8.dp))
    }
}

/** Long lists scroll inside the sheet. */
private val REACTORS_LIST_MAX = 420.dp
