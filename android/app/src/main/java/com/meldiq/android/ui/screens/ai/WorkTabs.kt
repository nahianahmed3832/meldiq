package com.meldiq.android.ui.screens.ai

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.data.ai.AiCheckItem
import com.meldiq.android.data.ai.AiCheckReport
import com.meldiq.android.data.ai.AiChecksRes
import com.meldiq.android.data.ai.AiOverview
import com.meldiq.android.data.ai.AiWorkItem
import com.meldiq.android.data.ai.AiWorkOverview
import com.meldiq.android.data.ai.AiWorkRules
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

@Composable
private fun checkStatusLabel(s: String) = stringResource(
    when (s) {
        "healthy" -> R.string.aw_check_healthy
        "warning" -> R.string.aw_check_warning
        "failed" -> R.string.aw_check_failed
        "not_configured" -> R.string.aw_check_not_configured
        else -> R.string.aw_check_not_tested
    },
)

@Composable
private fun statusColors(s: String): Pair<Color, Color> {
    val c = Griip.colors
    return when (s) {
        "healthy" -> c.success to c.successSoft
        "warning" -> c.warning to c.warningSoft
        "failed" -> c.danger to c.dangerSoft
        else -> c.textSecondary to c.surfaceVariant
    }
}

@Composable
private fun actionLabel(a: String) = stringResource(
    when (a) {
        "approve" -> R.string.aw_work_approve
        "answer" -> R.string.aw_work_answer
        "do" -> R.string.aw_work_do
        "review" -> R.string.aw_work_review
        else -> R.string.aw_work_open
    },
)

/**
 * Community › AI agents › Overview (as Meldiq Web's WorkTab, API 0.41.0): what needs this person first, then what agents
 * and people are doing, what failed and what finished, with what the agents' work cost. A request opens here; a task
 * opens in Tasks.
 */
@Composable
fun WorkTab(orgId: String, o: AiOverview, onOpenTask: (String) -> Unit, onOpenHealth: () -> Unit) {
    val container = LocalContainer.current
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var work by remember { mutableStateOf<AiWorkOverview?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var job by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, rev) { runCatching { container.ai.work(orgId) }.onSuccess { work = it; error = null }.onFailure { error = it.friendly() } }
    val c = Griip.colors
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        error?.let { StatusBanner(it, BannerKind.Error) }
        val w = work
        if (w == null) {
            if (error == null) ShimmerList(3)
            return@Column
        }
        val t = w.totals
        Text(
            stringResource(R.string.aw_work_totals, t.attention, t.active, t.finished, t.failed, AiWorkRules.cost(t.costMicro), t.requests),
            style = Griip.type.bodyMedium, color = c.textPrimary,
        )
        Text(stringResource(if (w.scope == "all") R.string.aw_work_scope_all else R.string.aw_work_scope_mine, w.days), style = Griip.type.caption, color = c.textSecondary)
        w.health?.takeIf { it.worst != "healthy" }?.let { h ->
            StatusBanner(
                stringResource(R.string.aw_work_health, TimeFmt.relative(h.at), checkStatusLabel(h.worst), h.failed, h.warning),
                if (h.worst == "failed") BannerKind.Warning else BannerKind.Info,
                action = stringResource(R.string.aw_work_open_health), onAction = onOpenHealth,
            )
        }
        val open: (AiWorkItem) -> Unit = { item -> if (item.kind == "task" && item.taskId != null) onOpenTask(item.taskId) else job = item.jobId }
        WorkSection(stringResource(R.string.aw_work_needs_you), stringResource(R.string.aw_work_needs_you_none), w.attention, open)
        WorkSection(stringResource(R.string.aw_work_active), stringResource(R.string.aw_work_active_none), w.active, open)
        if (w.failed.isNotEmpty()) WorkSection(stringResource(R.string.aw_work_failed), "", w.failed, open)
        WorkSection(stringResource(R.string.aw_work_finished), stringResource(R.string.aw_work_finished_none, w.days), w.finished, open)
    }
    job?.let { JobSheet(orgId, it, o.permissions, onDismiss = { job = null }) }
}

@Composable
private fun WorkSection(title: String, empty: String, items: List<AiWorkItem>, onOpen: (AiWorkItem) -> Unit) {
    val c = Griip.colors
    Text(title, style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp))
    if (items.isEmpty()) {
        Text(empty, style = Griip.type.bodySmall, color = c.textTertiary)
        return
    }
    items.forEach { item -> WorkRow(item, onOpen) }
}

@Composable
private fun WorkRow(item: AiWorkItem, onOpen: (AiWorkItem) -> Unit) {
    val c = Griip.colors
    val state = if (item.kind == "job") jobStateLabel(item.state) else taskStateLabel(item.state)
    val facts = listOfNotNull(
        state,
        if (item.owner.kind == "agent") item.owner.name + " (AI)" else stringResource(R.string.aw_task_for, item.owner.name),
        stringResource(R.string.aw_work_asked_by, item.requestedBy.name),
        TimeFmt.relative(item.at),
        item.deliverables?.takeIf { it > 0 }?.let { stringResource(R.string.aw_work_files, it) },
        item.costMicro?.takeIf { it > 0 }?.let { stringResource(R.string.aw_work_cost, AiWorkRules.cost(it)) },
        item.error?.let { stringResource(R.string.aw_work_error, it) },
    )
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (item.owner.kind == "agent") Icons.Outlined.SmartToy else Icons.Outlined.Person, null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f)) {
            Text(item.title, style = Griip.type.body, color = c.textPrimary)
            item.reason?.let { Text(it, style = Griip.type.caption, color = c.warning) }
            Text(facts.joinToString(" · "), style = Griip.type.caption, color = c.textSecondary)
        }
        PillButton(actionLabel(item.action), { onOpen(item) }, tone = if (item.action == "open") ButtonTone.Glass else ButtonTone.Primary, height = 34.dp)
    }
}

/**
 * Community › AI agents › Health (as Meldiq Web's SystemCheckTab, API 0.41.0): Run Full System Check, then what needs
 * attention first with the evidence, why, what to do and who can fix it; what couldn't be tested safely; what's healthy;
 * earlier runs; export. Nothing here asks the AI model, sends or publishes.
 */
@Composable
fun SystemCheckTab(orgId: String, o: AiOverview) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<AiChecksRes?>(null) }
    var shown by remember { mutableStateOf<AiCheckReport?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(orgId, reload) { runCatching { container.ai.systemChecks(orgId) }.onSuccess { list = it; error = null }.onFailure { error = it.friendly() } }
    fun act(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val c = Griip.colors
    val report = shown ?: list?.latest
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.aw_check_sub), style = Griip.type.bodySmall, color = c.textSecondary)
        PillButton(
            stringResource(if (busy) R.string.aw_check_running else R.string.aw_check_run), { act { shown = container.ai.runSystemCheck(orgId); reload++ } },
            Modifier.fillMaxWidth(), enabled = !busy, leadingIcon = Icons.Outlined.MonitorHeart,
        )
        error?.let { StatusBanner(it, BannerKind.Error) }
        if (list == null && error == null) ShimmerList(2)
        if (list != null && report == null) Text(stringResource(R.string.aw_check_none), style = Griip.type.body, color = c.textSecondary)
        report?.let { r ->
            val attention = AiWorkRules.attention(r)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (attention.isEmpty()) stringResource(R.string.aw_check_all_ok) else stringResource(R.string.aw_check_attention_n, attention.size),
                    style = Griip.type.titleSmall, color = c.textPrimary, modifier = Modifier.weight(1f),
                )
                PillButton(stringResource(R.string.aw_check_export), { exportReport(context, r) }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Share, height = 36.dp)
            }
            Text(stringResource(R.string.aw_check_when, TimeFmt.relative(r.startedAt), r.items.size), style = Griip.type.caption, color = c.textSecondary)
            CheckCounts(r.summary)
            attention.forEach { CheckRow(orgId, o, it) }
            val untested = AiWorkRules.untested(r)
            if (untested.isNotEmpty()) {
                var open by remember(r.id) { mutableStateOf(attention.isEmpty()) }
                Text(stringResource(R.string.aw_check_untested, untested.size), style = Griip.type.label, color = c.primary, modifier = Modifier.pressable({ open = !open }).padding(vertical = 4.dp))
                if (open) untested.forEach { CheckRow(orgId, o, it) }
            }
            val healthy = AiWorkRules.healthy(r)
            if (healthy.isNotEmpty()) {
                var open by remember(r.id) { mutableStateOf(false) }
                Text(stringResource(R.string.aw_check_healthy_n, healthy.size), style = Griip.type.label, color = c.primary, modifier = Modifier.pressable({ open = !open }).padding(vertical = 4.dp))
                if (open) healthy.forEach { CheckRow(orgId, o, it) }
            }
        }
        list?.history?.takeIf { it.size > 1 }?.let { history ->
            Text(stringResource(R.string.aw_check_earlier), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
            history.forEach { h ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(TimeFmt.relative(h.startedAt), style = Griip.type.body, color = c.textPrimary)
                        CheckCounts(h.summary)
                    }
                    PillButton(
                        stringResource(if (report?.id == h.id) R.string.aw_check_shown else R.string.aw_check_show),
                        { act { shown = container.ai.systemCheck(orgId, h.id) } }, tone = ButtonTone.Glass, enabled = !busy && report?.id != h.id, height = 34.dp,
                    )
                }
            }
        }
    }
}

@Composable
private fun CheckCounts(s: com.meldiq.android.data.ai.AiCheckCounts) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AiWorkRules.CHECK_STATUSES.forEach { st ->
            val n = s.of(st)
            if (n > 0) {
                val (fg, bg) = statusColors(st)
                TagPill("$n " + checkStatusLabel(st).lowercase(), fg, bg)
            }
        }
    }
}

@Composable
private fun CheckRow(orgId: String, o: AiOverview, item: AiCheckItem) {
    val c = Griip.colors
    var job by remember { mutableStateOf<String?>(null) }
    val (icon, tint) = when (item.status) {
        "healthy" -> Icons.Outlined.CheckCircle to c.success
        "failed" -> Icons.Outlined.ErrorOutline to c.danger
        "warning" -> Icons.Outlined.WarningAmber to c.warning
        "not_tested" -> Icons.Outlined.HelpOutline to c.textTertiary
        else -> Icons.Outlined.RadioButtonUnchecked to c.textTertiary
    }
    val level = stringResource(
        when (item.level) {
            "configuration" -> R.string.aw_check_level_config
            "runtime" -> R.string.aw_check_level_runtime
            else -> R.string.aw_check_level_smoke
        },
    )
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.title, style = Griip.type.body, color = c.textPrimary)
            Text(listOfNotNull(level, stringResource(R.string.aw_check_tested).takeIf { item.verified }, checkStatusLabel(item.status)).joinToString(" · "), style = Griip.type.caption, color = c.textTertiary)
            Text(item.evidence, style = Griip.type.caption, color = c.textSecondary)
            item.cause?.let { Text(stringResource(R.string.aw_check_why, it), style = Griip.type.caption, color = c.textSecondary) }
            item.remediation?.let { Text(stringResource(R.string.aw_check_do, it), style = Griip.type.caption, color = c.textSecondary) }
            if (item.remediation != null && item.owner != null) Text(
                stringResource(if (item.owner == "platform_operator") R.string.aw_check_owner_operator else R.string.aw_check_owner_community),
                style = Griip.type.caption, color = c.textSecondary,
            )
            if (item.impacts.isNotEmpty() && item.status != "healthy") Text(stringResource(R.string.aw_check_affects, item.impacts.joinToString()), style = Griip.type.caption, color = c.textSecondary)
            if (item.links.tasks.isNotEmpty()) Text(stringResource(R.string.aw_check_tasks, item.links.tasks.size), style = Griip.type.caption, color = c.textSecondary)
            item.links.jobs.forEachIndexed { i, id ->
                Text(
                    if (item.links.jobs.size == 1) stringResource(R.string.aw_post_see) else stringResource(R.string.aw_check_request_n, i + 1),
                    style = Griip.type.label, color = c.primary, modifier = Modifier.pressable({ job = id }).padding(vertical = 2.dp),
                )
            }
        }
    }
    job?.let { JobSheet(orgId, it, o.permissions, onDismiss = { job = null }) }
}

private val prettyJson = Json(GriipJson) { prettyPrint = true }

/** Shares the report as a JSON file (the server already left out content and secrets). */
private fun exportReport(context: android.content.Context, r: AiCheckReport) {
    val dir = java.io.File(context.cacheDir, "shared/ai").apply { mkdirs() }
    val f = java.io.File(dir, AiWorkRules.reportName(r))
    f.writeText(prettyJson.encodeToString(AiCheckReport.serializer(), r) + "\n")
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", f)
    val intent = Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    runCatching { context.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
