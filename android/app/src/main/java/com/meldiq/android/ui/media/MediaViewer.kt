package com.meldiq.android.ui.media

import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.os.Build
import android.widget.ImageView
import android.widget.VideoView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.rounded.BrokenImage
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.rememberReducedMotion
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.io.File

enum class MediaAction { SaveToGallery, SaveToFiles, Share }

private sealed interface PageState {
    data object Loading : PageState
    data class Ready(val file: File) : PageState
    data class Failed(val message: String) : PageState
}

/**
 * Full-screen viewer for the conversation's photos and videos (swipe between them). A tap only toggles the controls;
 * saving and sharing are explicit menu actions (top-right ⋮, or a long press on the media). Back closes the viewer.
 * Media is decrypted on the phone by [load] (the same download, hash and GCM checks as every attachment).
 */
@Composable
fun MediaViewer(
    items: List<MediaItem>,
    startAttachmentId: String,
    senderName: (MediaItem) -> String,
    load: suspend (AttachmentRef) -> File,
    progress: (String) -> Float?,
    canPlayVideo: () -> String?,
    onPlay: () -> Unit,
    onAction: (MediaAction, MediaItem) -> Unit,
    onDismiss: () -> Unit,
    /** The text of the message a photo or video came with, shown under it (2026-10-23). */
    captionOf: (MediaItem) -> String? = { null },
    /** Reacts to that message with an emoji; null where you can't. */
    onReact: ((MediaItem, String) -> Unit)? = null,
) {
    val start = items.indexOfFirst { it.ref.id == startAttachmentId }
    // The photo was deleted (or the list changed so it's gone): there is nothing to show.
    LaunchedEffect(start) { if (start < 0) onDismiss() }
    if (start < 0) return
    LocalSoftwareKeyboardController.current?.hide()
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val pager = rememberPagerState(initialPage = start) { items.size }
        var chrome by remember { mutableStateOf(true) }
        var menu by remember { mutableStateOf(false) }
        val current = items.getOrNull(pager.currentPage)
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, Modifier.fillMaxSize(), key = { items[it].messageId + "/" + items[it].ref.id }) { page ->
                val item = items[page]
                MediaPage(
                    item, active = pager.currentPage == page, load = load, progress = progress(item.ref.id),
                    canPlayVideo = canPlayVideo, onPlay = onPlay,
                    onTap = { chrome = !chrome }, onLongPress = { menu = true },
                )
            }
            AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
                Row(
                    Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.45f)).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onDismiss) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Close", tint = Color.White) }
                    Column(Modifier.weight(1f)) {
                        // Who and when are under the picture now; the top keeps the position in the album.
                        if (items.size > 1) Text("${pager.currentPage + 1} of ${items.size}", style = Griip.type.titleSmall, color = Color.White, maxLines = 1)
                    }
                    Box {
                        IconButton({ menu = true }) { Icon(Icons.Rounded.MoreVert, "More options", tint = Color.White) }
                        DropdownMenu(menu, { menu = false }) {
                            current?.let { item ->
                                DropdownMenuItem({ Text("Save to Gallery") }, { menu = false; onAction(MediaAction.SaveToGallery, item) }, leadingIcon = { Icon(Icons.Outlined.Download, null) })
                                DropdownMenuItem({ Text("Save to Files") }, { menu = false; onAction(MediaAction.SaveToFiles, item) }, leadingIcon = { Icon(Icons.Outlined.FolderOpen, null) })
                                DropdownMenuItem({ Text("Share…") }, { menu = false; onAction(MediaAction.Share, item) }, leadingIcon = { Icon(Icons.Outlined.Share, null) })
                            }
                        }
                    }
                }
            }
            // 2026-10-23 (the reference's viewer): who sent it and when, the message's text, and React.
            AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomCenter)) {
                current?.let { item -> ViewerCaption(item, senderName(item), captionOf(item), onReact) }
            }
        }
    }
}

@Composable
private fun ViewerCaption(item: MediaItem, sender: String, caption: String?, onReact: ((MediaItem, String) -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            sender + "  ·  " + TimeFmt.dayHeader(item.sentAt) + ", " + TimeFmt.clock(item.sentAt),
            style = Griip.type.label, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        caption?.let { Text(it, style = Griip.type.bodySmall, color = Color.White.copy(alpha = 0.9f), maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp)) }
        if (onReact != null) QuickReact({ e -> onReact(item, e) }, Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun MediaPage(
    item: MediaItem,
    active: Boolean,
    load: suspend (AttachmentRef) -> File,
    progress: Float?,
    canPlayVideo: () -> String?,
    onPlay: () -> Unit,
    onTap: () -> Unit,
    onLongPress: () -> Unit,
) {
    var attempt by remember { mutableIntStateOf(0) }
    var state by remember(item.ref.id) { mutableStateOf<PageState>(PageState.Loading) }
    val density = LocalDensity.current
    val config = LocalConfiguration.current
    // Twice the screen's long edge (for zooming), capped: never the full photo in memory.
    val maxEdge = with(density) { (maxOf(config.screenWidthDp, config.screenHeightDp).dp.toPx() * 2).toInt() }.coerceIn(1024, 4096)
    var bitmap by remember(item.ref.id) { mutableStateOf<ImageBitmap?>(null) }
    var drawable by remember(item.ref.id) { mutableStateOf<Drawable?>(null) }
    LaunchedEffect(item.ref.id, attempt) {
        state = PageState.Loading
        bitmap = null; drawable = null
        try {
            val file = load(item.ref)
            if (MediaGallery.kindOf(item.ref) == MediaKind.Image) {
                if (Build.VERSION.SDK_INT >= 28) drawable = MediaExport.decodeDrawable(file, maxEdge)
                else bitmap = MediaExport.decode(file, maxEdge)?.asImageBitmap()
                if (bitmap == null && drawable == null) {
                    state = PageState.Failed("This photo can't be shown: the file is damaged or in a format this phone can't open. You can still save it.")
                    return@LaunchedEffect
                }
            }
            state = PageState.Ready(file)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            state = PageState.Failed(e.friendly())
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when (val s = state) {
            PageState.Loading -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (progress != null) CircularProgressIndicator(progress = { progress }, color = Color.White) else CircularProgressIndicator(color = Color.White)
                Spacer(Modifier.height(12.dp))
                Text(if (progress != null) "Downloading and decrypting… ${(progress * 100).toInt()}%" else "Decrypting…", style = Griip.type.caption, color = Color.White.copy(alpha = 0.8f))
            }
            is PageState.Failed -> Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.BrokenImage, null, tint = Color.White.copy(alpha = 0.7f), modifier = Modifier.size(48.dp))
                Spacer(Modifier.height(12.dp))
                Text(s.message, style = Griip.type.body, color = Color.White, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                Row(
                    Modifier.clip(CircleShape).background(Color.White.copy(alpha = 0.16f)).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton({ attempt++ }) { Icon(Icons.Rounded.Refresh, "Try again", tint = Color.White) }
                }
            }
            is PageState.Ready -> when (MediaGallery.kindOf(item.ref)) {
                MediaKind.Image -> ZoomableImage(bitmap, drawable, active, item.ref.name, onTap, onLongPress)
                MediaKind.Video -> VideoPage(s.file, active, canPlayVideo, onPlay, onTap, onLongPress)
                null -> Unit
            }
        }
    }
}

/**
 * Pinch to zoom (1×–5×), drag to pan while zoomed, double tap to zoom in or back out. One finger at 1× is left to
 * the pager, so swiping still moves between photos; while zoomed, the drag pans the photo instead.
 */
@Composable
private fun ZoomableImage(bitmap: ImageBitmap?, drawable: Drawable?, active: Boolean, description: String, onTap: () -> Unit, onLongPress: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val animate = active && !rememberReducedMotion()
    DisposableEffect(drawable, lifecycle, animate) {
        fun update() {
            (drawable as? Animatable)?.let {
                if (animate && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) it.start() else it.stop()
            }
        }
        val observer = LifecycleEventObserver { _, _ -> update() }
        lifecycle.addObserver(observer)
        update()
        onDispose { lifecycle.removeObserver(observer); (drawable as? Animatable)?.stop() }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        fun clamp(o: Offset, s: Float) = Offset(o.x.coerceIn(-(s - 1) * w / 2, (s - 1) * w / 2), o.y.coerceIn(-(s - 1) * h / 2, (s - 1) * h / 2))
        Box(
            Modifier.fillMaxSize()
                .semantics { contentDescription = "Photo: $description. Double tap to zoom." }
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { onTap() },
                        onLongPress = { onLongPress() },
                        onDoubleTap = { p ->
                            if (scale > 1.01f) {
                                scale = 1f; offset = Offset.Zero
                            } else {
                                scale = 2.5f
                                offset = clamp(Offset((w / 2 - p.x) * 1.5f, (h / 2 - p.y) * 1.5f), 2.5f)
                            }
                        },
                    )
                }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        do {
                            val event = awaitPointerEvent()
                            if (event.changes.size > 1 || scale > 1.01f) {
                                val s = (scale * event.calculateZoom()).coerceIn(1f, 5f)
                                offset = clamp(offset + event.calculatePan(), s)
                                scale = s
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (event.changes.any { it.pressed })
                        if (scale < 1.02f) {
                            scale = 1f; offset = Offset.Zero
                        }
                    }
                }
                .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
        ) {
            if (drawable != null) AndroidView(
                factory = { ImageView(it).apply { scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = description } },
                update = { view ->
                    if (view.drawable !== drawable) view.setImageDrawable(drawable)
                    (drawable as? Animatable)?.let {
                        if (animate && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) it.start() else it.stop()
                    }
                },
                onRelease = { (it.drawable as? Animatable)?.stop(); it.setImageDrawable(null) },
                modifier = Modifier.fillMaxSize(),
            ) else bitmap?.let { Image(it, description, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
        }
    }
}

/** A video in the platform player (streams from the decrypted file), with play/pause, a seek bar and the time. */
@Composable
private fun VideoPage(file: File, active: Boolean, canPlay: () -> String?, onPlay: () -> Unit, onTap: () -> Unit, onLongPress: () -> Unit) {
    var view by remember { mutableStateOf<VideoView?>(null) }
    var playing by remember { mutableStateOf(false) }
    var duration by remember { mutableIntStateOf(0) }
    var position by remember { mutableIntStateOf(0) }
    var failed by remember { mutableStateOf(false) }
    var blocked by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(active) {
        if (!active) {
            view?.pause(); playing = false
        }
    }
    LaunchedEffect(playing) {
        while (playing) {
            position = view?.currentPosition ?: 0
            delay(250)
        }
    }
    DisposableEffect(Unit) { onDispose { view?.stopPlayback() } }
    fun toggle() {
        val v = view ?: return
        if (playing) {
            v.pause(); playing = false
        } else {
            blocked = canPlay()
            if (blocked != null) return
            onPlay()
            v.start(); playing = true
        }
    }
    Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onTap = { onTap() }, onLongPress = { onLongPress() }) }, contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    setOnPreparedListener { mp -> duration = mp.duration; seekTo(1) } // shows the first frame
                    setOnCompletionListener { playing = false; position = duration }
                    setOnErrorListener { _, _, _ -> failed = true; playing = false; true }
                    setVideoPath(file.path)
                    view = this
                }
            },
            onRelease = { it.stopPlayback() },
            modifier = Modifier.align(Alignment.Center),
        )
        if (failed) {
            Text("This video can't be played on this phone. You can still save it.", style = Griip.type.body, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp))
        } else {
            Box(
                Modifier.size(72.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f))
                    .pointerInput(Unit) { detectTapGestures(onTap = { toggle() }) },
                contentAlignment = Alignment.Center,
            ) { Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause video" else "Play video", tint = Color.White, modifier = Modifier.size(40.dp)) }
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.45f)).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 16.dp, vertical = 8.dp)) {
                blocked?.let { Text(it, style = Griip.type.caption, color = Color.White) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(TimeFmt.duration(position / 1000L), style = Griip.type.caption, color = Color.White)
                    Slider(
                        value = if (duration > 0) position.toFloat() / duration else 0f,
                        onValueChange = { f -> position = (f * duration).toInt(); view?.seekTo(position) },
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                        colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Color.White),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(TimeFmt.duration(duration / 1000L), style = Griip.type.caption, color = Color.White)
                }
            }
        }
    }
}
