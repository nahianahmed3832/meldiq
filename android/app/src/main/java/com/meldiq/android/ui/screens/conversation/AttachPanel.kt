package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.ContactPage
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.model.AttachmentPolicy
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** What the attach panel can open. */
enum class AttachAction { Gallery, Camera, RecordVideo, Files, Contact, Location, Poll }

/**
 * The attach panel (UI-003): six tiles in two rows instead of a long list, the gallery first, then the camera, a
 * recorded video and files; contact and location below. Inspired by the owner's Discord reference (an inline panel of
 * large targets), drawn in Meldiq's palette and components. It doesn't show the phone's photos inline: that needs the
 * broad photo permission (READ_MEDIA_IMAGES/VIDEO), which Meldiq doesn't ask for; the system photo picker opens instead,
 * and Meldiq only sees what is picked. The limits shown are this server's, read from `/v1/server-info`.
 */
@Composable
fun AttachPanel(maxFile: Long, onAction: (AttachAction) -> Unit, onDismiss: () -> Unit) {
    val c = Griip.colors
    GlassSheet(onDismiss, title = stringResource(R.string.attach_title)) {
        val tiles = listOf(
            Tile(AttachAction.Gallery, Icons.Outlined.Image, stringResource(R.string.attach_media), c.peach, c.peachSoft),
            Tile(AttachAction.Camera, Icons.Outlined.PhotoCamera, stringResource(R.string.attach_camera), c.primary, c.primarySoft),
            Tile(AttachAction.RecordVideo, Icons.Outlined.Videocam, stringResource(R.string.attach_video), c.primary, c.primarySoft),
            Tile(AttachAction.Files, Icons.Outlined.Description, stringResource(R.string.attach_files), c.lavender, c.lavenderSoft),
            Tile(AttachAction.Contact, Icons.Outlined.ContactPage, stringResource(R.string.attach_contact), c.lavender, c.lavenderSoft),
            Tile(AttachAction.Location, Icons.Outlined.LocationOn, stringResource(R.string.attach_location), c.success, c.successSoft),
            Tile(AttachAction.Poll, Icons.Outlined.BarChart, stringResource(R.string.poll_label), c.primary, c.primarySoft),
        )
        tiles.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { t -> AttachTile(t, Modifier.weight(1f)) { onAction(t.action) } }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(AttachPanelText.limits(maxFile), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp))
        AttachPanelText.smallServerHint(maxFile)?.let {
            Text(it, style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 6.dp, start = 4.dp, end = 4.dp))
        }
        Row(Modifier.padding(top = 10.dp, start = 4.dp, bottom = Space.gutter), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Lock, null, tint = c.textTertiary, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text("Encrypted on this phone before upload.", style = Griip.type.caption, color = c.textTertiary)
        }
    }
}

private data class Tile(val action: AttachAction, val icon: ImageVector, val label: String, val tint: Color, val tintBg: Color)

@Composable
private fun AttachTile(t: Tile, modifier: Modifier, onClick: () -> Unit) {
    val c = Griip.colors
    Column(
        modifier.clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card)
            .pressable(onClick, onClickLabel = t.label, role = Role.Button).padding(vertical = 14.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconTile(t.icon, t.tint, t.tintBg, size = 48.dp)
        Spacer(Modifier.height(8.dp))
        Text(t.label, style = Griip.type.label, color = c.textPrimary, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** The panel's words (unit-tested in `AttachPanelTextTest`): limits from the server, never a fixed 25 MB. */
object AttachPanelText {
    fun limits(maxFile: Long): String =
        "Up to ${AttachmentPolicy.MAX_ITEMS} at once, ${AttachmentPolicy.sizeLabel(maxFile)} per file on this server. " +
            "Photos and videos are optimized by default. Select Original file to send unchanged."

    /** Servers still at the old 25 MB limit: big videos only go compressed, so say so before the person picks one. */
    fun smallServerHint(maxFile: Long): String? =
        if (maxFile <= AttachmentPolicy.LEGACY_MAX_FILE_BYTES) {
            "Videos are compressed automatically. Long videos may still exceed this server limit."
        } else {
            null
        }
}
