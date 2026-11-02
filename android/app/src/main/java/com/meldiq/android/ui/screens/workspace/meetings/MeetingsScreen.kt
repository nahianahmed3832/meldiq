package com.meldiq.android.ui.screens.workspace.meetings

import android.content.Intent
import android.provider.CalendarContract
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.ConversationDto
import com.meldiq.android.data.api.MeetingDto
import com.meldiq.android.data.api.MeetingReq
import com.meldiq.android.data.api.MeetingRes
import com.meldiq.android.data.api.MeetingRespondReq
import com.meldiq.android.data.api.MeetingsRes
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch
import java.time.ZoneId

/**
 * A workspace's upcoming meetings (round 7 slice C5, docs/WORKSPACE_C5.md). Meetings happen in voice rooms; joining one
 * joins that room's call. "Add to my calendar" hands the meeting to the phone's own calendar app (nothing is read
 * from it, and no calendar permission is asked for).
 */
@Composable
fun MeetingsScreen(nav: NavHostController, orgId: String, canSchedule: Boolean) {
    val container = LocalContainer.current
    val c = Griip.colors
    val zone = remember { ZoneId.systemDefault().id }
    var meetings by remember { mutableStateOf<List<MeetingDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<MeetingDto?>(null) }
    var editing by remember { mutableStateOf<MeetingDto?>(null) }
    var creating by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        runCatching { container.api.get<MeetingsRes>("/v1/orgs/$orgId/meetings").meetings }.onSuccess { meetings = it; error = null }.onFailure { error = it.friendly() }
    }
    LaunchedEffect(Unit) { container.messages.meetingUpdates.collect { if (it == orgId) reload++ } }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding())) {
            item { GriipTopBar(stringResource(R.string.mtg_title), onBack = { nav.popBackStack() }) }
            error?.let { e -> item { StatusBanner(e, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 6.dp)) } }
            val list = meetings
            if (list == null && error == null) item { ShimmerList(3) }
            if (list != null && list.isEmpty()) item { EmptyState(Icons.Outlined.Event, stringResource(R.string.mtg_empty), stringResource(R.string.mtg_empty_body)) }
            items(list.orEmpty(), key = { it.id }) { m ->
                ListCard(
                    m.title, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                    subtitle = listOfNotNull(
                        MeetingRules.whenText(m.startsAt, m.endsAt, zone), m.room?.name?.let { "#$it" },
                        m.repeat?.let { repeatLabel(it, m.startsAt, zone) }, responseLabel(m), if (m.cancelled) stringResource(R.string.mtg_cancelled) else null,
                    ).joinToString(" · "),
                    leading = { IconTile(Icons.Outlined.Event, if (m.cancelled) c.textTertiary else c.primary, if (m.cancelled) c.surfaceVariant else c.primarySoft, size = 44.dp) },
                    onClick = { open = m },
                )
            }
        }
        if (canSchedule) ExtendedFloatingActionButton(
            onClick = { creating = true }, icon = { Icon(Icons.Rounded.Add, null) }, text = { Text(stringResource(R.string.mtg_new)) },
            containerColor = c.actionStart, contentColor = c.onAction,
            modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(16.dp),
        )
    }
    open?.let { m -> MeetingSheet(m, zone, onChanged = { open = it; reload++ }, onEdit = { open = null; editing = m }, onDismiss = { open = null }) }
    if (creating || editing != null) MeetingEditor(orgId, editing, zone, onSaved = { creating = false; editing = null; reload++ }, onDismiss = { creating = false; editing = null })
}

@Composable
private fun responseLabel(m: MeetingDto): String? = when (m.myResponse) {
    "accepted" -> stringResource(R.string.mtg_going)
    "declined" -> stringResource(R.string.mtg_not_going)
    "tentative" -> stringResource(R.string.mtg_maybe)
    "pending" -> stringResource(R.string.mtg_reply_needed)
    else -> null
}

@Composable
private fun MeetingSheet(m: MeetingDto, zone: String, onChanged: (MeetingDto) -> Unit, onEdit: () -> Unit, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val permission = com.meldiq.android.ui.screens.calls.rememberCallPermission()
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    fun call(block: suspend () -> MeetingDto) = scope.launch { runCatching { block() }.onSuccess(onChanged).onFailure { error = it.friendly() } }
    GlassSheet(onDismiss, title = m.title) {
        Text(MeetingRules.whenText(m.startsAt, m.endsAt, zone) + (m.room?.name?.let { " · #$it" } ?: ""), style = Griip.type.body, color = c.textPrimary)
        Text(stringResource(R.string.mtg_organizer, m.organizer.name.orEmpty()), style = Griip.type.caption, color = c.textSecondary)
        m.description?.let { Text(it, style = Griip.type.bodySmall, color = c.textPrimary, modifier = Modifier.padding(top = 6.dp)) }
        if (m.cancelled) StatusBanner(stringResource(R.string.mtg_cancelled), BannerKind.Warning, Modifier.padding(vertical = 6.dp))
        Text(com.meldiq.android.ui.screens.community.peopleCountLabel(m.participants.size + 1), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
        Text(m.participants.joinToString(", ") { "${it.name.orEmpty()}${when (it.response) { "accepted" -> " ✓"; "declined" -> " ✗"; "tentative" -> " ?"; else -> "" }}" }, style = Griip.type.bodySmall, color = c.textPrimary)
        if (!m.cancelled) {
            if (m.myResponse != null) ChipRow(Modifier.padding(top = 8.dp)) {
                listOf("accepted" to R.string.mtg_going, "tentative" to R.string.mtg_maybe, "declined" to R.string.mtg_not_going).forEach { (r, label) ->
                    PillChip(stringResource(label), m.myResponse == r, {
                        call { container.api.post<MeetingRespondReq, MeetingRes>("/v1/meetings/${m.id}/respond", MeetingRespondReq(r)).meeting }
                    })
                }
            }
            Spacer(Modifier.height(8.dp))
            m.room?.let { room ->
                PillButton(stringResource(R.string.mtg_join), {
                    permission(false) {
                        container.scope.launch { container.calls.startCall(room.id, false) }
                        onDismiss()
                    }
                }, Modifier.fillMaxWidth(), height = 48.dp)
            }
            PillButton(stringResource(R.string.mtg_add_calendar), {
                val i = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, m.title)
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, m.startsAt)
                    .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, m.endsAt)
                    .putExtra(CalendarContract.Events.EVENT_LOCATION, m.room?.name?.let { "Meldiq #$it" })
                    .putExtra(CalendarContract.Events.DESCRIPTION, m.description.orEmpty())
                runCatching { ctx.startActivity(i) }.onFailure { error = ctx.getString(R.string.mtg_no_calendar) }
            }, Modifier.fillMaxWidth().padding(top = 6.dp), tone = ButtonTone.Glass, height = 44.dp)
            if (m.canEdit) Row(Modifier.padding(top = 6.dp)) {
                PillButton(stringResource(R.string.mtg_edit), onEdit, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
                Spacer(Modifier.padding(4.dp))
                PillButton(stringResource(R.string.mtg_cancel_meeting), { call { container.api.post<MeetingRes>("/v1/meetings/${m.id}/cancel").meeting } }, Modifier.weight(1f), tone = ButtonTone.Danger, height = 44.dp)
            }
        }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger) }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun MeetingEditor(orgId: String, meeting: MeetingDto?, zone: String, onSaved: () -> Unit, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    val initial = remember { meeting?.let { MeetingRules.fields(it.startsAt, it.endsAt, zone) } ?: MeetingRules.nextSlot(System.currentTimeMillis(), zone).let { (d, t) -> Triple(d, t, 30) } }
    var title by remember { mutableStateOf(meeting?.title.orEmpty()) }
    var date by remember { mutableStateOf(initial.first) }
    var time by remember { mutableStateOf(initial.second) }
    var minutes by remember { mutableIntStateOf(initial.third) }
    var roomId by remember { mutableStateOf(meeting?.room?.id) }
    var description by remember { mutableStateOf(meeting?.description.orEmpty()) }
    // Batch B8b: how the event repeats (servers with `event-repeat`).
    var repeat by remember { mutableStateOf(meeting?.repeat ?: com.meldiq.android.data.model.EventRepeatRules.NONE) }
    var repeatAvailable by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { repeatAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.EVENT_REPEAT) == true }
    var people by remember { mutableStateOf(meeting?.participants.orEmpty().associate { it.id to it.name.orEmpty() }) }
    var rooms by remember { mutableStateOf<List<ConversationDto>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId) {
        rooms = runCatching { container.orgs.channels(orgId).filter { it.voice && !it.archived } }.getOrDefault(emptyList())
    }
    LaunchedEffect(query) { found = if (query.trim().length < 2) emptyList() else runCatching { container.orgs.members(orgId, query.trim()) }.getOrDefault(emptyList()) }
    val problems = MeetingRules.problems(title, roomId, date, time, zone, System.currentTimeMillis())

    // 2026-10-23 (the reference's event wizard): 1 where, 2 what and when, 3 a preview of the card before saving.
    var step by remember { mutableIntStateOf(1) }
    val stepOk = when (step) {
        1 -> roomId != null
        2 -> problems.isEmpty()
        else -> true
    }
    GlassSheet(onDismiss, title = stringResource(if (meeting == null) R.string.mtg_new else R.string.mtg_edit)) {
        Text(stringResource(R.string.ux_step_of, step, 3), style = Griip.type.label, color = c.textSecondary)
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
            when (step) {
                1 -> {
                    Text(stringResource(R.string.ux_event_where), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(vertical = 8.dp))
                    Text(stringResource(R.string.mtg_room), style = Griip.type.label, color = c.textSecondary)
                    if (rooms.isEmpty()) Text(stringResource(R.string.mtg_no_rooms), style = Griip.type.caption, color = c.textSecondary)
                    ChipRow(Modifier.padding(horizontal = 0.dp)) { rooms.forEach { r -> PillChip("#${r.name.orEmpty()}", roomId == r.id, { roomId = r.id }) } }
                }
                2 -> {
                    Text(stringResource(R.string.ux_event_what), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(vertical = 8.dp))
                    GriipTextField(title, { title = it.take(120) }, stringResource(R.string.mtg_field_title))
                    Row {
                        GriipTextField(date, { date = it.take(10) }, stringResource(R.string.mtg_field_date), Modifier.weight(1f))
                        Spacer(Modifier.padding(4.dp))
                        GriipTextField(time, { time = it.take(5) }, stringResource(R.string.mtg_field_time), Modifier.weight(1f), helper = zone)
                    }
                    ChipRow(Modifier.padding(horizontal = 0.dp)) { MeetingRules.DURATIONS.forEach { d -> PillChip(stringResource(R.string.mtg_minutes, d), minutes == d, { minutes = d }) } }
                    if (repeatAvailable) {
                        Text(stringResource(R.string.b8b_repeat), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
                        val startForLabel = MeetingRules.startMs(date, time, zone)
                        ChipRow(Modifier.padding(horizontal = 0.dp)) {
                            com.meldiq.android.data.model.EventRepeatRules.CHOICES.forEach { r -> PillChip(repeatLabel(r, startForLabel, zone), repeat == r, { repeat = r }) }
                        }
                    }
                    Text(stringResource(R.string.mtg_invite_people), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
                    people.forEach { (id, n) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(n, style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
                            CircleIconButton(Icons.Rounded.Close, stringResource(R.string.grp_remove_member), { people = people - id }, size = 36.dp, tint = c.textSecondary)
                        }
                    }
                    SearchPill(query, { query = it }, stringResource(R.string.grp_add_member))
                    found.filter { it.id !in people }.take(6).forEach { u ->
                        PillButton("${u.displayName} · @${u.username}", { people = people + (u.id to u.displayName); query = "" }, Modifier.fillMaxWidth().padding(vertical = 2.dp), tone = ButtonTone.Glass, height = 40.dp)
                    }
                    GriipTextField(description, { description = it.take(2000) }, stringResource(R.string.mtg_field_description), singleLine = false)
                    problems.firstOrNull()?.let { Text(it, style = Griip.type.caption, color = c.warning) }
                }
                else -> {
                    Text(stringResource(R.string.ux_event_preview), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(vertical = 8.dp))
                    val startMs = MeetingRules.startMs(date, time, zone)
                    com.meldiq.android.ui.components.GlassCard(Modifier.fillMaxWidth()) {
                        startMs?.let { Text(com.meldiq.android.ui.TimeFmt.dayHeader(it) + " · " + com.meldiq.android.ui.TimeFmt.clock(it) + " · " + stringResource(R.string.mtg_minutes, minutes), style = Griip.type.label, color = c.primary) }
                        Text(title.trim(), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(top = 4.dp))
                        rooms.firstOrNull { it.id == roomId }?.let { Text("#" + it.name.orEmpty(), style = Griip.type.bodySmall, color = c.textSecondary) }
                        if (people.isNotEmpty()) Text(stringResource(R.string.ux_event_invited, people.size), style = Griip.type.caption, color = c.textSecondary)
                        if (description.isNotBlank()) Text(description.trim(), style = Griip.type.bodySmall, color = c.textSecondary, maxLines = 4, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
        }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger) }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp)) {
            if (step > 1) PillButton(stringResource(R.string.ux_back), { step-- }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 48.dp)
            if (step < 3) PillButton(stringResource(R.string.ux_next), { step++ }, Modifier.weight(1f), enabled = stepOk, height = 48.dp)
            else PillButton(stringResource(R.string.mtg_save), {
                val start = MeetingRules.startMs(date, time, zone) ?: return@PillButton
                val req = MeetingReq(
                    roomId.orEmpty(), title.trim(), description.trim().ifEmpty { null }, start, start + minutes * 60_000L, zone, people.keys.toList(), meeting?.rev,
                    repeat = repeat.takeIf { repeatAvailable },
                )
                scope.launch {
                    runCatching {
                        if (meeting == null) container.api.post<MeetingReq, MeetingRes>("/v1/orgs/$orgId/meetings", req) else container.api.put<MeetingReq, MeetingRes>("/v1/meetings/${meeting.id}", req)
                    }.onSuccess { onSaved() }.onFailure { error = it.friendly() }
                }
            }, Modifier.weight(1f), enabled = problems.isEmpty(), height = 48.dp)
        }
        Spacer(Modifier.height(16.dp))
    }
}


/** Batch B8b: "Does not repeat", "Weekly on Wednesday", "Every other Wednesday", "Monthly on the third Wednesday", "Every year". */
@Composable
private fun repeatLabel(repeat: String, startMs: Long?, zone: String): String {
    val (weekday, nth) = startMs?.let { com.meldiq.android.data.model.EventRepeatRules.weekdayAndNth(it, zone) } ?: (null to null)
    val day = weekday?.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault()).orEmpty()
    return when (repeat) {
        com.meldiq.android.data.model.EventRepeatRules.WEEKLY -> stringResource(R.string.b8b_weekly, day)
        com.meldiq.android.data.model.EventRepeatRules.BIWEEKLY -> stringResource(R.string.b8b_biweekly, day)
        com.meldiq.android.data.model.EventRepeatRules.MONTHLY -> stringResource(
            when (nth) {
                1 -> R.string.b8b_monthly_1
                2 -> R.string.b8b_monthly_2
                3 -> R.string.b8b_monthly_3
                4 -> R.string.b8b_monthly_4
                else -> R.string.b8b_monthly_last
            },
            day,
        )
        com.meldiq.android.data.model.EventRepeatRules.YEARLY -> stringResource(R.string.b8b_yearly)
        else -> stringResource(R.string.b8b_once)
    }
}
