package com.meldiq.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** Compact top app bar for pushed screens: back, left-aligned title (+subtitle), contextual actions. */
@Composable
fun GriipTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = Griip.colors
    Row(
        modifier.fillMaxWidth().background(c.background).statusBarsPadding().height(64.dp).padding(start = if (onBack != null) 4.dp else Space.gutter, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            CircleIconButton(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.common_back), onBack)
            Spacer(Modifier.width(4.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.title, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            if (subtitle != null) Text(subtitle, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(verticalAlignment = Alignment.CenterVertically, content = actions)
    }
}

/** Top app bar for tab roots (Chats, Calls, Workspace, Settings): compact title, trailing actions. */
@Composable
fun LargeHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    val c = Griip.colors
    Row(
        modifier.fillMaxWidth().background(c.background).statusBarsPadding().height(64.dp).padding(start = Space.gutter, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.headline.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
            if (subtitle != null) Text(subtitle, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(verticalAlignment = Alignment.CenterVertically, content = trailing)
    }
}

/** [glyph]: a drawable drawn instead of [icon] (tinted the same way), e.g. Meldling on the Messages tab. */
data class NavItem(val route: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector, val badge: Int = 0, val glyph: Int? = null)

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = false,
) {
    val c = Griip.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        shape = Shapes.hero,
        title = { Text(title, style = Griip.type.title, color = c.textPrimary) },
        text = { Text(text, style = Griip.type.bodySmall, color = c.textSecondary) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(confirmLabel, style = Griip.type.button, color = if (destructive) c.danger else c.primary) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", style = Griip.type.button, color = c.textSecondary) } },
    )
}

/** Modal bottom sheet on the surface colour, with a drag handle and an optional title. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlassSheet(
    onDismiss: () -> Unit,
    title: String? = null,
    state: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Griip.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        shape = Shapes.sheet,
        containerColor = c.surface,
        scrimColor = c.scrim,
        contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
        dragHandle = {
            Box(Modifier.padding(top = 10.dp, bottom = 8.dp).width(36.dp).height(4.dp).clip(Shapes.pill).background(c.textTertiary.copy(alpha = 0.45f)))
        },
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = Space.gutter).padding(bottom = 16.dp)) {
            if (title != null) {
                Text(title, style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            }
            content()
        }
    }
}
