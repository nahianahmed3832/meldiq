package com.meldiq.android.ui.icons

import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.layout.size
import androidx.compose.ui.unit.dp

/** Decorative by default. Keep labels, selected state and 48dp targets on the parent control. */
@Composable
fun MeldiqIcon(
    icon: MeldiqIcon,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    size: Int = 24,
    tint: Color = LocalContentColor.current,
    enabled: Boolean = true,
) {
    require(size in setOf(16, 18, 20, 24, 32)) { "Use a Meldiq icon size token" }
    Icon(painterResource(icon.drawable), contentDescription, modifier.size(size.dp),
        tint = if (enabled) tint else tint.copy(alpha = tint.alpha * 0.38f))
}
