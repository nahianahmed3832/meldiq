package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.repo.MessageLayout
import com.meldiq.android.data.repo.Settings
import com.meldiq.android.ui.components.SegmentedPills
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.MeldiqPalettes
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.ThemeMode
import com.meldiq.android.ui.theme.headerBrush

/** Theme (system, light, dark), the colour preset and the message layout: Settings › Chats › Appearance. */
@Composable
fun AppearanceSettings(s: Settings, update: ((Settings) -> Settings) -> Unit) {
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
        Label(stringResource(R.string.appearance_theme))
        val modes = listOf(ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK)
        SegmentedPills(
            listOf(stringResource(R.string.appearance_theme_system), stringResource(R.string.appearance_theme_light), stringResource(R.string.appearance_theme_dark)),
            modes.indexOf(s.theme).coerceAtLeast(0), { i -> update { it.copy(theme = modes[i]) } },
        )
        Label(stringResource(R.string.appearance_palette), Modifier.padding(top = 18.dp))
        Text(stringResource(R.string.appearance_palette_sub), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
        // Two per row: four presets side by side leave too little room for their names at large text sizes.
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            MeldiqPalettes.ALL.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { preset ->
                        PaletteCard(preset, selected = s.palette == preset.id, dark = c.isDark, Modifier.weight(1f)) { update { it.copy(palette = preset.id) } }
                    }
                }
            }
        }
    }
    // Colour themes and community colours (as Meldiq Web's Appearance, 2026-10-28).
    VibesSettings(s, update)
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
        Label(stringResource(R.string.appearance_layout), Modifier.padding(top = 18.dp))
        val layouts = listOf(MessageLayout.STREAM, MessageLayout.BUBBLES)
        SegmentedPills(
            listOf(stringResource(R.string.appearance_layout_stream), stringResource(R.string.appearance_layout_bubbles)),
            layouts.indexOf(s.messageLayout).coerceAtLeast(0), { i -> update { it.copy(messageLayout = layouts[i]) } },
        )
        Text(
            stringResource(if (s.messageLayout == MessageLayout.STREAM) R.string.appearance_layout_stream_sub else R.string.appearance_layout_bubbles_sub),
            style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp),
        )
        // 2026-10-23: what the chat list shows of the last message, and 12- or 24-hour times.
        Label(stringResource(R.string.ux_previews), Modifier.padding(top = 18.dp))
        val modes2 = listOf(com.meldiq.android.data.repo.PreviewMode.ALL, com.meldiq.android.data.repo.PreviewMode.UNREAD, com.meldiq.android.data.repo.PreviewMode.NONE)
        SegmentedPills(
            listOf(stringResource(R.string.ux_previews_all), stringResource(R.string.ux_previews_unread), stringResource(R.string.ux_previews_none)),
            modes2.indexOf(s.previewMode).coerceAtLeast(0), { i -> update { it.copy(previewMode = modes2[i]) } },
        )
        Label(stringResource(R.string.ux_time_format), Modifier.padding(top = 18.dp))
        val hours = listOf(com.meldiq.android.data.repo.HourFormat.AUTO, com.meldiq.android.data.repo.HourFormat.H12, com.meldiq.android.data.repo.HourFormat.H24)
        SegmentedPills(
            listOf(stringResource(R.string.ux_time_auto), stringResource(R.string.ux_time_12), stringResource(R.string.ux_time_24)),
            hours.indexOf(s.hourFormat).coerceAtLeast(0), { i -> update { it.copy(hourFormat = hours[i]) } },
        )
    }
}

/** A colour preset's name in the app's language. */
@Composable
internal fun paletteName(id: String): String = stringResource(
    when (id) {
        "sunset" -> R.string.palette_sunset
        "meadow" -> R.string.palette_meadow
        "aurora" -> R.string.palette_aurora
        "graphite" -> R.string.palette_graphite
        "midnight" -> R.string.palette_midnight
        else -> R.string.wp_palette_meldiq
    },
)

@Composable
private fun Label(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = Griip.colors.textPrimary, modifier = modifier.padding(bottom = 8.dp))
}

/** A preset drawn in its own colours (in the current light or dark mode): the header gradient, an action dot and its name. */
@Composable
private fun PaletteCard(preset: MeldiqPalettes.Preset, selected: Boolean, dark: Boolean, modifier: Modifier, onPick: () -> Unit) {
    val p = if (dark) preset.dark else preset.light
    val c = Griip.colors
    val name = paletteName(preset.id)
    val selectedText = stringResource(R.string.palette_selected)
    Column(
        modifier.clip(Shapes.card).background(p.surface)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.primary else c.border, Shapes.card)
            .pressable(onPick, role = Role.RadioButton)
            .semantics {
                this.selected = selected
                contentDescription = if (selected) "$name, $selectedText" else name
            },
    ) {
        // A flat header (Graphite) is shown as the page colour so the card still has two tones.
        val strip = if (p.heroStart == p.heroEnd) Modifier.background(p.background) else Modifier.background(p.headerBrush())
        Box(Modifier.fillMaxWidth().height(44.dp).then(strip), contentAlignment = Alignment.CenterEnd) {
            if (selected) Box(Modifier.padding(end = 8.dp).size(22.dp).clip(CircleShape).background(p.actionStart), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Check, null, tint = p.onAction, modifier = Modifier.size(14.dp))
            }
        }
        Row(Modifier.padding(horizontal = 8.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(p.actionStart))
            Spacer(Modifier.width(6.dp))
            Text(
                name, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = p.textPrimary, maxLines = 1,
                softWrap = false, overflow = androidx.compose.ui.text.style.TextOverflow.Visible,
            )
        }
    }
}
