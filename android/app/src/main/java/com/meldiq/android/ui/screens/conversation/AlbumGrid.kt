package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.repo.AttachmentFiles
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.media.MediaExport
import com.meldiq.android.ui.media.MediaGallery
import com.meldiq.android.ui.media.MediaKind
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import java.io.File

/** How an album of photos and videos is laid out in a bubble (unit-tested in `AttachmentPolicyTest`). */
object Album {
    /** Rows of tile indexes: 2 → one row of two; 3 → one wide, then two; 4 or more → two rows of two. */
    fun rows(count: Int): List<List<Int>> = when {
        count <= 0 -> emptyList()
        count == 1 -> listOf(listOf(0))
        count == 2 -> listOf(listOf(0, 1))
        count == 3 -> listOf(listOf(0), listOf(1, 2))
        else -> listOf(listOf(0, 1), listOf(2, 3))
    }

    /** How many more than the grid shows ("+N" on the last tile). */
    fun overflow(count: Int): Int = (count - 4).coerceAtLeast(0)
}

/**
 * Several photos and videos sent together (2026-10-17): a grid of up to four tiles, the last showing how many more there
 * are. Each tile opens the viewer, which swipes through all of them. While the album is being sent, tiles not uploaded
 * yet show the overall progress.
 */
@Composable
fun AlbumGrid(items: List<AttachmentRef>, transfer: Float?, localFile: (AttachmentRef) -> File?, onOpen: (AttachmentRef) -> Unit) {
    val gap = 3.dp
    val width = 260.dp
    val overflow = Album.overflow(items.size)
    Column(Modifier.width(width).clip(Shapes.tile), verticalArrangement = Arrangement.spacedBy(gap)) {
        val rows = Album.rows(items.size)
        rows.forEachIndexed { r, row ->
            Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                row.forEach { i ->
                    val tileWidth = if (row.size == 1) width else (width - gap) / 2
                    val last = r == rows.lastIndex && i == row.last()
                    AlbumTile(items[i], tileWidth, if (row.size == 1) 150.dp else 128.dp, transfer, localFile(items[i]) ?: items[i].thumbnail?.asAttachment()?.let(localFile), if (last) overflow else 0, onOpen, localFile(items[i]) == null && items[i].thumbnail?.asAttachment()?.let(localFile) != null)
                }
            }
        }
    }
}

@Composable
private fun AlbumTile(a: AttachmentRef, w: Dp, h: Dp, transfer: Float?, local: File?, more: Int, onOpen: (AttachmentRef) -> Unit, isThumbnail: Boolean = false) {
    val c = Griip.colors
    val kind = MediaGallery.visualKind(a)
    val pending = a.id == AttachmentFiles.PENDING
    val bitmap by produceState<ImageBitmap?>(null, local?.path, local?.length()) {
        value = when {
            local == null || !local.exists() -> null
            kind == MediaKind.Video && !isThumbnail -> MediaExport.videoFrame(local, 512)?.asImageBitmap()
            else -> MediaExport.decode(local, 512)?.asImageBitmap()
        }
    }
    val label = (if (kind == MediaKind.Video) "Video" else "Photo") + if (more > 0) ", and $more more" else ""
    Box(
        Modifier.width(w).height(h).background(c.surfaceVariant)
            .pressable(if (pending) null else ({ onOpen(a) }), onClickLabel = if (kind == MediaKind.Video) "Play video" else "View photo")
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        val bmp = bitmap
        if (bmp != null) Image(bmp, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else if (!pending) Icon(Icons.Rounded.Download, null, tint = c.primary)
        if (kind == MediaKind.Video && bmp != null && more == 0) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(26.dp))
            }
        }
        if (pending) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                if (transfer != null) CircularProgressIndicator(progress = { transfer }, modifier = Modifier.size(32.dp), color = Color.White, strokeWidth = 3.dp)
                else CircularProgressIndicator(modifier = Modifier.size(28.dp), color = Color.White, strokeWidth = 3.dp)
            }
        }
        if (more > 0) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                Text("+$more", style = Griip.type.titleSmall, color = Color.White)
            }
        }
    }
}
