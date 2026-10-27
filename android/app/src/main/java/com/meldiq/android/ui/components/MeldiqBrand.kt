package com.meldiq.android.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.ui.theme.Griip

/** Corner radius of the logo tile, as a share of its size (the launcher's rounded-square look). */
private const val TILE_CORNER = 0.24f

/** The official brand tile: Meldling on its deep teal ground (brand/meldling.png, android/scripts/render_brand.py). */
@Composable
fun MeldiqLogo(size: Dp, modifier: Modifier = Modifier) {
    Image(
        painterResource(R.drawable.meldiq_mark), stringResource(R.string.app_name),
        modifier.size(size).clip(RoundedCornerShape(size * TILE_CORNER)), contentScale = ContentScale.Crop,
    )
}

/** "Meldiq" with "by GriipBuddy": the lockup for headers. */
@Composable
fun MeldiqLockup(modifier: Modifier = Modifier, logo: Dp = 34.dp) {
    val c = Griip.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        MeldiqLogo(logo)
        Spacer(Modifier.width(10.dp))
        Column {
            Text(stringResource(R.string.app_name), style = Griip.type.titleSmall.copy(fontWeight = FontWeight.Bold), color = c.textPrimary)
            Text("by GriipBuddy", style = Griip.type.caption, color = c.textSecondary)
        }
    }
}

/**
 * Meldling alone, in one colour (the Messages tab, the typing indicator): the mascot's silhouette tinted with [tint],
 * as Meldiq Web draws it. Decorative unless [label] is given.
 */
@Composable
fun MeldlingGlyph(size: Dp, tint: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier, label: String? = null) {
    androidx.compose.material3.Icon(painterResource(R.drawable.meldling_glyph), label, modifier.size(size), tint = tint)
}
