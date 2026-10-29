package com.meldiq.android.ui.components

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.rememberReducedMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A workspace's mark: its avatar when it has one ([photoRev], servers with `org-photos`), otherwise its initials on its
 * colour ([MarkTile]), which also show while the photo loads. Same rounded tile shape either way.
 */
@Composable
fun OrgMark(orgId: String, name: String, colorIndex: Int, photoRev: Long?, modifier: Modifier = Modifier, size: Dp = 48.dp) {
    val container = LocalContainer.current
    val key = if (photoRev != null) "$orgId@$photoRev" else null
    val still = rememberReducedMotion()
    // API 0.64.0: an animated icon (GIF or WebP) plays, except with reduced motion or before Android 9.
    val moving by produceState<java.io.File?>(null, key, still) {
        if (key == null || still || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.P) return@produceState
        val file = runCatching { container.profiles.orgPhoto(orgId, photoRev!!) }.getOrNull() ?: return@produceState
        if (withContext(Dispatchers.IO) { isAnimatableImage(file) }) value = file
    }
    val photo by produceState(key?.let { AvatarMemory.get(it) }, key) {
        if (key == null || value != null) return@produceState
        val file = runCatching { container.profiles.orgPhoto(orgId, photoRev!!) }.getOrNull() ?: return@produceState
        value = withContext(Dispatchers.IO) { BitmapFactory.decodeFile(file.path)?.asImageBitmap() }?.also { AvatarMemory.put(key, it) }
    }
    moving?.let {
        AnimatedImageIn(it, name, modifier.size(size).clip(Shapes.iconTile))
        return
    }
    val p = photo
    if (p == null) {
        MarkTile(name, colorIndex, modifier, size)
        return
    }
    Image(
        p, null, contentScale = ContentScale.Crop,
        modifier = modifier.size(size).clip(Shapes.iconTile).semantics { contentDescription = name },
    )
}
