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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.ApplicationDto
import com.meldiq.android.data.model.ApplicationRules
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
 * The moderators' applications queue (batch B4b, `members.approve`): Waiting and Answered. Each application shows who
 * asked, when, and their answer to every question; Let in (they join, with the server's usual checks) or Decline, with
 * an optional note for the other moderators.
 */
@Composable
fun ApplicationsScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var closed by remember { mutableStateOf(false) }
    var list by remember { mutableStateOf<List<ApplicationDto>?>(null) }
    var pending by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var deciding by remember { mutableStateOf<Pair<ApplicationDto, Boolean>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(closed, reload) {
        list = null
        runCatching { container.applications.list(orgId, closed) }
            .onSuccess { list = it.applications; pending = it.pending; error = null }
            .onFailure { error = it.friendly(); list = emptyList() }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.ja_title), onBack = { nav.popBackStack() }) }
        item {
            SegmentedPills(
                listOf(stringResource(R.string.ja_pending) + if (pending > 0) " ($pending)" else "", stringResource(R.string.ja_closed)),
                if (closed) 1 else 0, { closed = it == 1 }, Modifier.padding(horizontal = Space.gutter, vertical = 6.dp),
            )
        }
        error?.let { item { StatusBanner(it, BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        val shown = list
        if (shown == null) item { ShimmerList(3) }
        else if (shown.isEmpty()) item {
            EmptyState(Icons.Outlined.HowToReg, stringResource(if (closed) R.string.ja_empty_closed else R.string.ja_empty_pending), "", art = com.meldiq.android.R.drawable.meldling_all_set)
        } else items(shown, key = { it.id }) { a -> ApplicationCard(a, onApprove = { deciding = a to true }, onDeny = { deciding = a to false }) }
    }
    deciding?.let { (a, approve) ->
        var note by remember(a.id, approve) { mutableStateOf("") }
        GlassSheet({ deciding = null }, title = stringResource(if (approve) R.string.ja_approve else R.string.ja_deny)) {
            GriipTextField(note, { note = it.take(ApplicationRules.NOTE_MAX) }, stringResource(R.string.ja_note), singleLine = false, minLines = 2)
            Spacer(Modifier.height(12.dp))
            PillButton(stringResource(if (approve) R.string.ja_approve else R.string.ja_deny), {
                deciding = null
                scope.launch {
                    runCatching { container.applications.decide(a.id, approve, note.trim().ifEmpty { null }) }
                        .onSuccess { reload++ }
                        .onFailure { error = it.friendly(); reload++ }
                }
            }, Modifier.fillMaxWidth().padding(bottom = 8.dp), tone = if (approve) ButtonTone.Primary else ButtonTone.Danger, height = 48.dp)
        }
    }
}

@Composable
private fun ApplicationCard(a: ApplicationDto, onApprove: () -> Unit, onDeny: () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        val who = a.user.displayName ?: a.user.username ?: "?"
        Text(who, style = Griip.type.titleSmall, color = c.textPrimary)
        Text(listOfNotNull(a.user.username?.let { "@$it" }, TimeFmt.listStamp(a.createdAt)).joinToString(" · "), style = Griip.type.caption, color = c.textSecondary)
        a.questions.forEachIndexed { i, q ->
            Text(q, style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(top = 10.dp))
            Text(
                a.answers.getOrNull(i).orEmpty(), style = Griip.type.bodySmall, color = c.textPrimary,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp).clip(Shapes.small).background(c.surfaceVariant).padding(10.dp),
            )
        }
        when (a.status) {
            ApplicationRules.PENDING -> Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PillButton(stringResource(R.string.ja_approve), onApprove, Modifier.weight(1f), height = 42.dp, showKnob = false)
                PillButton(stringResource(R.string.ja_deny), onDeny, Modifier.weight(1f), tone = ButtonTone.Glass, height = 42.dp, showKnob = false)
            }
            else -> {
                val by = a.handledByName ?: "?"
                val status = when (a.status) {
                    ApplicationRules.APPROVED -> stringResource(R.string.ja_status_approved, by)
                    ApplicationRules.DENIED -> stringResource(R.string.ja_status_denied, by)
                    else -> stringResource(R.string.ja_status_withdrawn)
                }
                Text(status + (a.note?.let { " · $it" } ?: ""), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 10.dp))
            }
        }
    }
}

/** Answering a community's questions to apply (from the Discover preview). */
@Composable
fun ApplySheet(communityId: String, name: String, questions: List<String>, onDismiss: () -> Unit, onSent: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var answers by remember(communityId) { mutableStateOf(List(questions.size) { "" }) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    GlassSheet(onDismiss, title = stringResource(R.string.ja_apply_title, name)) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(stringResource(R.string.ja_apply_intro), style = Griip.type.bodySmall, color = c.textSecondary)
            questions.forEachIndexed { i, q ->
                Text(q, style = Griip.type.bodyMedium, color = c.textPrimary, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
                GriipTextField(
                    answers[i], { v -> answers = answers.mapIndexed { j, old -> if (j == i) v.take(ApplicationRules.ANSWER_MAX) else old } },
                    stringResource(R.string.ja_answer), singleLine = false, minLines = 2,
                )
            }
            error?.let { Spacer(Modifier.height(8.dp)); StatusBanner(it, BannerKind.Error) }
            Spacer(Modifier.height(14.dp))
            PillButton(stringResource(R.string.ja_send), {
                busy = true
                scope.launch {
                    runCatching { container.applications.apply(communityId, ApplicationRules.cleanAnswers(answers)) }
                        .onSuccess { onSent() }
                        .onFailure { error = it.friendly() }
                    busy = false
                }
            }, Modifier.fillMaxWidth().padding(bottom = 8.dp), enabled = ApplicationRules.complete(questions, answers), loading = busy, height = 50.dp)
        }
    }
}

/** Community settings › Join questions: turn applications on with up to five questions, change them, or turn them off. */
@Composable
fun JoinQuestionsSheet(orgId: String, current: List<String>?, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var drafts by remember(orgId) { mutableStateOf(current?.ifEmpty { null } ?: listOf("")) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun save(questions: List<String>?) {
        busy = true
        scope.launch {
            runCatching { container.applications.setQuestions(orgId, questions) }
                .onSuccess { onChanged(); onDismiss() }
                .onFailure { error = it.friendly() }
            busy = false
        }
    }
    GlassSheet(onDismiss, title = stringResource(R.string.ja_questions_title)) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(stringResource(R.string.ja_questions_intro), style = Griip.type.bodySmall, color = c.textSecondary)
            drafts.forEachIndexed { i, q ->
                Spacer(Modifier.height(10.dp))
                GriipTextField(
                    q, { v -> drafts = drafts.mapIndexed { j, old -> if (j == i) v.take(ApplicationRules.QUESTION_MAX) else old } },
                    stringResource(R.string.ja_question_n, i + 1), singleLine = false,
                    trailing = if (drafts.size > 1) ({
                        IconButton({ drafts = drafts.filterIndexed { j, _ -> j != i } }) {
                            Icon(Icons.Outlined.Close, stringResource(R.string.ja_remove_question), tint = c.textSecondary)
                        }
                    }) else null,
                )
            }
            if (drafts.size < ApplicationRules.MAX_QUESTIONS) {
                PillButton(stringResource(R.string.ja_add_question), { drafts = drafts + "" }, Modifier.padding(top = 10.dp), tone = ButtonTone.Glass, height = 40.dp, showKnob = false)
            }
            error?.let { Spacer(Modifier.height(8.dp)); StatusBanner(it, BannerKind.Error) }
            Spacer(Modifier.height(14.dp))
            val cleaned = ApplicationRules.cleanQuestions(drafts)
            PillButton(stringResource(R.string.ja_save), { save(cleaned) }, Modifier.fillMaxWidth(), enabled = cleaned != null, loading = busy, height = 50.dp)
            if (current != null) {
                PillButton(stringResource(R.string.ja_turn_off), { save(null) }, Modifier.fillMaxWidth().padding(top = 8.dp), tone = ButtonTone.Glass, height = 46.dp, showKnob = false)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
