package com.meldiq.android.ui.components

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.os.Build
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.meldiq.android.R
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.data.model.PersonLook
import com.meldiq.android.data.model.ProfileStyleDto
import com.meldiq.android.data.model.WornTag
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.rememberReducedMotion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Name styles, community tags, avatar frames and animated avatars (API 0.45.0–0.46.0), drawn as Meldiq Web draws them
 * (people/NameStyle.tsx, styles/profile.css): Meldiq's own fonts, colours and frames. Reduced motion keeps all of it
 * still.
 */

/** The font a name style uses, scaled so a styled name sits in the same line as a plain one (as the web's sizes). */
private fun nameFont(id: String?): Pair<FontFamily, Float>? = when (id) {
    "pixel" -> FontFamily(Font(R.font.name_pixel)) to 0.98f
    "arcade" -> FontFamily(Font(R.font.name_arcade)) to 0.66f
    "script" -> FontFamily(Font(R.font.name_script)) to 1.05f
    "block" -> FontFamily(Font(R.font.name_block)) to 0.9f
    "tech" -> FontFamily(Font(R.font.name_tech, FontWeight.Bold)) to 0.92f
    "mono" -> FontFamily.Monospace to 0.95f
    else -> null
}

/** The shimmer's travel across the name: one pass, then again. */
private const val SHIMMER_MS = 3200
private const val PULSE_MS = 1200

/**
 * A display name with the person's style, then the tag they wear. [roleColor] paints it when they chose no colour.
 * Screen readers hear the name, then "tag MC".
 */
@Composable
fun StyledName(
    name: String,
    look: PersonLook?,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    roleColor: Color? = null,
    maxLines: Int = 1,
) {
    val s = look?.style
    val colors = LookRules.nameColors(s).map { Color(it) }
    val font = nameFont(s?.nameFont)
    val still = rememberReducedMotion()
    val effect = s?.nameEffect
    var textStyle = style
    if (font != null) {
        val (family, scale) = font
        val size = if (style.fontSize.isSpecified) style.fontSize * scale else (14 * scale).sp
        textStyle = textStyle.copy(fontFamily = family, fontSize = size, fontWeight = if (s?.nameFont == "tech") FontWeight.Bold else if (s?.nameFont == "mono") style.fontWeight else FontWeight.Normal)
    }
    val solid = colors.singleOrNull() ?: roleColor?.takeIf { colors.isEmpty() } ?: color.takeIf { colors.isEmpty() }
    if (colors.size > 1) {
        val shift = if (effect == "shimmer" && !still) {
            val t = rememberInfiniteTransition(label = "nameShimmer")
            t.animateFloat(0f, 1f, infiniteRepeatable(tween(SHIMMER_MS, easing = LinearEasing)), label = "shimmer").value
        } else 0f
        val width = 240f
        textStyle = textStyle.copy(brush = Brush.linearGradient(colors, start = Offset(shift * 2 * width, 0f), end = Offset(shift * 2 * width + width, 0f), tileMode = TileMode.Mirror))
        if (effect == "glow") textStyle = textStyle.copy(shadow = Shadow(Color.White.copy(alpha = 0.28f), blurRadius = 12f))
    } else if (effect == "glow" && solid != null) {
        textStyle = textStyle.copy(shadow = Shadow(solid.copy(alpha = 0.55f), blurRadius = 14f))
    }
    val alpha = if (effect == "shimmer" && colors.size <= 1 && !still) {
        val t = rememberInfiniteTransition(label = "namePulse")
        t.animateFloat(1f, 0.72f, infiniteRepeatable(tween(PULSE_MS), RepeatMode.Reverse), label = "pulse").value
    } else 1f
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(
            name, style = textStyle, color = if (colors.size > 1) Color.Unspecified else (solid ?: color).copy(alpha = (solid ?: color).alpha * alpha),
            maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
        )
        look?.tag?.let { WornTagChip(it, Modifier.padding(start = 6.dp)) }
    }
}

/** The tag a person wears: the community's letters on its accent (as the web's `.wtag`). */
@Composable
fun WornTagChip(tag: WornTag, modifier: Modifier = Modifier) {
    val c = Griip.colors
    val accent = LookRules.argb(tag.color)?.let { Color(it) } ?: c.textTertiary
    val label = androidx.compose.ui.res.stringResource(R.string.wp_tag_label, tag.text)
    Box(
        modifier.clip(RoundedCornerShape(6.dp)).background(accent.copy(alpha = 0.18f)).border(1.dp, accent.copy(alpha = 0.45f), RoundedCornerShape(6.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp).semantics { contentDescription = label },
    ) {
        Text(tag.text, style = Griip.type.caption.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = 0.04.em, fontSize = 10.5.sp), color = c.textSecondary, maxLines = 1)
    }
}

/** Each frame's colours (styles/profile.css `.deco-*`), drawn as a ring just outside the avatar. */
private fun frameColors(decoration: String): List<Color>? = when (decoration) {
    "aurora" -> listOf(0xFF22D3EE, 0xFF6366F1, 0xFFA855F7, 0xFFEC4899, 0xFF22D3EE)
    "ember" -> listOf(0xFFF97316, 0xFFEF4444, 0xFFFACC15, 0xFFF97316, 0xFFEF4444, 0xFFF97316)
    "frost" -> listOf(0xFFBAE6FD, 0xFF60A5FA, 0xFFE0F2FE, 0xFFBAE6FD)
    "neon" -> listOf(0xFFF0ABFC, 0xFF22D3EE, 0xFFF0ABFC)
    "sakura" -> listOf(0xFFFDA4AF, 0xFFF9A8D4, 0xFFFBCFE8, 0xFFFDA4AF)
    "pixel" -> listOf(0xFFFACC15, 0xFF22C55E, 0xFFFACC15, 0xFF22C55E, 0xFFFACC15)
    else -> null
}?.map { Color(it) }

private const val FRAME_SPIN_MS = 6000

/**
 * An avatar frame around [content] of [size]: a classic frame is a ring 7% outside it, never over the face; since API
 * 0.60.0 a decoration can also be an image (Meldiq's own or a community one), drawn over the avatar 1.2 times its size.
 * Decorative.
 */
@Composable
fun AvatarFrame(decoration: String?, size: Dp, content: @Composable () -> Unit) {
    if (com.meldiq.android.data.model.DecorationRules.isImage(decoration)) {
        Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            content()
            DecorationImage(decoration!!, size)
        }
        return
    }
    val colors = decoration?.let(::frameColors)
    if (colors == null) {
        content()
        return
    }
    val still = rememberReducedMotion()
    val angle = if (decoration == "aurora" && !still) {
        rememberInfiniteTransition(label = "frame").animateFloat(0f, 360f, infiniteRepeatable(tween(FRAME_SPIN_MS, easing = LinearEasing)), label = "spin").value
    } else 0f
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        content()
        Canvas(Modifier.size(size * 1.14f).rotate(angle)) {
            val stroke = (this.size.minDimension * 0.06f).coerceAtLeast(2.5f)
            if (decoration == "pixel") {
                drawRoundRect(Brush.sweepGradient(colors), cornerRadius = androidx.compose.ui.geometry.CornerRadius(this.size.minDimension * 0.22f), style = Stroke(stroke))
            } else {
                if (decoration == "neon" || decoration == "ember") drawCircle(Brush.sweepGradient(colors), radius = this.size.minDimension / 2 - stroke / 2, alpha = 0.35f, style = Stroke(stroke * 2.2f))
                drawCircle(Brush.sweepGradient(colors), radius = this.size.minDimension / 2 - stroke / 2, style = Stroke(stroke))
            }
        }
    }
}

/**
 * A person as lists and messages show them (API 0.46.0): their animated avatar when they chose one (GIF or WebP play on
 * Android 9+; a video avatar shows its still frame), framed when they chose a frame; otherwise exactly [UserAvatar].
 */
@Composable
fun LookAvatar(
    userId: String?,
    name: String,
    colorIndex: Int,
    photoRev: Long?,
    look: PersonLook?,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    online: Boolean? = null,
    presence: String? = null,
) {
    val media = look?.avatarMedia
    AvatarFrame(look?.style?.decoration, size) {
        if (userId == null || media == null) {
            UserAvatar(userId, name, colorIndex, photoRev, modifier, size, online, presence)
            return@AvatarFrame
        }
        val container = LocalContainer.current
        val still = rememberReducedMotion()
        val file by produceState<java.io.File?>(null, userId, media.rev, media.kind) {
            value = runCatching { container.profiles.avatarMedia(userId, media) }.getOrNull()
        }
        val f = file
        if (f == null || still || media.kind == "video" || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            // A still: the photo (or the clip's poster frame, which the media file is for a video avatar).
            if (f != null && (media.kind == "video" || still)) StillImage(f, name, size, modifier)
            else UserAvatar(userId, name, colorIndex, photoRev, modifier, size, online, presence)
            return@AvatarFrame
        }
        AnimatedImage(f, name, size, modifier)
    }
}

/**
 * An image decoration over an avatar of [size] (API 0.60.0): 1.2 times as large, centred, allowed outside the avatar's
 * bounds; it plays when animated (Android 9+, not with reduced motion), and is simply absent until it loads.
 */
@Composable
fun DecorationImage(id: String, size: Dp, file: java.io.File? = null) {
    val container = LocalContainer.current
    val still = rememberReducedMotion()
    val loaded by produceState(file, id, file) {
        if (file == null) value = runCatching { container.profiles.decorationImage(id) }.getOrNull()
    }
    val f = loaded ?: return
    val side = size * com.meldiq.android.data.model.DecorationRules.SCALE
    val m = Modifier.requiredSize(side)
    if (still || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
        val bmp by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, f) {
            value = withContext(Dispatchers.IO) { android.graphics.BitmapFactory.decodeFile(f.path)?.asImageBitmapSafe() }
        }
        bmp?.let { androidx.compose.foundation.Image(it, null, modifier = m) }
    } else {
        AnimatedImageIn(f, null, m, fit = true)
    }
}

@Composable
private fun StillImage(file: java.io.File, name: String, size: Dp, modifier: Modifier) {
    val bmp by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, file) {
        value = withContext(Dispatchers.IO) { android.graphics.BitmapFactory.decodeFile(file.path)?.asImageBitmapSafe() }
    }
    val b = bmp ?: return Box(modifier.size(size).clip(CircleShape).background(Griip.colors.surfaceVariant))
    androidx.compose.foundation.Image(
        b, name, contentScale = androidx.compose.ui.layout.ContentScale.Crop, modifier = modifier.size(size).clip(CircleShape),
    )
}

private fun android.graphics.Bitmap.asImageBitmapSafe() = asImageBitmap()

/** A GIF or WebP that plays (Android 9+), silent and looping, clipped to a circle. */
@Composable
private fun AnimatedImage(file: java.io.File, name: String, size: Dp, modifier: Modifier) =
    AnimatedImageIn(file, name, modifier.size(size).clip(CircleShape))

/** A GIF or WebP that plays (Android 9+), filling [modifier]'s bounds (or fitting inside them); a still picture on older Android. */
@Composable
private fun AnimatedImageIn(file: java.io.File, name: String?, modifier: Modifier, fit: Boolean = false) {
    val drawable by produceState<android.graphics.drawable.Drawable?>(null, file) {
        value = withContext(Dispatchers.IO) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) null
            else runCatching { ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) }.getOrNull()
        }
    }
    val d = drawable ?: return Box(if (fit) modifier else modifier.background(Griip.colors.surfaceVariant))
    AndroidView(
        factory = { ctx -> android.widget.ImageView(ctx).apply { scaleType = if (fit) android.widget.ImageView.ScaleType.FIT_CENTER else android.widget.ImageView.ScaleType.CENTER_CROP; contentDescription = name } },
        update = { v ->
            v.setImageDrawable(d)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) (d as? AnimatedImageDrawable)?.start()
        },
        modifier = modifier,
    )
}

/** The banner's height on a profile card. */
val ProfileBannerHeight = 112.dp
private const val EFFECT_MS = 2200

/**
 * A profile's banner (API 0.45.0): their picture (a GIF or WebP plays; a still with reduced motion), else their banner
 * colour, else Meldiq's own gradient, with the effect they chose drawn over it, never over the name or the avatar.
 */
@Composable
fun ProfileBannerView(userId: String, banner: com.meldiq.android.data.model.MediaRef?, style: ProfileStyleDto?, modifier: Modifier = Modifier) {
    val container = LocalContainer.current
    val still = rememberReducedMotion()
    val accent = LookRules.argb(style?.accent)?.let { Color(it) }
    val ground = if (accent != null) Brush.linearGradient(listOf(accent, accent.copy(alpha = 0.75f))) else Brush.linearGradient(listOf(Color(0xFF1E3A8A), Color(0xFF6D28D9)))
    val file by produceState<java.io.File?>(null, userId, banner?.rev) {
        value = banner?.let { runCatching { container.profiles.profileBanner(userId, it) }.getOrNull() }
    }
    Box(modifier.background(ground)) {
        val f = file
        if (f != null) {
            if (banner?.kind != "jpeg" && !still) AnimatedImageIn(f, null, Modifier.matchParentSize())
            else StillFill(f, Modifier.matchParentSize())
        }
        style?.effect?.let { BannerEffect(it, still, Modifier.matchParentSize()) }
    }
}

@Composable
private fun StillFill(file: java.io.File, modifier: Modifier) {
    val bmp by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, file) {
        value = withContext(Dispatchers.IO) { android.graphics.BitmapFactory.decodeFile(file.path)?.asImageBitmapSafe() }
    }
    bmp?.let { androidx.compose.foundation.Image(it, null, contentScale = androidx.compose.ui.layout.ContentScale.Crop, modifier = modifier) }
}

/** The four banner effects (styles/profile.css `.fx-*`), drawn as Meldiq's own simple shapes. Decorative. */
@Composable
private fun BannerEffect(effect: String, still: Boolean, modifier: Modifier) {
    val phase = if (still) 0.5f else rememberInfiniteTransition(label = "bannerFx").animateFloat(0f, 1f, infiniteRepeatable(tween(EFFECT_MS * 3, easing = LinearEasing)), label = "fx").value
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        when (effect) {
            "sparkles" -> {
                val pulse = if (still) 1f else 0.35f + 0.65f * kotlin.math.abs(kotlin.math.sin(phase * Math.PI.toFloat() * 3))
                listOf(0.12f to 0.3f, 0.34f to 0.7f, 0.58f to 0.25f, 0.8f to 0.6f, 0.92f to 0.2f).forEachIndexed { i, (x, y) ->
                    drawCircle(Color.White.copy(alpha = if (i % 2 == 0) pulse else 1.35f - pulse), radius = if (i == 2) 3f else 2.2f, center = Offset(x * w, y * h))
                }
            }
            "glow" -> drawRect(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.28f), Color.Transparent), center = Offset(w * (0.3f + 0.4f * phase), h / 2), radius = w * 0.6f))
            "stars" -> {
                val step = 34.dp.toPx()
                val drift = (phase * 10 * step) % step
                var y = -step + (step - drift)
                while (y < h + step) {
                    var x = 0f
                    while (x < w + step) {
                        drawCircle(Color.White, radius = 1.4f, center = Offset(x, y))
                        drawCircle(Color.White.copy(alpha = 0.7f), radius = 1.4f, center = Offset(x + step / 2, y + step / 2))
                        x += step
                    }
                    y += step
                }
            }
            "bubbles" -> listOf(0.2f to 8f, 0.55f to 6f, 0.8f to 10f).forEachIndexed { i, (x, r) ->
                val travel = ((phase + i * 0.33f) % 1f)
                drawCircle(Color.White.copy(alpha = 0.33f), radius = r.dp.toPx(), center = Offset(x * w, h * (1.1f - 1.3f * travel)))
            }
        }
    }
}
