package com.meldiq.android.ui.screens.ai

import android.app.TimePickerDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Science
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.data.ai.AiActivity
import com.meldiq.android.data.ai.AiAgentDetail
import com.meldiq.android.data.ai.AiAutonomy
import com.meldiq.android.data.ai.AiInstall
import com.meldiq.android.data.ai.AiInstallReaders
import com.meldiq.android.data.ai.AiNewTrigger
import com.meldiq.android.data.ai.AiReadiness
import com.meldiq.android.data.ai.AiTrigger
import com.meldiq.android.data.ai.AiTriggerRules
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Saves [fields] on the agent (with its rev) and says [message] when done. */
typealias AgentPatch = (fields: Map<String, JsonElement>, message: String?) -> Unit

/**
 * How an agent works on its own (as Meldiq Web's AgentAutomation and AgentHealth, server docs/AI_WORKFORCE.md §5b): its
 * autonomy, triggers, limits, readiness, a real test request and its activity. The server enforces all of it.
 */
@Composable
fun ReadinessPill(r: AiReadiness?) {
    val c = Griip.colors
    r ?: return
    if (r.ready) TagPill(stringResource(R.string.aw_ready), c.success, c.successSoft)
    else TagPill(stringResource(R.string.aw_missing_n, r.missingCount), c.warning, c.warningSoft)
}

/** The checks (or only those whose key starts with one of [only]). */
@Composable
fun ReadinessList(r: AiReadiness, only: List<String>? = null) {
    val c = Griip.colors
    val checks = only?.let { p -> r.checks.filter { ch -> p.any { ch.key.startsWith(it) } } } ?: r.checks
    if (checks.isEmpty()) {
        Text(stringResource(R.string.aw_nothing_to_check), style = Griip.type.bodySmall, color = c.textSecondary)
        return
    }
    checks.forEach { ch ->
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val (icon, tint) = when (ch.status) {
                "ok" -> Icons.Outlined.CheckCircle to c.success
                "missing" -> Icons.Outlined.ErrorOutline to c.warning
                else -> Icons.Outlined.RadioButtonUnchecked to c.textTertiary
            }
            Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
            Column(Modifier.weight(1f)) {
                Text(ch.label, style = Griip.type.body, color = c.textPrimary)
                val fix = when (ch.fixBy) {
                    "operator" -> " " + stringResource(R.string.aw_fix_operator)
                    "community" -> " " + stringResource(R.string.aw_fix_community)
                    else -> ""
                }
                Text(ch.detail + fix, style = Griip.type.caption, color = c.textSecondary)
            }
        }
    }
}

@Composable
private fun autonomyTitle(k: String) = stringResource(
    when (k) {
        AiAutonomy.MANUAL -> R.string.aw_autonomy_manual
        AiAutonomy.GUARDED -> R.string.aw_autonomy_guarded
        AiAutonomy.CONTINUOUS -> R.string.aw_autonomy_continuous
        else -> R.string.aw_autonomy_assisted
    },
)

@Composable
private fun autonomyBody(k: String) = stringResource(
    when (k) {
        AiAutonomy.MANUAL -> R.string.aw_autonomy_manual_sub
        AiAutonomy.GUARDED -> R.string.aw_autonomy_guarded_sub
        AiAutonomy.CONTINUOUS -> R.string.aw_autonomy_continuous_sub
        else -> R.string.aw_autonomy_assisted_sub
    },
)

@Composable
fun AutonomyStep(a: AiInstall, manage: Boolean, busy: Boolean, triggersOn: Int, patch: AgentPatch) {
    val c = Griip.colors
    Text(stringResource(R.string.aw_autonomy_sub), style = Griip.type.bodySmall, color = c.textSecondary)
    AiAutonomy.ALL.forEach { k ->
        val title = autonomyTitle(k)
        val saved = stringResource(R.string.aw_autonomy_saved, title)
        ListCard(title, subtitle = autonomyBody(k), selected = a.autonomy == k, onClick = if (manage && !busy && a.autonomy != k) ({ patch(mapOf("autonomy" to JsonPrimitive(k)), saved) }) else null)
    }
    if ((a.autonomy == AiAutonomy.GUARDED || a.autonomy == AiAutonomy.CONTINUOUS) && a.effectiveMode == "review") StatusBanner(stringResource(R.string.aw_autonomy_review_forced), BannerKind.Warning)
    if (a.autonomy == AiAutonomy.CONTINUOUS && triggersOn == 0) StatusBanner(stringResource(R.string.aw_autonomy_no_trigger), BannerKind.Info)
}

@Composable
private fun describe(t: AiTrigger, agentName: (String) -> String): String {
    if (t.kind == "webhook") return stringResource(R.string.aw_trigger_webhook_desc)
    if (t.kind == "after_agent") return stringResource(R.string.aw_trigger_after_desc, t.sourceInstallId?.let(agentName) ?: stringResource(R.string.aw_another_agent))
    val s = AiTriggerRules.schedule(t.config)
    val days = weekdays()
    val whenText = when (s.every) {
        "hour" -> stringResource(R.string.aw_every_hour_at, s.at.takeLast(2))
        "week" -> stringResource(R.string.aw_every_week_at, days.getOrElse(s.weekday) { days[1] }, s.at)
        else -> stringResource(R.string.aw_every_day_at, s.at)
    }
    return "$whenText (${s.timeZone})"
}

/** Triggers: work it starts with nobody present, as the person who made them (their permissions checked each time). */
@Composable
fun TriggersStep(orgId: String, d: AiAgentDetail, manage: Boolean, channelName: (String) -> String) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val a = d.agent
    val c = Griip.colors
    if (!manage) {
        Text(stringResource(R.string.aw_triggers_managers_only), style = Griip.type.body, color = c.textSecondary)
        return
    }
    var list by remember { mutableStateOf<List<AiTrigger>?>(null) }
    var others by remember { mutableStateOf<List<AiInstall>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var secret by remember { mutableStateOf<Pair<String, String>?>(null) }
    var reload by remember { mutableStateOf(0) }
    var kind by remember { mutableStateOf("schedule") }
    var label by remember { mutableStateOf("") }
    var brief by remember { mutableStateOf("") }
    var channel by remember { mutableStateOf<String?>(null) }
    var every by remember { mutableStateOf("day") }
    var at by remember { mutableStateOf("09:00") }
    var weekday by remember { mutableStateOf(1) }
    var timeZone by remember { mutableStateOf(java.util.TimeZone.getDefault().id) }
    var source by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, a.id, reload) {
        runCatching { container.ai.triggers(orgId, a.id) }.onSuccess { list = it; error = null }.onFailure { error = it.friendly() }
        others = runCatching { container.ai.overview(orgId).agents.filter { it.id != a.id } }.getOrDefault(emptyList())
    }
    fun run(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.friendly() }
            reload++
            busy = false
        }
    }
    val nameOf = { id: String -> others.firstOrNull { it.id == id }?.displayName ?: "" }
    Text(stringResource(R.string.aw_triggers_sub), style = Griip.type.bodySmall, color = c.textSecondary)
    if (a.autonomy != AiAutonomy.CONTINUOUS) StatusBanner(stringResource(R.string.aw_triggers_not_continuous, autonomyTitle(a.autonomy)), BannerKind.Info)
    error?.let { StatusBanner(it, BannerKind.Error) }
    secret?.let { (url, key) -> StatusBanner(stringResource(R.string.aw_webhook_secret, url, key), BannerKind.Warning, action = stringResource(R.string.aw_done), onAction = { secret = null }) }
    PillButton(stringResource(R.string.aw_trigger_add), { adding = !adding }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, height = 40.dp)
    if (adding) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillChip(stringResource(R.string.aw_trigger_schedule), kind == "schedule", { kind = "schedule" })
            PillChip(stringResource(R.string.aw_trigger_after), kind == "after_agent", { kind = "after_agent" })
            PillChip(stringResource(R.string.aw_trigger_webhook), kind == "webhook", { kind = "webhook" })
        }
        if (kind == "schedule") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("hour" to R.string.aw_hour, "day" to R.string.aw_day, "week" to R.string.aw_week).forEach { (k, l) -> PillChip(stringResource(l), every == k, { every = k }) }
            }
            if (every == "week") {
                val days = weekdays()
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    days.forEachIndexed { i, dname -> PillChip(dname.take(3), weekday == i, { weekday = i }) }
                }
            }
            ListCard(at, subtitle = stringResource(R.string.aw_at), onClick = { pickTime(context, at) { at = it } })
            GriipTextField(timeZone, { timeZone = it.take(60) }, stringResource(R.string.aw_time_zone))
        }
        if (kind == "after_agent") {
            Text(stringResource(R.string.aw_after_which), style = Griip.type.label, color = c.textSecondary)
            androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                others.forEach { o -> PillChip(o.displayName, source == o.id, { source = o.id }) }
            }
        }
        GriipTextField(label, { label = it.take(80) }, stringResource(R.string.aw_trigger_name), placeholder = stringResource(R.string.aw_trigger_name_ph))
        GriipTextField(brief, { brief = it.take(4000) }, stringResource(R.string.aw_trigger_brief), singleLine = false, minLines = 3)
        Text(stringResource(R.string.aw_trigger_post_in), style = Griip.type.label, color = c.textSecondary)
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PillChip(stringResource(R.string.aw_trigger_no_channel), channel == null, { channel = null })
            d.channels.forEach { ch -> PillChip("#" + channelName(ch.conversationId), channel == ch.conversationId, { channel = ch.conversationId }) }
        }
        PillButton(stringResource(R.string.aw_trigger_save), {
            run {
                val config = if (kind == "schedule") JsonObject(mapOf("every" to JsonPrimitive(every), "at" to JsonPrimitive(at), "weekday" to JsonPrimitive(weekday), "timeZone" to JsonPrimitive(timeZone.trim()))) else JsonObject(emptyMap())
                val r = container.ai.addTrigger(orgId, a.id, AiNewTrigger(kind, label.trim(), brief.trim(), channel, config, source.takeIf { kind == "after_agent" }))
                if (r.secret != null && r.hookUrl != null) secret = (container.session.serverUrl.trimEnd('/') + r.hookUrl) to r.secret
                adding = false; label = ""; brief = ""
            }
        }, Modifier.fillMaxWidth(), enabled = !busy && label.isNotBlank() && brief.isNotBlank() && (kind != "after_agent" || source != null), height = 44.dp)
    }
    val l = list
    when {
        l == null -> ShimmerList(1)
        l.isEmpty() -> Text(stringResource(R.string.aw_trigger_none), style = Griip.type.body, color = c.textSecondary)
        else -> l.forEach { t ->
            val status = listOfNotNull(
                if (!t.enabled) stringResource(R.string.aw_off) else t.nextRunAt?.takeIf { a.autonomy == AiAutonomy.CONTINUOUS }?.let { stringResource(R.string.aw_trigger_next, TimeFmt.dayHeader(it) + ", " + TimeFmt.clock(it)) } ?: stringResource(R.string.aw_on_short),
                t.lastFiredAt?.let { stringResource(R.string.aw_trigger_last, TimeFmt.relative(it)) } ?: stringResource(R.string.aw_trigger_never),
                t.conversationId?.let { "#" + channelName(it) },
                t.lastError,
            )
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(t.label, style = Griip.type.bodyMedium, color = c.textPrimary)
                        Text(describe(t, nameOf), style = Griip.type.caption, color = c.textSecondary)
                        Text(status.joinToString(" · "), style = Griip.type.caption, color = c.textTertiary)
                    }
                    CircleIconButton(Icons.Outlined.PlayArrow, stringResource(R.string.aw_trigger_run), { run { container.ai.runTrigger(orgId, a.id, t.id) } }, size = 40.dp, tint = c.primary)
                    GriipSwitch(t.enabled, { on -> run { container.ai.updateTrigger(orgId, a.id, t.id, JsonObject(mapOf("rev" to JsonPrimitive(t.rev), "enabled" to JsonPrimitive(on)))) } }, enabled = !busy)
                    CircleIconButton(Icons.Outlined.DeleteOutline, stringResource(R.string.aw_trigger_remove, t.label), { run { container.ai.removeTrigger(orgId, a.id, t.id) } }, size = 40.dp, tint = c.danger)
                }
            }
        }
    }
}

/** Sunday-first weekday names in the phone's language (the server's weekday 0 is Sunday). */
private fun weekdays(): List<String> = java.text.DateFormatSymbols.getInstance().weekdays.drop(1)

private fun pickTime(context: android.content.Context, current: String, onPick: (String) -> Unit) {
    val (h, m) = current.split(':').let { (it.getOrNull(0)?.toIntOrNull() ?: 9) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
    TimePickerDialog(context, { _, hh, mm -> onPick("%02d:%02d".format(hh, mm)) }, h, m, true).show()
}

/** Limits and recovery: per day, at once, longest run, tries, and the active hours triggers run in. */
@Composable
fun LimitsStep(a: AiInstall, d: AiAgentDetail, manage: Boolean, busy: Boolean, patch: AgentPatch) {
    val context = LocalContext.current
    val c = Griip.colors
    val skillLimits = AiTriggerRules.skillLimits(d.definition?.skill?.limits.orEmpty())
    var perDay by remember(a.rev) { mutableStateOf(a.maxJobsPerDay?.toString().orEmpty()) }
    var atOnce by remember(a.rev) { mutableStateOf(a.maxConcurrent?.toString().orEmpty()) }
    var runtime by remember(a.rev) { mutableStateOf(a.maxRuntimeSec?.toString().orEmpty()) }
    var tries by remember(a.rev) { mutableStateOf(a.maxAttempts?.toString().orEmpty()) }
    var hours by remember(a.rev) { mutableStateOf(a.activeHours != null) }
    var from by remember(a.rev) { mutableStateOf(a.activeHours?.from ?: "09:00") }
    var to by remember(a.rev) { mutableStateOf(a.activeHours?.to ?: "18:00") }
    var tz by remember(a.rev) { mutableStateOf(a.activeHours?.timeZone ?: java.util.TimeZone.getDefault().id) }
    var budget by remember(a.rev) { mutableStateOf(a.maxCostMicroPerMonth?.let { "%.2f".format(java.util.Locale.ROOT, it / 1_000_000.0) }.orEmpty()) }
    val num = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number)
    Text(stringResource(R.string.aw_limits_sub), style = Griip.type.bodySmall, color = c.textSecondary)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GriipTextField(perDay, { perDay = it.filter(Char::isDigit).take(5) }, stringResource(R.string.aw_per_day), Modifier.weight(1f), placeholder = stringResource(R.string.aw_no_limit), enabled = manage, keyboardOptions = num)
        GriipTextField(atOnce, { atOnce = it.filter(Char::isDigit).take(2) }, stringResource(R.string.aw_at_once), Modifier.weight(1f), placeholder = stringResource(R.string.aw_platform_default), enabled = manage, keyboardOptions = num)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GriipTextField(runtime, { runtime = it.filter(Char::isDigit).take(6) }, stringResource(R.string.aw_longest_run), Modifier.weight(1f), placeholder = skillLimits?.let { stringResource(R.string.aw_skills_n, it.first) } ?: "", enabled = manage, keyboardOptions = num)
        GriipTextField(tries, { tries = it.filter(Char::isDigit).take(2) }, stringResource(R.string.aw_tries), Modifier.weight(1f), placeholder = skillLimits?.let { stringResource(R.string.aw_skills_n, it.second) } ?: "", enabled = manage, keyboardOptions = num)
    }
    // API 0.41.0: a monthly AI budget of its own, enforced by the server; what it cost this month.
    GriipTextField(
        budget, { budget = it.filter { ch -> ch.isDigit() || ch == '.' || ch == ',' }.take(10) }, stringResource(R.string.aw_budget), placeholder = stringResource(R.string.aw_budget_none),
        helper = stringResource(R.string.aw_budget_spent, com.meldiq.android.data.ai.AiWorkRules.cost(a.costMicroThisMonth)), enabled = manage,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal),
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.aw_active_hours), style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
        GriipSwitch(hours, { hours = it }, enabled = manage)
    }
    if (hours) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ListCard(from, Modifier.weight(1f), subtitle = stringResource(R.string.aw_from), onClick = if (manage) ({ pickTime(context, from) { from = it } }) else null)
            ListCard(to, Modifier.weight(1f), subtitle = stringResource(R.string.aw_to), onClick = if (manage) ({ pickTime(context, to) { to = it } }) else null)
        }
        GriipTextField(tz, { tz = it.take(60) }, stringResource(R.string.aw_time_zone), enabled = manage)
    }
    val saved = stringResource(R.string.aw_limits_saved)
    if (manage) PillButton(stringResource(R.string.aw_limits_save), {
        fun n(s: String): JsonElement = s.toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull
        patch(
            mapOf(
                "maxJobsPerDay" to n(perDay), "maxConcurrent" to (atOnce.toIntOrNull()?.coerceIn(1, 16)?.let(::JsonPrimitive) ?: JsonNull),
                "maxRuntimeSec" to n(runtime), "maxAttempts" to n(tries),
                "maxCostMicroPerMonth" to (com.meldiq.android.data.ai.AiWorkRules.budgetMicro(budget)?.let(::JsonPrimitive) ?: JsonNull),
                "activeHours" to if (hours) JsonObject(mapOf("from" to JsonPrimitive(from), "to" to JsonPrimitive(to), "timeZone" to JsonPrimitive(tz.trim()))) else JsonNull,
            ),
            saved,
        )
    }, Modifier.fillMaxWidth(), enabled = !busy)
}

/** Test & activate: every readiness check, one real test request, and what it did lately (counts only). */
@Composable
fun TestStep(orgId: String, installId: String, readiness: AiReadiness?, canManage: Boolean, permissions: com.meldiq.android.data.ai.AiPermissions) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var activity by remember { mutableStateOf<AiActivity?>(null) }
    var job by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, installId, rev) { activity = runCatching { container.ai.activity(orgId, installId) }.getOrNull() ?: activity }
    val c = Griip.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.aw_readiness), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.weight(1f))
        ReadinessPill(readiness)
    }
    readiness?.let { ReadinessList(it) } ?: ShimmerList(2)
    if (canManage) {
        Text(stringResource(R.string.aw_test_title), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
        Text(stringResource(R.string.aw_test_sub), style = Griip.type.caption, color = c.textSecondary)
        error?.let { StatusBanner(it, BannerKind.Error) }
        PillButton(stringResource(R.string.aw_test_run), {
            busy = true
            error = null
            scope.launch {
                runCatching { container.ai.test(orgId, installId) }.onSuccess { job = it.id }.onFailure { error = it.friendly() }
                busy = false
            }
        }, leadingIcon = Icons.Outlined.Science, loading = busy, height = 42.dp)
        job?.let { JobView(orgId, it, permissions) }
    }
    Text(stringResource(R.string.aw_activity), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
    val a = activity
    if (a == null) ShimmerList(1) else {
        fun line(label: String, value: String) = label to value
        val avg = a.week.averageMs?.let { if (it < 1000) "$it ms" else "%.1f s".format(it / 1000.0) } ?: stringResource(R.string.aw_no_finished)
        listOf(
            line(stringResource(R.string.aw_act_now), stringResource(R.string.aw_act_now_v, a.now.running, a.now.queued, a.now.waiting)),
            line(stringResource(R.string.aw_act_week), stringResource(R.string.aw_act_week_v, a.week.completed, a.week.failed, a.week.cancelled, a.week.retries, avg)),
            line(stringResource(R.string.aw_act_success), a.lastSuccessAt?.let { TimeFmt.relative(it) } ?: stringResource(R.string.aw_none_yet)),
            line(stringResource(R.string.aw_act_failure), a.lastFailure?.let { TimeFmt.relative(it.at) + ": " + it.message } ?: stringResource(R.string.aw_none)),
            line(stringResource(R.string.aw_act_next), a.nextRunAt?.let { TimeFmt.dayHeader(it) + ", " + TimeFmt.clock(it) } ?: stringResource(R.string.aw_act_next_none)),
        ).forEach { (l, v) ->
            Column(Modifier.padding(vertical = 2.dp)) {
                Text(l, style = Griip.type.caption, color = c.textTertiary)
                Text(v, style = Griip.type.body, color = c.textPrimary)
            }
        }
    }
}

/**
 * Reading channels (API 0.40.0): where it reads, switching reading on for a channel or everywhere, and off, each with a
 * reason the channel sees. Each member still decides whether their own messages are shared.
 */
@Composable
fun ReadingCard(orgId: String, installId: String, channels: List<ConversationEntity>, manage: Boolean) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<AiInstallReaders?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var channel by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(orgId, installId, reload) { runCatching { container.ai.installReaders(orgId, installId) }.onSuccess { data = it; error = null }.onFailure { error = it.friendly() } }
    fun run(block: suspend () -> Unit) {
        busy = true
        scope.launch {
            runCatching { block() }.onFailure { error = it.friendly() }
            reload++
            busy = false
        }
    }
    val c = Griip.colors
    val ok = reason.trim().length >= 8
    Text(stringResource(R.string.aw_reading_title), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
    Text(stringResource(R.string.aw_reading_sub), style = Griip.type.caption, color = c.textSecondary)
    error?.let { StatusBanner(it, BannerKind.Error) }
    val d = data
    if (d == null) {
        ShimmerList(1)
        return
    }
    if (!d.readingEnabled) Text(stringResource(R.string.aw_reading_off), style = Griip.type.body, color = c.textSecondary)
    if (d.readers.isEmpty()) Text(stringResource(R.string.aw_reading_none), style = Griip.type.body, color = c.textSecondary)
    d.readers.forEach { r ->
        ListCard(
            "#" + (r.conversationName ?: stringResource(R.string.aw_channel)),
            subtitle = stringResource(R.string.aw_reading_since, TimeFmt.relative(r.since), r.turnedOnBy?.name.orEmpty(), r.reason),
            trailing = if (manage) ({ PillButton(stringResource(R.string.aw_reading_stop), { run { container.ai.turnOffReader(orgId, installId, r.readerId, reason.trim()) } }, tone = ButtonTone.Glass, enabled = !busy && ok, height = 34.dp) }) else null,
        )
    }
    if (manage && d.readingEnabled) {
        GriipTextField(reason, { reason = it.take(500) }, stringResource(R.string.aw_reading_reason), placeholder = stringResource(R.string.aw_reading_reason_ph), helper = stringResource(R.string.aw_reading_reason_helper))
        val reading = d.readers.map { it.conversationId }.toSet()
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            channels.filter { it.id !in reading }.forEach { ch -> PillChip("#" + ch.name.orEmpty(), channel == ch.id, { channel = ch.id }) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillButton(stringResource(R.string.aw_reading_this), { channel?.let { id -> run { container.ai.turnOnReader(orgId, installId, id, reason.trim()) } } }, enabled = !busy && ok && channel != null, height = 40.dp)
            PillButton(stringResource(R.string.aw_reading_all), { run { container.ai.readEverywhere(orgId, installId, reason.trim()) } }, tone = ButtonTone.Glass, enabled = !busy && ok, height = 40.dp)
        }
        Text(stringResource(R.string.aw_reading_told), style = Griip.type.caption, color = c.textTertiary)
    }
}

