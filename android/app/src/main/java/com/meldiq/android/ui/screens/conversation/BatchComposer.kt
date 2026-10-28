package com.meldiq.android.ui.screens.conversation

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Size
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.data.model.AttachmentPolicy
import com.meldiq.android.data.model.AttachmentPolicy.Quality
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The send preview for picked photos, videos and files (2026-10-17, docs/ATTACHMENTS.md): every file with a remove button,
 * the quality for photos and videos, one caption, and what the safety checks found. Nothing is uploaded until Send.
 */
@Composable
fun BatchComposer(
    items: List<ConversationViewModel.Candidate>,
    note: String?,
    onRemove: (Uri) -> Unit,
    onAddMore: () -> Unit,
    onSend: (photoQuality: Quality, videoQuality: Quality, caption: String) -> Unit,
    onDismiss: () -> Unit,
    maxFile: Long = AttachmentPolicy.MAX_FILE_BYTES,
    defaultPhotoQuality: Quality = Quality.STANDARD,
    defaultVideoQuality: Quality = Quality.ORIGINAL,
) {
    val c = Griip.colors
    // Photos start at Standard and videos at Original unless Settings › Chats says otherwise; files are never compressed.
    var quality by rememberSaveable { mutableStateOf(defaultPhotoQuality) }
    var videoQuality by rememberSaveable { mutableStateOf(defaultVideoQuality) }
    var caption by rememberSaveable { mutableStateOf("") }
    val qualityOf = { k: AttachmentPolicy.Kind -> if (k == AttachmentPolicy.Kind.VIDEO) videoQuality else quality }
    val verdicts = items.map { AttachmentPolicy.check(it.item.kind, it.item.sniffed, it.item.size, qualityOf(it.item.kind), maxFile, it.item.durationMs) }
    val sendable = verdicts.count { it.sendable }
    val risky = items.filterIndexed { i, it -> it.risk != null && verdicts[i].sendable }
    // Compressed videos that will probably still be over the limit: said now, before a long compression (UI-003).
    val oversized = verdicts.filterIsInstance<AttachmentPolicy.Verdict.MayBeTooLarge>()
    val photos = items.any { it.item.kind == AttachmentPolicy.Kind.PHOTO && AttachmentPolicy.compressible(it.item.kind, it.item.sniffed) }
    val videos = items.any { it.item.kind == AttachmentPolicy.Kind.VIDEO && AttachmentPolicy.compressible(it.item.kind, it.item.sniffed) }
    val estimates = items.filterIndexed { i, _ -> verdicts[i].sendable }
        .map { AttachmentPolicy.estimate(it.item.kind, it.item.sniffed, it.item.size, it.item.durationMs, qualityOf(it.item.kind)) }
    val estimate = if (estimates.isNotEmpty() && estimates.all { it != null }) estimates.sumOf { it!! } else null
    val title = when {
        items.all { it.item.kind == AttachmentPolicy.Kind.PHOTO } -> if (items.size == 1) "Send photo" else "Send ${items.size} photos"
        items.all { it.item.kind == AttachmentPolicy.Kind.VIDEO } -> if (items.size == 1) "Send video" else "Send ${items.size} videos"
        items.all { it.item.kind == AttachmentPolicy.Kind.FILE } -> if (items.size == 1) "Send file" else "Send ${items.size} files"
        else -> "Send ${items.size} items"
    }
    GlassSheet(onDismiss, title = title) {
        LazyRow(contentPadding = PaddingValues(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(items.size, key = { items[it].item.uri.toString() }) { i ->
                CandidateTile(items[i], verdicts[i], onRemove)
            }
            if (items.size < AttachmentPolicy.MAX_ITEMS) item(key = "add") {
                Box(
                    Modifier.size(96.dp).clip(Shapes.tile).border(1.dp, c.border, Shapes.tile).pressable(onAddMore, onClickLabel = "Add more"),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Rounded.Add, null, tint = c.primary)
                        Text("${items.size}/${AttachmentPolicy.MAX_ITEMS}", style = Griip.type.caption, color = c.textSecondary)
                    }
                }
            }
        }
        note?.let { Text(it, style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) }
        if (photos) {
            Spacer(Modifier.height(12.dp))
            Text("Photo quality", style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = 4.dp))
            ChipRow(Modifier.padding(horizontal = 0.dp)) {
                Quality.entries.forEach { q -> PillChip(q.label, quality == q, { quality = q }) }
            }
            Text(
                when (quality) {
                    Quality.STANDARD -> "Smaller and quicker: up to 1600 px, re-encoded without camera metadata or location."
                    Quality.HD -> "Sharper, larger: up to 4096 px, re-encoded without camera metadata or location."
                    Quality.ORIGINAL -> "Exactly as it is, including any location saved in the photo."
                },
                style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        if (videos) {
            Spacer(Modifier.height(12.dp))
            Text("Video quality", style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = 4.dp))
            ChipRow(Modifier.padding(horizontal = 0.dp)) {
                listOf(Quality.ORIGINAL, Quality.HD, Quality.STANDARD).forEach { q ->
                    PillChip(when (q) { Quality.ORIGINAL -> "Original"; Quality.HD -> "Compress (1080p)"; else -> "Compress (720p)" }, videoQuality == q, { videoQuality = q })
                }
            }
            Text(
                if (videoQuality == Quality.ORIGINAL) "Sent exactly as it is." else "Re-encoded on this phone before sending; this takes a while for long videos.",
                style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        Text(
            (estimate?.let { "About ${AttachmentPolicy.sizeLabel(it)} to send · " } ?: "") + "this server takes up to ${AttachmentPolicy.sizeLabel(maxFile)} per file",
            style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 8.dp, start = 4.dp),
        )
        oversized.firstOrNull()?.let { v ->
            Text(v.reason, style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 6.dp, start = 4.dp))
        }
        if (risky.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Column(Modifier.fillMaxWidth().clip(Shapes.tile).background(c.warningSoft).padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Warning, null, tint = c.warning, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Check before sending", style = Griip.type.label, color = c.warning)
                }
                risky.forEach { Text("“${it.item.name}”: ${it.risk}", style = Griip.type.caption, color = c.textPrimary, modifier = Modifier.padding(top = 4.dp)) }
                Text(
                    "Meldiq doesn't scan files for viruses. Only send files you trust.",
                    style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        GriipTextField(
            caption, { caption = it.take(2000) }, "Caption", Modifier.fillMaxWidth(), placeholder = "Add a caption (optional)",
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        Spacer(Modifier.height(12.dp))
        val excluded = items.size - sendable
        if (excluded > 0) {
            Text(
                if (excluded == 1) "1 file can't be sent and will be left out." else "$excluded files can't be sent and will be left out.",
                style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(bottom = 8.dp, start = 4.dp),
            )
        }
        PillButton(
            when {
                sendable == 0 -> "Nothing to send"
                risky.isNotEmpty() -> "Send anyway"
                sendable == 1 -> "Send"
                else -> "Send $sendable"
            },
            { onSend(quality, videoQuality, caption) }, Modifier.fillMaxWidth(), enabled = sendable > 0,
        )
        Text(
            "Encrypted on this phone before upload.",
            style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 8.dp, bottom = Space.gutter).align(Alignment.CenterHorizontally),
        )
    }
}

@Composable
private fun CandidateTile(cand: ConversationViewModel.Candidate, verdict: AttachmentPolicy.Verdict, onRemove: (Uri) -> Unit) {
    val c = Griip.colors
    val ctx = LocalContext.current
    val item = cand.item
    val thumb by produceState<ImageBitmap?>(null, item.uri) { value = withContext(Dispatchers.IO) { thumbnail(ctx, item.uri, item.kind) }?.asImageBitmap() }
    val bad = verdict as? AttachmentPolicy.Verdict.TooLarge
    val big = verdict as? AttachmentPolicy.Verdict.MayBeTooLarge
    Box(
        Modifier.size(96.dp).clip(Shapes.tile).background(c.surfaceVariant)
            .semantics {
                contentDescription = item.name + (bad?.let { ", can't be sent: ${it.reason}" } ?: "") + (big?.let { ", ${it.reason}" } ?: "") + (cand.risk?.let { ", $it" } ?: "")
            },
    ) {
        val t = thumb
        if (t != null) Image(t, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Column(Modifier.fillMaxSize().padding(8.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.AutoMirrored.Rounded.InsertDriveFile, null, tint = c.primary)
            Text(item.name, style = Griip.type.caption, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (item.kind == AttachmentPolicy.Kind.VIDEO && t != null) {
            Box(Modifier.align(Alignment.Center).size(30.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(20.dp))
            }
        }
        if (bad != null || big != null || cand.risk != null) {
            Text(
                when { bad != null -> "Can't send"; big != null -> "May be too big"; else -> "Check" },
                style = Griip.type.caption, color = Color.White,
                modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth().background(if (bad != null) c.danger else c.warning).padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        Box(
            Modifier.align(Alignment.TopEnd).padding(4.dp).size(26.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f))
                .pressable({ onRemove(item.uri) }, onClickLabel = "Remove ${item.name}"),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Rounded.Close, null, tint = Color.White, modifier = Modifier.size(16.dp)) }
    }
}

/** A small preview of a picked photo or video (null for other files or when it can't be read). */
private fun thumbnail(ctx: Context, uri: Uri, kind: AttachmentPolicy.Kind): Bitmap? = runCatching {
    if (kind == AttachmentPolicy.Kind.FILE) return null
    if (Build.VERSION.SDK_INT >= 29) return ctx.contentResolver.loadThumbnail(uri, Size(256, 256), null)
    if (kind == AttachmentPolicy.Kind.VIDEO) {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(ctx, uri)
            r.getFrameAtTime(0)?.let { Bitmap.createScaledBitmap(it, 256, 256 * it.height / it.width.coerceAtLeast(1), true) }
        } finally {
            runCatching { r.release() }
        }
    } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val opts = BitmapFactory.Options().apply { inSampleSize = com.meldiq.android.ui.media.MediaGallery.sampleSize(bounds.outWidth, bounds.outHeight, 256) }
        ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
    }
}.getOrNull()
