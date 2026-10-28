package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.billing.SparkGoalRules
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/**
 * The Spark goal at the top of a community's channel list (the floating redesign, 2026-10-28, like a server boost
 * bar): the level, the active Sparks, how many more the next level needs and a progress bar. Opens the community's Sparks.
 */
@Composable
fun SparkGoalCard(goal: SparkGoalRules.Goal, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Griip.colors
    val levelText = if (goal.level > 0) stringResource(R.string.mojo_spark_level, goal.level) else stringResource(R.string.spark_goal_none)
    val activeText = if (goal.active == 1) stringResource(R.string.spark_goal_active_one) else stringResource(R.string.spark_goal_active, goal.active)
    val nextText = goal.nextLevel?.let { stringResource(R.string.mojo_spark_next, goal.needs, it) } ?: stringResource(R.string.mojo_spark_max)
    val description = stringResource(R.string.spark_goal_cd, levelText, activeText, nextText)
    Column(
        modifier.fillMaxWidth().clip(Shapes.card).background(c.surfaceVariant).border(1.dp, c.border, Shapes.card)
            .pressable(onClick).clearAndSetSemantics { contentDescription = description }.padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(24.dp).clip(Shapes.pill).background(Brush.linearGradient(listOf(c.accentStart, c.accentEnd))), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Bolt, null, tint = c.onAccent, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.spark_goal_title), style = Griip.type.label.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, modifier = Modifier.weight(1f))
            Text("$levelText · $activeText", style = Griip.type.caption, color = c.textSecondary)
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = c.textTertiary, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.height(8.dp))
        SparkBar(goal.fraction)
        Spacer(Modifier.height(6.dp))
        Text(nextText, style = Griip.type.caption, color = if (goal.nextLevel == null) c.primary else c.textSecondary)
    }
}

/** A thin rounded progress bar in the palette's accent. */
@Composable
fun SparkBar(fraction: Float, modifier: Modifier = Modifier) {
    val c = Griip.colors
    Box(modifier.fillMaxWidth().height(6.dp).clip(Shapes.pill).background(c.border)) {
        if (fraction > 0f) {
            Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(6.dp).clip(Shapes.pill).background(Brush.horizontalGradient(listOf(c.accentStart, c.accentEnd))))
        }
    }
}

/** The small Spark level chip beside a community's name; nothing below Level 1. */
@Composable
fun SparkLevelChip(level: Int, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    if (level <= 0) return
    val c = Griip.colors
    val description = stringResource(R.string.spark_chip_cd, level)
    Row(
        modifier.clip(Shapes.pill).background(c.primarySoft).pressable(onClick)
            .semantics { contentDescription = description }.padding(horizontal = 7.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Bolt, null, tint = c.primary, modifier = Modifier.size(13.dp))
        Text("$level", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primary)
    }
}
