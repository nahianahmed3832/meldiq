package com.meldiq.android.ui.screens.ai

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Assignment
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.data.ai.AiNewTask
import com.meldiq.android.data.ai.AiOverview
import com.meldiq.android.data.ai.AiTask
import com.meldiq.android.data.ai.AiTaskEvent
import com.meldiq.android.data.ai.AiTaskSettings
import com.meldiq.android.data.ai.AiTaskStates
import com.meldiq.android.data.ai.AiTasksPage
import com.meldiq.android.data.ai.AgentRules
import com.meldiq.android.data.api.CustomRoleDto
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Calendar

@Composable
fun taskStateLabel(state: String): String = stringResource(
    when (state) {
        "waiting" -> R.string.aw_task_waiting
        "open" -> R.string.aw_task_open
        "accepted" -> R.string.aw_task_accepted
        "in_progress" -> R.string.aw_task_in_progress
        "blocked" -> R.string.aw_task_blocked
        "submitted" -> R.string.aw_task_submitted
        "done" -> R.string.aw_task_done
        "cancelled" -> R.string.aw_task_cancelled
        else -> R.string.aw_state_unknown
    },
)

@Composable
private fun priorityLabel(p: String): String = stringResource(
    when (p) {
        "low" -> R.string.aw_priority_low
        "high" -> R.string.aw_priority_high
        "urgent" -> R.string.aw_priority_urgent
        else -> R.string.aw_priority_normal
    },
)

@Composable
private fun actionLabel(a: String): String = stringResource(
    when (a) {
        AiTaskStates.ACCEPT -> R.string.aw_task_do_accept
        AiTaskStates.START -> R.string.aw_task_do_start
        AiTaskStates.BLOCK -> R.string.aw_task_do_block
        AiTaskStates.SUBMIT -> R.string.aw_task_do_submit
        AiTaskStates.APPROVE -> R.string.aw_task_do_approve
        AiTaskStates.RETURN -> R.string.aw_task_do_return
        AiTaskStates.CANCEL -> R.string.aw_task_do_cancel
        else -> R.string.aw_task_do_reassign
    },
)

@Composable
private fun dueText(dueAt: Long?, overdue: Boolean): String = when {
    dueAt == null -> stringResource(R.string.aw_task_no_due)
    overdue -> stringResource(R.string.aw_task_overdue, TimeFmt.dayHeader(dueAt) + ", " + TimeFmt.clock(dueAt))
    else -> stringResource(R.string.aw_task_due, TimeFmt.dayHeader(dueAt) + ", " + TimeFmt.clock(dueAt))
}

/**
 * Tasks for people (as Meldiq Web's TasksTab, server AI_WORKFORCE_2_PLAN.md phase 4): work the Agent Manager or an admin
 * gives someone. The assignee accepts, works and hands in a note or files; someone else accepts it or sends it back.
 * The server says what this person may do with each task; this only shows those actions. Not end-to-end encrypted.
 */
@Composable
fun TasksTab(orgId: String, o: AiOverview, open: String? = null) {
    val container = LocalContainer.current
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var scope by rememberSaveable { mutableStateOf("mine") }
    var page by remember { mutableStateOf<AiTasksPage?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var opened by remember { mutableStateOf(open) }
    var creating by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(orgId, scope, rev, reload) {
        runCatching { container.ai.tasks(orgId, scope) }.onSuccess { page = it; error = null }.onFailure { error = it.friendly() }
    }
    val c = Griip.colors
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusBanner(stringResource(R.string.aw_task_notice), BannerKind.Info)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.aw_tasks_sub), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.weight(1f))
            if (o.permissions.canManage) PillButton(stringResource(R.string.aw_task_new), { creating = true }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, height = 38.dp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillChip(stringResource(R.string.aw_tasks_mine), scope == "mine", { scope = "mine" })
            PillChip(stringResource(R.string.aw_tasks_created), scope == "created", { scope = "created" })
            if (o.permissions.canManage) PillChip(stringResource(R.string.aw_requests_all), scope == "all", { scope = "all" })
        }
        error?.let { StatusBanner(it, BannerKind.Error) }
        val p = page
        when {
            p == null -> ShimmerList(2)
            p.tasks.isEmpty() -> EmptyState(Icons.Outlined.Assignment, stringResource(R.string.aw_tab_tasks), stringResource(if (scope == "mine") R.string.aw_tasks_none_mine else R.string.aw_tasks_none))
            else -> p.tasks.forEach { t ->
                val who = if (scope == "mine") stringResource(R.string.aw_task_from, t.agent?.name ?: t.createdBy.name) else stringResource(R.string.aw_task_for, t.assignee.name)
                ListCard(
                    t.title,
                    subtitle = listOf(taskStateLabel(t.state), who, dueText(t.dueAt, t.overdue)).joinToString(" · "),
                    trailing = { if (t.priority != "normal") TagPill(priorityLabel(t.priority), if (t.priority == "low") c.textSecondary else c.warning, if (t.priority == "low") c.surfaceVariant else c.warningSoft) },
                    onClick = { opened = t.id },
                )
            }
        }
        if (scope == "all") p?.report?.let { r ->
            Text(stringResource(R.string.aw_task_report), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
            Text(
                (r.byState.entries.map { (s, n) -> "${taskStateLabel(s)}: $n" } + stringResource(R.string.aw_task_report_overdue, r.overdue)).joinToString(" · "),
                style = Griip.type.bodySmall, color = c.textSecondary,
            )
            r.byAssignee.forEach { a ->
                Text(stringResource(R.string.aw_task_report_person, a.person.name, a.active, a.overdue), style = Griip.type.caption, color = c.textSecondary)
            }
        }
        if (o.permissions.canManage) AssignmentCard(orgId)
    }
    opened?.let { id -> TaskSheet(orgId, id, onDismiss = { opened = null }, onChanged = { reload++ }) }
    if (creating) NewTaskSheet(orgId, onDismiss = { creating = false }, onCreated = { creating = false; reload++; opened = it })
}

/** Who the Agent Manager may give work to: roles and people. Nobody until set. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AssignmentCard(orgId: String) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<AiTaskSettings?>(null) }
    var roles by remember { mutableStateOf<List<CustomRoleDto>>(emptyList()) }
    var members by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(orgId) {
        runCatching { container.ai.taskSettings(orgId) }.onSuccess { settings = it }.onFailure { error = it.friendly() }
        roles = runCatching { container.roles.roles(orgId).roles }.getOrDefault(emptyList())
        members = runCatching { container.orgs.members(orgId) }.getOrDefault(emptyList())
    }
    fun save(r: List<String>, u: List<String>) {
        busy = true
        scope.launch {
            runCatching { container.ai.setTaskSettings(orgId, r, u) }.onSuccess { settings = it; error = null }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.aw_assign_title), style = Griip.type.section, color = c.textSecondary)
        Text(stringResource(R.string.aw_assign_sub), style = Griip.type.caption, color = c.textSecondary)
        error?.let { StatusBanner(it, BannerKind.Error) }
        val s = settings
        if (s == null) {
            ShimmerList(1)
            return@Column
        }
        if (roles.isEmpty()) Text(stringResource(R.string.aw_assign_no_roles), style = Griip.type.caption, color = c.textTertiary)
        else FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            roles.forEach { r -> PillChip(r.name, r.id in s.roles, { if (!busy) save(if (r.id in s.roles) s.roles - r.id else s.roles + r.id, s.users) }) }
        }
        s.users.forEach { u ->
            ListCard(
                members.firstOrNull { it.id == u }?.displayName ?: u,
                trailing = { PillButton(stringResource(R.string.aw_remove), { save(s.roles, s.users - u) }, tone = ButtonTone.Glass, height = 34.dp, enabled = !busy) },
            )
        }
        PillButton(stringResource(R.string.aw_assign_add_person), { picking = true }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, height = 38.dp, enabled = !busy)
        Text(
            if (s.eligible.isEmpty()) stringResource(R.string.aw_assign_nobody)
            else stringResource(R.string.aw_assign_eligible, s.eligible.joinToString { p -> p.name + if (p.roles.isNotEmpty()) " (${p.roles.joinToString()})" else "" }),
            style = Griip.type.caption, color = c.textSecondary,
        )
    }
    if (picking) PersonPicker(members.filter { it.id !in settings?.users.orEmpty() }, onPick = { picking = false; settings?.let { s -> save(s.roles, s.users + it.id) } }, onDismiss = { picking = false })
}

/** Picks one community member (with a search line for long lists). */
@Composable
fun PersonPicker(people: List<UserDto>, onPick: (UserDto) -> Unit, onDismiss: () -> Unit) {
    var q by remember { mutableStateOf("") }
    GlassSheet(onDismiss, title = stringResource(R.string.aw_pick_person)) {
        GriipTextField(q, { q = it }, stringResource(R.string.aw_pick_search))
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 16.dp)) {
            people.filter { q.isBlank() || it.displayName.contains(q, true) || it.username.contains(q, true) }.forEach { u ->
                ListCard(u.displayName, subtitle = "@" + u.username, onClick = { onPick(u) })
            }
        }
    }
}

/** A new task for one person: what to do, what to hand in, when, how urgent. */
@Composable
private fun NewTaskSheet(orgId: String, onDismiss: () -> Unit, onCreated: (String) -> Unit) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var members by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var title by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var deliverables by remember { mutableStateOf("") }
    var assignee by remember { mutableStateOf<UserDto?>(null) }
    var dueAt by remember { mutableStateOf<Long?>(null) }
    var priority by remember { mutableStateOf("normal") }
    var picking by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId) { members = runCatching { container.orgs.members(orgId) }.getOrDefault(emptyList()) }
    fun pickDue() {
        val cal = Calendar.getInstance().apply { dueAt?.let { timeInMillis = it } }
        DatePickerDialog(context, { _, y, m, d ->
            TimePickerDialog(context, { _, h, min ->
                dueAt = Calendar.getInstance().apply { set(y, m, d, h, min, 0) }.timeInMillis
            }, cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(context)).show()
        }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)).show()
    }
    val c = Griip.colors
    GlassSheet(onDismiss, title = stringResource(R.string.aw_task_new)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            GriipTextField(title, { title = it.take(120) }, stringResource(R.string.aw_task_title))
            GriipTextField(instructions, { instructions = it.take(4000) }, stringResource(R.string.aw_task_instructions), singleLine = false, minLines = 3)
            GriipTextField(deliverables, { deliverables = it.take(1000) }, stringResource(R.string.aw_task_deliverables))
            ListCard(assignee?.displayName ?: stringResource(R.string.aw_task_choose_person), subtitle = stringResource(R.string.aw_task_for_label), onClick = { picking = true })
            ListCard(dueAt?.let { TimeFmt.dayHeader(it) + ", " + TimeFmt.clock(it) } ?: stringResource(R.string.aw_task_no_due), subtitle = stringResource(R.string.aw_task_due_label), onClick = ::pickDue,
                trailing = dueAt?.let { { PillButton(stringResource(R.string.aw_clear), { dueAt = null }, tone = ButtonTone.Glass, height = 34.dp) } })
            Text(stringResource(R.string.aw_task_priority), style = Griip.type.label, color = c.textSecondary)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { AiTaskStates.PRIORITIES.forEach { p -> PillChip(priorityLabel(p), p == priority, { priority = p }) } }
            Text(stringResource(R.string.aw_task_notice), style = Griip.type.caption, color = c.textTertiary)
            error?.let { StatusBanner(it, BannerKind.Error) }
            PillButton(stringResource(R.string.aw_task_give), {
                val who = assignee ?: return@PillButton
                busy = true
                scope.launch {
                    runCatching { container.ai.createTask(orgId, AiNewTask(title.trim(), instructions.trim(), deliverables.trim(), who.id, dueAt, priority)) }
                        .onSuccess { onCreated(it.id) }.onFailure { error = it.friendly() }
                    busy = false
                }
            }, Modifier.fillMaxWidth(), enabled = !busy && title.isNotBlank() && instructions.isNotBlank() && assignee != null, loading = busy)
        }
    }
    if (picking) PersonPicker(members, onPick = { assignee = it; picking = false }, onDismiss = { picking = false })
}

/** One task: what to do, what was handed in, the actions the server allows this person, and its history. */
@Composable
private fun TaskSheet(orgId: String, taskId: String, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var task by remember { mutableStateOf<AiTask?>(null) }
    var events by remember { mutableStateOf<List<AiTaskEvent>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var form by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var files by remember { mutableStateOf<List<Pair<java.io.File, String>>>(emptyList()) }
    var assignee by remember { mutableStateOf<UserDto?>(null) }
    var members by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var picking by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(orgId, taskId, rev, reload) {
        runCatching { container.ai.task(orgId, taskId) }.onSuccess { task = it.task; events = it.events; error = null }.onFailure { error = it.friendly() }
    }
    LaunchedEffect(form) { if (form == AiTaskStates.REASSIGN && members.isEmpty()) members = runCatching { container.orgs.members(orgId) }.getOrDefault(emptyList()) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        scope.launch { files = files + withContext(Dispatchers.IO) { uris.mapNotNull { copyForUpload(context, it) } } }
    }
    fun run(action: String) {
        val t = task ?: return
        busy = true
        error = null
        scope.launch {
            runCatching {
                val ids = if (action == AiTaskStates.SUBMIT) files.map { (f, name) -> container.ai.upload(orgId, f, name, AgentRules.mimeOf(name, null)) {}.id } else emptyList()
                container.ai.taskAction(orgId, t.id, action, AiTaskStates.body(t, action, text, ids, assignee?.id))
            }.onSuccess {
                task = it
                form = null; text = ""; files.forEach { (f, _) -> f.delete() }; files = emptyList(); assignee = null
                reload++; onChanged()
            }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val c = Griip.colors
    GlassSheet(onDismiss, title = task?.title ?: stringResource(R.string.aw_tab_tasks)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            error?.let { StatusBanner(it, BannerKind.Error) }
            val t = task
            if (t == null) {
                if (error == null) ShimmerList(2)
                return@Column
            }
            val from = t.agent?.let { stringResource(R.string.aw_task_from_agent, it.name, t.createdBy.name) } ?: stringResource(R.string.aw_task_from, t.createdBy.name)
            Text(listOf(taskStateLabel(t.state), stringResource(R.string.aw_task_for, t.assignee.name), from, dueText(t.dueAt, t.overdue)).joinToString(" · "), style = Griip.type.caption, color = c.textSecondary)
            Text(t.instructions, style = Griip.type.body, color = c.textPrimary)
            if (t.deliverables.isNotBlank()) Text(stringResource(R.string.aw_task_hand_in, t.deliverables), style = Griip.type.bodySmall, color = c.textSecondary)
            t.blockedReason?.takeIf { t.state == "blocked" }?.let { StatusBanner(stringResource(R.string.aw_task_blocked_because, it), BannerKind.Warning) }
            t.returnReason?.takeIf { t.state == "in_progress" }?.let { StatusBanner(stringResource(R.string.aw_task_sent_back, it), BannerKind.Warning) }
            t.cancelReason?.takeIf { t.state == "cancelled" }?.let { StatusBanner(stringResource(R.string.aw_task_cancelled_because, it), BannerKind.Info) }
            if (t.references.isNotEmpty()) {
                Text(stringResource(R.string.aw_task_references), style = Griip.type.section, color = c.textSecondary)
                t.references.forEach { AiFileRow(orgId, it) }
            }
            if (t.submissionNote != null || t.files.isNotEmpty()) {
                Text(stringResource(R.string.aw_task_handed_in) + (t.submittedAt?.let { " · " + TimeFmt.relative(it) } ?: ""), style = Griip.type.section, color = c.textSecondary)
                t.submissionNote?.let { Text(it, style = Griip.type.body, color = c.textPrimary) }
                t.files.forEach { AiFileRow(orgId, it) }
            }
            val allowed = t.can.allowed()
            if (allowed.isNotEmpty() && form == null) androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                allowed.forEach { a ->
                    val primary = a == AiTaskStates.APPROVE || a == AiTaskStates.ACCEPT || a == AiTaskStates.SUBMIT
                    PillButton(actionLabel(a), { if (AiTaskStates.needsForm(a)) form = a else run(a) }, tone = if (primary) ButtonTone.Primary else ButtonTone.Glass, enabled = !busy, height = 40.dp)
                }
            }
            form?.let { a ->
                if (a == AiTaskStates.REASSIGN) ListCard(assignee?.displayName ?: stringResource(R.string.aw_task_choose_person), subtitle = stringResource(R.string.aw_task_give_to), onClick = { picking = true })
                else GriipTextField(
                    text, { text = it.take(4000) },
                    stringResource(
                        when (a) {
                            AiTaskStates.SUBMIT -> R.string.aw_task_note
                            AiTaskStates.BLOCK -> R.string.aw_task_blocking
                            AiTaskStates.RETURN -> R.string.aw_task_changes
                            else -> R.string.aw_task_why
                        },
                    ),
                    singleLine = false, minLines = 3,
                )
                if (a == AiTaskStates.SUBMIT) {
                    files.forEach { (f, name) -> Text(name + " · " + sizeText(f.length()), style = Griip.type.caption, color = c.textSecondary) }
                    PillButton(stringResource(R.string.aw_ask_add_files), { pick.launch(arrayOf("*/*")) }, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.AttachFile, height = 38.dp)
                    Text(stringResource(R.string.aw_task_notice), style = Griip.type.caption, color = c.textTertiary)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton(actionLabel(a), { run(a) }, enabled = !busy && AiTaskStates.formReady(a, text, files.size, assignee?.id), loading = busy, height = 42.dp)
                    PillButton(stringResource(R.string.aw_job_cancel), { form = null }, tone = ButtonTone.Glass, enabled = !busy, height = 42.dp)
                }
            }
            if (events.isNotEmpty()) {
                Text(stringResource(R.string.aw_task_history), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
                events.forEach { e ->
                    val detail = (e.detail["reason"] ?: e.detail["note"])?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
                    Text(
                        listOfNotNull(e.kind.replace('_', ' ') + (e.actor?.let { " · " + it.name } ?: ""), detail, TimeFmt.relative(e.at)).joinToString(" · "),
                        style = Griip.type.caption, color = c.textSecondary,
                    )
                }
            }
        }
    }
    if (picking) PersonPicker(members.filter { it.id != task?.assignee?.id }, onPick = { assignee = it; picking = false }, onDismiss = { picking = false })
}

/** Copies a picked document into the app's cache for upload; (file, display name), or null when unreadable. */
fun copyForUpload(context: android.content.Context, uri: android.net.Uri): Pair<java.io.File, String>? = runCatching {
    val cr = context.contentResolver
    val name = cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "file"
    val out = java.io.File(java.io.File(context.cacheDir, "ai-uploads").apply { mkdirs() }, "${System.nanoTime()}-" + name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(120))
    cr.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return null
    out to name.take(200)
}.getOrNull()

