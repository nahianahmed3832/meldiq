package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.model.LookRules
import com.meldiq.android.data.model.Vibes
import com.meldiq.android.data.repo.Settings
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space

private val SWATCH = 44.dp
private val SWATCH_SHAPE = RoundedCornerShape(12.dp)

private fun brushOf(hex: List<String>): Brush {
    val colors = hex.mapNotNull { LookRules.argb(it)?.let(::Color) }.ifEmpty { listOf(Color.Gray) }
    return Brush.linearGradient(if (colors.size == 1) colors + colors else colors)
}

/**
 * Settings › Appearance › Colour themes (as Meldiq Web's): None or one of twenty gradients, a custom theme of two or three
 * colours, its strength, and whether a community's own accent and banner show while you're in it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VibesSettings(s: Settings, update: ((Settings) -> Settings) -> Unit) {
    val c = Griip.colors
    var picking by rememberSaveable { mutableStateOf<Int?>(null) }
    val custom = s.vibeCustom.takeIf { it.size in 2..3 } ?: Vibes.CUSTOM_START
    val active = Vibes.colors(s.vibe, s.vibeCustom) != null
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
        Text(stringResource(R.string.wp_vibes_title), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, modifier = Modifier.padding(top = 18.dp))
        Text(stringResource(R.string.wp_vibes_sub), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val none = stringResource(R.string.wp_style_none)
            Box(
                Modifier.size(SWATCH).clip(SWATCH_SHAPE).background(c.surfaceVariant)
                    .border(if (!active) 2.dp else 1.dp, if (!active) c.textPrimary else c.border, SWATCH_SHAPE)
                    .selectable(!active, role = Role.RadioButton) { update { it.copy(vibe = null) } }
                    .semantics { contentDescription = none },
                contentAlignment = Alignment.Center,
            ) { Text("∅", style = Griip.type.bodyMedium, color = c.textSecondary) }
            Vibes.ALL.forEach { v ->
                val selected = s.vibe == v.id
                Box(
                    Modifier.size(SWATCH).clip(SWATCH_SHAPE).background(brushOf(v.colors))
                        .border(if (selected) 3.dp else 0.dp, if (selected) c.textPrimary else Color.Transparent, SWATCH_SHAPE)
                        .selectable(selected, role = Role.RadioButton) { update { it.copy(vibe = v.id) } }
                        .semantics { contentDescription = v.id.replace('-', ' ') },
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        val customSelected = s.vibe == Vibes.CUSTOM
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(SWATCH).clip(SWATCH_SHAPE).background(brushOf(custom))
                    .border(if (customSelected) 3.dp else 1.dp, if (customSelected) c.textPrimary else c.border, SWATCH_SHAPE)
                    .selectable(customSelected, role = Role.RadioButton) { update { it.copy(vibe = Vibes.CUSTOM, vibeCustom = custom) } },
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.wp_vibes_custom), style = Griip.type.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
                Text(stringResource(R.string.wp_vibes_custom_sub), style = Griip.type.caption, color = c.textSecondary)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            custom.forEachIndexed { i, hex ->
                Box(
                    Modifier.size(36.dp).clip(CircleShape).background(brushOf(listOf(hex))).border(1.dp, c.border, CircleShape)
                        .selectable(false, role = Role.Button) { picking = i }
                        .semantics { contentDescription = hex },
                )
            }
            if (custom.size < 3) {
                CircleIconButton(Icons.Rounded.Add, stringResource(R.string.wp_vibes_add), { update { it.copy(vibe = Vibes.CUSTOM, vibeCustom = custom + "#22d3ee") } }, tint = c.textSecondary, size = 36.dp)
            } else {
                CircleIconButton(Icons.Rounded.Close, stringResource(R.string.wp_vibes_remove), { update { it.copy(vibe = Vibes.CUSTOM, vibeCustom = custom.take(2)) } }, tint = c.textSecondary, size = 36.dp)
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.wp_vibes_strength), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.width(80.dp))
            Slider(
                value = s.vibeStrength.toFloat(), onValueChange = { v -> update { it.copy(vibeStrength = Vibes.strength((v / Vibes.STRENGTH_STEP).toInt() * Vibes.STRENGTH_STEP)) } },
                valueRange = Vibes.STRENGTH_MIN.toFloat()..Vibes.STRENGTH_MAX.toFloat(), enabled = active, modifier = Modifier.weight(1f),
            )
            Text("${s.vibeStrength}%", style = Griip.type.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, modifier = Modifier.width(48.dp).padding(start = 8.dp))
        }
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.wp_community_colors), style = Griip.type.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
                Text(stringResource(R.string.wp_community_colors_sub), style = Griip.type.caption, color = c.textSecondary)
            }
            Spacer(Modifier.width(12.dp))
            Switch(s.communityColors, onCheckedChange = { on -> update { it.copy(communityColors = on) } })
        }
    }
    picking?.let { index ->
        GlassSheet({ picking = null }, title = stringResource(R.string.wp_vibes_pick)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 16.dp)) {
                Vibes.SWATCHES.forEach { hex ->
                    Box(
                        Modifier.size(SWATCH).clip(CircleShape).background(brushOf(listOf(hex))).border(1.dp, c.border, CircleShape)
                            .selectable(custom.getOrNull(index) == hex, role = Role.RadioButton) {
                                update { it.copy(vibe = Vibes.CUSTOM, vibeCustom = custom.mapIndexed { j, old -> if (j == index) hex else old }) }
                                picking = null
                            }
                            .semantics { contentDescription = hex },
                    )
                }
            }
        }
    }
}
