package com.meldiq.android.ui.screens.moderation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.ReportDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.SegmentedPills
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * The moderators' report queue (batch B4, `reports.view`): Open and Closed. Each report shows the reason, who was
 * reported, where, what the reporter shared and their note; Mark as handled or Dismiss (with a note for the other
 * moderators), or Reopen. Never who reported. Take action (time out, ban) from Members, then mark it handled.
 */
@Composable
fun ReportsScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var closed by remember { mutableStateOf(false) }
    var reports by remember { mutableStateOf<List<ReportDto>?>(null) }
    var open by remember { mutableStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var closing by remember { mutableStateOf<Pair<ReportDto, String>?>(null) }
    var reload by remember { mutableStateOf(0) }
    var isOwner by remember { mutableStateOf(false) }
    LaunchedEffect(orgId) { isOwner = container.orgs.cachedOrgs()?.firstOrNull { it.id == orgId }?.myRole == "OWNER" }
    LaunchedEffect(closed, reload) {
        reports = null
        runCatching { container.reports.list(orgId, closed) }
            .onSuccess { reports = it.reports; open = it.open; error = null }
            .onFailure { error = it.friendly(); reports = emptyList() }
    }
    fun set(r: ReportDto, status: String, note: String?) = scope.launch {
        runCatching { container.reports.setStatus(r.id, status, note) }.onSuccess { reload++ }.onFailure { error = it.friendly() }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.rq_title), onBack = { nav.popBackStack() }) }
        item {
            SegmentedPills(
                listOf(stringResource(R.string.rq_open) + if (open > 0) " ($open)" else "", stringResource(R.string.rq_closed)),
                if (closed) 1 else 0, { closed = it == 1 }, Modifier.padding(horizontal = Space.gutter, vertical = 6.dp),
            )
        }
        error?.let { item { StatusBanner(it, BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        val list = reports
        if (list == null) item { ShimmerList(4) }
        else if (list.isEmpty()) item {
            EmptyState(Icons.Outlined.Flag, stringResource(if (closed) R.string.rq_empty_closed else R.string.rq_empty_open), "", art = com.meldiq.android.R.drawable.meldling_all_set)
        } else items(list, key = { it.id }) { r -> ReportCard(r, aboutMe = r.target?.id == container.session.session?.userId && !isOwner, onHandle = { closing = r to "actioned" }, onDismissIt = { closing = r to "dismissed" }, onReopen = { set(r, "open", null) }) }
        item {
            Text(stringResource(R.string.rq_retention), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 12.dp))
        }
    }
    closing?.let { (r, status) ->
        var note by remember(r.id, status) { mutableStateOf("") }
        GlassSheet({ closing = null }, title = stringResource(if (status == "actioned") R.string.rq_handled else R.string.rq_dismiss)) {
            GriipTextField(note, { note = it.take(500) }, stringResource(R.string.rq_note), singleLine = false, minLines = 2)
            Spacer(Modifier.height(12.dp))
            PillButton(stringResource(if (status == "actioned") R.string.rq_handled else R.string.rq_dismiss), {
                closing = null
                set(r, status, note.trim().ifEmpty { null })
            }, Modifier.fillMaxWidth().padding(bottom = 8.dp), height = 48.dp)
        }
    }
}

@Composable
private fun ReportCard(r: ReportDto, aboutMe: Boolean, onHandle: () -> Unit, onDismissIt: () -> Unit, onReopen: () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Text(reasonLabel(r.reason), style = Griip.type.titleSmall, color = c.textPrimary)
        val who = r.target?.displayName ?: r.target?.username ?: "?"
        val where = r.conversationName?.let { stringResource(R.string.rq_in, it) } ?: stringResource(R.string.rq_person)
        Text("$who · $where · ${TimeFmt.listStamp(r.createdAt)}", style = Griip.type.caption, color = c.textSecondary)
        r.content?.text?.let { text ->
            Text(
                text, style = Griip.type.bodySmall, color = c.textPrimary,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp).clip(Shapes.small).background(c.surfaceVariant).padding(10.dp),
            )
        }
        r.content?.attachments?.takeIf { it.isNotEmpty() }?.let { files ->
            Text(files.joinToString(", ") { it.name }, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp))
        }
        r.content?.context?.takeIf { it.isNotEmpty() }?.let { ctxLines ->
            Text(stringResource(R.string.rq_context), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
            ctxLines.forEach { line -> Text("· " + line.text, style = Griip.type.caption, color = c.textSecondary, maxLines = 3) }
        }
        r.note?.let { Text("“$it”", style = Griip.type.bodySmall, color = c.textPrimary, modifier = Modifier.padding(top = 8.dp)) }
        if (aboutMe) {
            Text(stringResource(R.string.rq_about_you), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 10.dp))
        } else if (r.status == "open") {
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PillButton(stringResource(R.string.rq_handled), onHandle, Modifier.weight(1f), height = 42.dp, showKnob = false)
                PillButton(stringResource(R.string.rq_dismiss), onDismissIt, Modifier.weight(1f), tone = ButtonTone.Glass, height = 42.dp, showKnob = false)
            }
        } else {
            val by = r.handledBy?.displayName ?: r.handledBy?.username ?: "?"
            Text(
                stringResource(if (r.status == "actioned") R.string.rq_status_actioned else R.string.rq_status_dismissed, by) + (r.handledNote?.let { " · $it" } ?: ""),
                style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp),
            )
            PillButton(stringResource(R.string.rq_reopen), onReopen, Modifier.padding(top = 6.dp), tone = ButtonTone.Glass, height = 38.dp, showKnob = false)
        }
    }
}
