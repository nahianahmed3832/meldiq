package com.meldiq.android.ui.screens.ai

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.ai.AgentRules
import com.meldiq.android.data.ai.AgentTimeline
import com.meldiq.android.data.ai.AiChannelAgent
import com.meldiq.android.data.ai.AiChannelAgentsRes
import com.meldiq.android.data.ai.AiConversationReaders
import com.meldiq.android.data.ai.AiJobReq
import com.meldiq.android.data.ai.AiPost
import com.meldiq.android.data.ai.AiWorkforceApi
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.db.ConversationEntity
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val NONE = AiChannelAgentsRes()

/**
 * The AI agents assigned to [conv] and what this person may do with them: none outside community channels, on a
 * server without AI Workforce, or when the fetch fails (agents are an extra; the channel works without them). Fetched
 * again on the channel's `ai.posts` frame.
 */
@Composable
fun rememberChannelAgents(conv: ConversationEntity?): AiChannelAgentsRes {
    val container = LocalContainer.current
    val posts by container.aiSignals.posts.collectAsStateWithLifecycle()
    val id = conv?.id
    val channel = conv?.type == "CHANNEL" && conv.orgId != null && !conv.voice
    val rev = id?.let { posts[it] } ?: 0
    val result by produceState(NONE, id, channel, rev) {
        value = if (id == null || !channel || container.features.has(ServerFeatures.AI_WORKFORCE) != true) NONE
        else runCatching { container.ai.channelAgents(id) }.getOrDefault(NONE)
    }
    return result
}

/** The agents reading a conversation and this person's choice for each (API 0.40.0), and changing it. */
class ReadersState(val value: AiConversationReaders, val busy: Boolean, val error: String?, val choose: (readerId: String, choice: String) -> Unit)

@Composable
fun rememberReaders(conversationId: String): ReadersState {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val posts by container.aiSignals.posts.collectAsStateWithLifecycle()
    val rev = posts[conversationId] ?: 0
    var value by remember(conversationId) { mutableStateOf(AiConversationReaders()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(conversationId, rev) {
        if (container.features.has(ServerFeatures.AI_WORKFORCE) == true) value = container.directory.readerChoices(conversationId, force = rev > 0)
    }
    return ReadersState(value, busy, error) { readerId, choice ->
        busy = true
        error = null
        scope.launch {
            runCatching { container.directory.chooseReader(conversationId, readerId, choice) }.onSuccess { value = it }.onFailure { error = it.friendly() }
            busy = false
        }
    }
}

/** The agents' posts in [conversationId] (the newest 100), refetched on each `ai.posts` frame; empty when [enabled] is false. */
@Composable
fun rememberAgentPosts(conversationId: String, enabled: Boolean): List<AiPost> {
    val container = LocalContainer.current
    val postsRev by container.aiSignals.posts.collectAsStateWithLifecycle()
    val posts by produceState(emptyList<AiPost>(), conversationId, enabled, postsRev[conversationId]) {
        value = if (!enabled) emptyList() else runCatching { container.ai.channelPosts(conversationId) }.getOrNull() ?: value
    }
    return posts
}

/** A slim line above the composer when agents work in a channel: who, and how to ask them. */
@Composable
fun ChannelAgentsBar(agents: AiChannelAgentsRes, onAsk: () -> Unit) {
    if (agents.agents.isEmpty()) return
    val c = Griip.colors
    val first = agents.agents.first()
    val how = if (first.activation == "command") "/" + AgentRules.commandName(first.displayName) else "@" + first.displayName
    val names = agents.agents.joinToString(", ") { it.displayName }
    Row(
        Modifier.fillMaxWidth().background(c.primarySoft).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.SmartToy, null, tint = c.primaryDeep, modifier = Modifier.size(18.dp))
        Text(
            stringResource(if (agents.agents.size == 1) R.string.aw_bar_one else R.string.aw_bar_many, names) + " · " + stringResource(R.string.aw_bar_how, how),
            style = Griip.type.caption, color = c.primaryDeep, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        if (agents.permissions.canUse) PillButton(stringResource(R.string.aw_ask), onAsk, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, height = 32.dp)
    }
}

/**
 * One agent post drawn like a chat message (as Meldiq Web's AgentChatPost): a person's request ("to Writer · not
 * end-to-end encrypted"), or an agent's answer with its AI badge, files and a link to the request.
 */
@Composable
fun AgentChatPost(orgId: String, p: AiPost, authorName: String?, canApprove: Boolean, onOpen: (String) -> Unit) {
    val c = Griip.colors
    val isRequest = p.kind == "request"
    val name = if (isRequest) authorName ?: stringResource(R.string.aw_someone) else p.agent.displayName
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (isRequest) Avatar(name, (p.authorId ?: name).hashCode(), size = 36.dp)
        else AgentAvatar(orgId, p.agent.installId, p.agent.displayName, p.agent.avatarColor, p.agent.hasAvatar, size = 36.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = Griip.type.label, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(6.dp))
                if (!isRequest) AiBadge() else Text(stringResource(R.string.aw_post_to, p.agent.displayName), style = Griip.type.caption, color = c.textTertiary, maxLines = 1)
                Spacer(Modifier.width(6.dp))
                Text(TimeFmt.clock(p.createdAt), style = Griip.type.caption, color = c.textTertiary)
            }
            Text(p.body, style = Griip.type.body, color = if (p.kind == "error") c.danger else c.textPrimary)
            p.files.forEach { AiFileRow(orgId, it) }
            val jobId = p.jobId
            if (jobId != null && (p.kind == "approval" || p.kind == "result")) Text(
                stringResource(if (p.kind == "approval") (if (canApprove) R.string.aw_post_review else R.string.aw_post_see) else R.string.aw_post_details),
                style = Griip.type.label, color = c.primary, modifier = Modifier.pressable({ onOpen(jobId) }).padding(vertical = 2.dp),
            )
        }
    }
}

/** The readers' notices above the composer: a direct conversation's, and each channel reader's with this person's choice. */
@Composable
fun ReaderBanner(r: ReadersState) {
    val c = Griip.colors
    r.value.active.forEach { x ->
        if (x.direct) StatusBanner(stringResource(R.string.aw_reader_direct, x.name), BannerKind.Info, Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
        else {
            val mine = when (x.myChoice) {
                "share" -> " " + stringResource(R.string.aw_reader_you_share)
                "keep" -> " " + stringResource(R.string.aw_reader_you_keep)
                else -> ""
            }
            val choice = x.myChoice
            StatusBanner(
                stringResource(R.string.aw_reader_channel, x.name, TimeFmt.relative(x.since), x.turnedOnBy?.name.orEmpty(), x.reason) + mine,
                BannerKind.Info, Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                icon = if (choice == "share") Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
                action = choice?.let { stringResource(if (it == "share") R.string.aw_reader_keep_mine else R.string.aw_reader_share_mine) },
                onAction = choice?.let { cur -> { if (!r.busy) r.choose(x.readerId, if (cur == "share") "keep" else "share") } },
            )
        }
    }
    r.error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(horizontal = 12.dp)) }
}

/** In place of the composer until this person chooses for each channel reader here (no choice counts as keep). */
@Composable
fun ReaderChoice(r: ReadersState) {
    val x = r.value.pending.firstOrNull() ?: return
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().background(c.surface).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.aw_reader_choice_title, x.name), style = Griip.type.titleSmall, color = c.textPrimary)
        Text(stringResource(R.string.aw_reader_choice_body), style = Griip.type.bodySmall, color = c.textSecondary)
        r.error?.let { StatusBanner(it, BannerKind.Error) }
        PillButton(stringResource(R.string.aw_reader_share_with, x.name), { r.choose(x.readerId, "share") }, Modifier.fillMaxWidth(), enabled = !r.busy, height = 46.dp)
        PillButton(stringResource(R.string.aw_reader_keep_out), { r.choose(x.readerId, "keep") }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, enabled = !r.busy, height = 46.dp)
    }
}

/** Agents to pick while typing "@…" or a leading "/…" (as Meldiq Web's composer suggestions). */
@Composable
fun AgentSuggestions(s: AgentTimeline.Suggest, onPick: (AiChannelAgent) -> Unit) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().background(c.surface).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        s.agents.forEach { a ->
            PillChip((if (s.command) "/" + AgentRules.commandName(a.displayName) else "@" + a.displayName) + " · AI", false, { onPick(a) }, icon = Icons.Outlined.SmartToy)
        }
    }
}

private const val PREFS = "meldiq_ai"
private const val NOTICE_SEEN = "agentNoticeSeen"

private fun noticeSeen(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(NOTICE_SEEN, false)
private fun rememberNoticeSeen(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(NOTICE_SEEN, true).apply()

/**
 * "@Agent …" (or "/agent …") from the composer, sent straight to the agent like a message to a bot (as Meldiq Web).
 * The notice that it leaves end-to-end encryption is asked once on this phone; a request the agent can't take as it
 * stands (it needs a file or more options) opens the full Ask sheet with the text kept.
 */
class AgentMention(val handle: (AgentRules.Invocation) -> Unit, val ui: @Composable () -> Unit)

@Composable
fun rememberAgentMention(orgId: String?, conversationId: String, onOpenAsk: (installId: String, brief: String) -> Unit): AgentMention {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var notice by remember { mutableStateOf<AgentRules.Invocation?>(null) }
    var failed by remember { mutableStateOf<Pair<AgentRules.Invocation, String>?>(null) }
    fun send(inv: AgentRules.Invocation) {
        val org = orgId ?: return
        scope.launch {
            runCatching {
                container.ai.createJob(org, AiJobReq(inv.installId, JsonObject(mapOf("brief" to JsonPrimitive(inv.brief))), conversationId, idempotencyKey = AiWorkforceApi.idempotencyKey(), requestText = inv.brief))
            }.onSuccess { container.aiSignals.postsChanged(conversationId) }.onFailure { e ->
                if (e is ApiException && e.status == 400) onOpenAsk(inv.installId, inv.brief) else failed = inv to e.friendly()
            }
        }
    }
    val handle: (AgentRules.Invocation) -> Unit = { inv ->
        when {
            !inv.canInvoke || inv.brief.isBlank() -> onOpenAsk(inv.installId, inv.brief)
            !noticeSeen(context) -> notice = inv
            else -> send(inv)
        }
    }
    return AgentMention(handle) {
        notice?.let { inv ->
            ConfirmDialog(
                stringResource(R.string.aw_send_to, inv.displayName), stringResource(R.string.aw_notice) + "\n\n" + stringResource(R.string.aw_send_once),
                stringResource(R.string.aw_send),
                onConfirm = { rememberNoticeSeen(context); notice = null; send(inv) }, onDismiss = { notice = null },
            )
        }
        failed?.let { (inv, message) ->
            ConfirmDialog(
                stringResource(R.string.aw_didnt_get, inv.displayName), message, stringResource(R.string.aw_edit_send),
                onConfirm = { failed = null; onOpenAsk(inv.installId, inv.brief) }, onDismiss = { failed = null },
            )
        }
    }
}

/**
 * A channel's AI agents in its member list, under the people, always with the AI badge (as Meldiq Web's AgentMembers).
 * Tapping one opens Ask; Message opens a direct conversation with it (the person's choice to share what they write there).
 */
@Composable
fun AgentMembersSection(nav: NavHostController, conv: ConversationEntity) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val agents = rememberChannelAgents(conv)
    val readers = rememberReaders(conv.id)
    var asking by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val org = conv.orgId ?: return
    if (agents.agents.isEmpty()) return
    val c = Griip.colors
    val reading = readers.value.active.map { it.installId }.toSet()
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(stringResource(R.string.aw_members_title, agents.agents.size), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(horizontal = 16.dp))
        Text(stringResource(if (reading.isNotEmpty()) R.string.aw_members_reading else R.string.aw_members_not_reading), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
        error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = 16.dp)) }
        agents.agents.forEach { a ->
            ListCard(
                a.displayName, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                subtitle = listOfNotNull(a.roleTitle.ifBlank { null }, stringResource(R.string.aw_members_cant_ask).takeIf { !a.canInvoke }, stringResource(R.string.aw_members_reads).takeIf { a.id in reading }).joinToString(" · "),
                leading = { AgentAvatar(org, a.id, a.displayName, a.avatarColor, a.avatar != null, size = 40.dp) },
                trailing = if (a.canInvoke) ({
                    CircleIconButton(Icons.Outlined.ChatBubbleOutline, stringResource(R.string.aw_message_agent, a.displayName), {
                        scope.launch {
                            runCatching { container.ai.direct(org, a.id) }
                                .onSuccess { r -> runCatching { container.conversations.refreshOne(r.conversationId) }; nav.navigate(Routes.conversation(r.conversationId)) }
                                .onFailure { error = it.friendly() }
                        }
                    }, size = 40.dp, tint = c.primary)
                }) else null,
                onClick = { asking = a.id },
            )
        }
    }
    asking?.let { id ->
        AskAgentSheet(
            org, agents.agents.map { AskableAgent(it.id, it.displayName, it.canInvoke) }, initialAgent = id, conversationId = conv.id,
            onDismiss = { asking = null }, onSent = { asking = null },
        )
    }
}
