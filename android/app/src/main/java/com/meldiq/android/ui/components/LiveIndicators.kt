package com.meldiq.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.call.LiveCall
import com.meldiq.android.data.model.UnreadMarker
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/**
 * An unread marker as Meldiq Web draws it ([com.meldiq.android.data.model.UnreadRules]): a dot for one message in a
 * channel, a light count for more, a DM's count in the accent, and the pink "@" badge for a mention. Spoken text belongs
 * to the row (its state description), so this draws only.
 */
@Composable
fun UnreadMarkerView(marker: UnreadMarker, modifier: Modifier = Modifier) {
    val c = Griip.colors
    when (marker) {
        UnreadMarker.None -> Unit
        UnreadMarker.Dot -> Box(modifier.size(8.dp).clip(Shapes.pill).background(c.textPrimary))
        is UnreadMarker.Count -> Pill(marker.text, if (marker.direct) c.primary else c.surfaceVariant, if (marker.direct) c.onPrimary else c.textPrimary, modifier)
        is UnreadMarker.Mention -> Pill(marker.text, c.badge, c.onBadge, modifier)
    }
}

@Composable
private fun Pill(text: String, background: androidx.compose.ui.graphics.Color, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Box(
        modifier.height(20.dp).widthIn(min = 20.dp).clip(Shapes.pill).background(background).padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = color, maxLines = 1, modifier = Modifier.clearAndSetSemantics {}) }
}

/**
 * A live call on a row (community-first brief §E, as Meldiq Web): a screen when someone is sharing, a camera for a video
 * call, a speaker for a voice call, with how many people are in it. [video] is the row's own knowledge when the call's
 * details haven't arrived yet.
 */
@Composable
fun LiveCallBadge(live: LiveCall?, video: Boolean, modifier: Modifier = Modifier) {
    val c = Griip.colors
    val isVideo = live?.video ?: video
    val sharing = live?.sharing.orEmpty()
    val kind = stringResource(if (isVideo) R.string.wp_live_video else R.string.wp_live_voice)
    val people = live?.people ?: 0
    val spoken = buildList {
        add(if (people > 0) stringResource(R.string.wp_live_people, kind, people) else kind)
        if (sharing.isNotEmpty()) add(stringResource(R.string.wp_live_sharing_short))
    }.joinToString(", ")
    Row(
        modifier.clip(Shapes.pill).background(c.successSoft).padding(horizontal = 7.dp, vertical = 2.dp).clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val icon = when {
            sharing.isNotEmpty() -> Icons.Rounded.ScreenShare
            isVideo -> Icons.Rounded.Videocam
            else -> Icons.AutoMirrored.Rounded.VolumeUp
        }
        Icon(icon, null, tint = c.success, modifier = Modifier.size(14.dp))
        if (people > 0) {
            Spacer(Modifier.width(3.dp))
            Text("$people", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.success)
        }
    }
}
