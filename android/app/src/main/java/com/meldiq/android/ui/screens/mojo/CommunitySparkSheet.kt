package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.billing.OrgSparks
import com.meldiq.android.data.billing.SparkAssignment
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import kotlinx.coroutines.launch

/**
 * A community's Meldiq Spark (server menu › Meldiq Spark, docs/MOJO_ANDROID.md): its level and what that gives everyone
 * there, how far the next level is, and this member's Sparks here, with Give and Take back. At Level 3 the sheet says a
 * further Spark adds nothing before anyone gives one.
 */
@Composable
fun CommunitySparkSheet(org: OrgDto, onSeePlans: () -> Unit, onDismiss: () -> Unit) {
    val mojo = LocalContainer.current.mojo
    val state by mojo.state.collectAsState()
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var info by remember { mutableStateOf<OrgSparks?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var removing by remember { mutableStateOf<SparkAssignment?>(null) }
    LaunchedEffect(org.id, reload) {
        if (state.catalog == null || state.me == null) mojo.refresh()
        mojo.orgSparks(org.id).fold({ info = it }, { error = it.friendly() })
    }
    GlassSheet(onDismiss, title = stringResource(R.string.mojo_spark_open)) {
        Text(stringResource(R.string.mojo_spark_body), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(12.dp))
        val o = info
        if (o == null) {
            Text(error ?: stringResource(R.string.mojo_loading), style = Griip.type.bodySmall, color = if (error != null) c.danger else c.textSecondary)
        } else {
            Text(stringResource(R.string.mojo_spark_level_now, o.level, o.active), style = Griip.type.title, color = c.textPrimary)
            val maxSparks = o.levels.maxOfOrNull { it.sparks } ?: 1
            LinearProgressIndicator(
                progress = { (o.active.toFloat() / maxSparks).coerceIn(0f, 1f) }, color = c.primary, trackColor = c.surfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).height(8.dp).clip(Shapes.pill),
            )
            Text(
                o.next?.let { stringResource(R.string.mojo_spark_next, it.needs, it.level) } ?: stringResource(R.string.mojo_spark_max),
                style = Griip.type.caption, color = c.textSecondary,
            )
            state.catalog?.let { catalog ->
                Spacer(Modifier.height(12.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    o.levels.filter { it.level > 0 }.forEach { l ->
                        Box(Modifier.clip(Shapes.card).background(if (l.level <= o.level) c.primarySoft else c.surface)) {
                            LevelSummary(catalog, l)
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            if (o.mine.isNotEmpty()) Text(stringResource(R.string.mojo_spark_yours_here, o.mine.size), style = Griip.type.bodyMedium, color = c.textPrimary)
            if (o.next == null) Text(stringResource(R.string.mojo_spark_wont_raise), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 4.dp))
            error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 4.dp)) }
            Spacer(Modifier.height(10.dp))
            val free = state.me?.sparks?.free ?: 0
            if (free > 0) {
                PillButton(
                    stringResource(R.string.mojo_spark_give), {
                        scope.launch {
                            error = mojo.giveSpark(org.id).exceptionOrNull()?.friendly()
                            reload++
                        }
                    }, Modifier.fillMaxWidth(), height = 48.dp,
                )
            } else {
                PillButton(stringResource(R.string.mojo_spark_see_plans), onSeePlans, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 48.dp)
            }
            o.mine.lastOrNull()?.let { m ->
                Spacer(Modifier.height(8.dp))
                PillButton(
                    stringResource(R.string.mojo_spark_remove), { removing = SparkAssignment(m.id, org.id, org.name, m.assignedAt, m.paused) },
                    Modifier.fillMaxWidth(), tone = ButtonTone.Danger, height = 44.dp,
                )
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    removing?.let { a ->
        RemoveSparkDialog(a, onDismiss = { removing = null }) {
            removing = null
            scope.launch {
                error = mojo.removeSpark(a.id).exceptionOrNull()?.friendly()
                reload++
            }
        }
    }
}

@Composable
private fun LevelSummary(catalog: com.meldiq.android.data.billing.MojoCatalog, l: com.meldiq.android.data.billing.SparkLevel) {
    val c = Griip.colors
    androidx.compose.foundation.layout.Column(Modifier.padding(12.dp)) {
        Text(stringResource(R.string.mojo_spark_level, l.level), style = Griip.type.titleSmall, color = c.textPrimary)
        Text(stringResource(R.string.mojo_spark_emoji, l.emojiSlots), style = Griip.type.caption, color = c.textSecondary)
        l.uploadBytes?.let { Text(stringResource(R.string.mojo_spark_upload, com.meldiq.android.data.billing.MojoPlans.size(it)), style = Griip.type.caption, color = c.textSecondary) }
        Text(stringResource(R.string.mojo_spark_voice, l.voiceKbps), style = Griip.type.caption, color = c.textSecondary)
        if (l.screen.isNotEmpty()) Text(stringResource(R.string.mojo_spark_screen, presets(catalog, l.screen)), style = Griip.type.caption, color = c.textSecondary)
    }
}
