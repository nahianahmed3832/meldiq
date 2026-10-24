package com.meldiq.android.ui.screens.ai

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Image
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.ai.AgentRules
import com.meldiq.android.data.ai.AiAgentDetail
import com.meldiq.android.data.ai.AiReadiness
import com.meldiq.android.data.api.CustomRoleDto
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream

private val STYLES = listOf("balanced", "concise", "detailed", "friendly", "formal")
private val COLORS = listOf("#5B5BD6", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6", "#64748B")
private val ACTIVATIONS = listOf("mention", "command", "explicit")
private const val AVATAR_PX = 512
private const val AVATAR_MAX_BYTES = 512 * 1024

/** The configuration steps, in the order an admin goes through them (as Meldiq Web). */
private enum class Step(val label: Int) {
    Identity(R.string.aw_step_identity), Models(R.string.aw_step_models), Skills(R.string.aw_step_skills), Channels(R.string.aw_channels),
    Permissions(R.string.aw_step_permissions), Autonomy(R.string.aw_step_autonomy), Triggers(R.string.aw_step_triggers),
    Limits(R.string.aw_step_limits), Test(R.string.aw_step_test),
}

/**
 * Configure one installed agent, step by step (as Meldiq Web's AgentSettings, server docs/AI_WORKFORCE.md §3, §5b): its
 * identity here, the verified models it runs on, its skill and tools, channels and reading, permissions, autonomy,
 * triggers, limits, then a real test and its readiness. Only this community's copy changes. Everyone may look; only
 * "Manage AI agents" can change it, and the server checks that again.
 */
@Composable
fun AgentSettingsScreen(nav: NavHostController, orgId: String, installId: String) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var detail by remember { mutableStateOf<AiAgentDetail?>(null) }
    var readiness by remember { mutableStateOf<AiReadiness?>(null) }
    var roles by remember { mutableStateOf<List<CustomRoleDto>>(emptyList()) }
    var triggersOn by remember { mutableStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var step by rememberSaveable { mutableStateOf(Step.Identity) }
    val conversations by container.conversations.observeAll().collectAsStateWithLifecycle(emptyList())
    LaunchedEffect(orgId, installId, reload) {
        runCatching { container.ai.agent(orgId, installId) }.onSuccess { detail = it; error = null }.onFailure { error = it.friendly() }
        if (roles.isEmpty()) roles = runCatching { container.roles.roles(orgId).roles }.getOrDefault(emptyList())
        triggersOn = runCatching { container.ai.triggers(orgId, installId).count { it.enabled } }.getOrDefault(0)
    }
    LaunchedEffect(orgId, installId, reload, rev) { readiness = runCatching { container.ai.readiness(orgId, installId) }.getOrNull() ?: readiness }
    val savedText = stringResource(R.string.aw_saved)
    val unreadablePhoto = stringResource(R.string.aw_photo_unreadable)
    fun run(message: String? = savedText, block: suspend () -> Unit) {
        busy = true
        error = null
        saved = null
        scope.launch {
            runCatching { block() }.onSuccess { saved = message; reload++ }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val patch: AgentPatch = { fields, message -> detail?.agent?.let { a -> run(message ?: savedText) { container.ai.update(orgId, a.id, JsonObject(fields + ("rev" to JsonPrimitive(a.rev)))) } } }
    val avatarPick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val a = detail?.agent ?: return@rememberLauncherForActivityResult
        if (uri != null) run {
            val bytes = withContext(Dispatchers.IO) { avatarBytes(context, uri) } ?: throw com.meldiq.android.data.api.ApiException(400, "unreadable", unreadablePhoto)
            container.ai.setAvatar(orgId, a.id, bytes)
        }
    }
    val c = Griip.colors
    val d = detail
    val channels = conversations.filter { it.orgId == orgId && it.type == "CHANNEL" && !it.archived && !it.voice && !it.removed }.sortedBy { it.name.orEmpty().lowercase() }
    val channelName = { id: String -> channels.firstOrNull { it.id == id }?.name ?: id }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
        GriipTopBar(
            d?.agent?.let { stringResource(R.string.aw_configure, it.displayName) } ?: stringResource(R.string.aw_title),
            subtitle = d?.let { listOfNotNull(it.definition?.name, stringResource(R.string.aw_skill_version, it.agent.skill?.id ?: it.agent.agentId, it.agent.version), stringResource(if (it.agent.active) R.string.aw_on_short else R.string.aw_off)).joinToString(" · ") },
            onBack = { nav.popBackStack() },
            actions = { ReadinessPill(readiness) },
        )
        error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
        saved?.let { StatusBanner(it, BannerKind.Success, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
        if (d == null) {
            if (error == null) ShimmerList(4)
            return@Column
        }
        val a = d.agent
        val manage = d.permissions.canManage
        ChipRow { Step.entries.forEachIndexed { i, s -> PillChip("${i + 1}. " + stringResource(s.label), step == s, { step = s }) } }
        Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (step) {
                Step.Identity -> IdentityStep(orgId, d, manage, busy, patch, onAvatar = { avatarPick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                Step.Models -> {
                    Text(stringResource(R.string.aw_models_sub), style = Griip.type.bodySmall, color = c.textSecondary)
                    readiness?.let { ReadinessList(it, listOf("model.", "ai", "platform", "paused")) } ?: ShimmerList(2)
                }
                Step.Skills -> SkillsStep(d, readiness)
                Step.Channels -> {
                    ChannelsStep(orgId, d, manage, busy, channels) { block -> run(block = block) }
                    ReadingCard(orgId, a.id, channels, manage)
                }
                Step.Permissions -> PermissionsStep(d, manage, busy, roles, patch)
                Step.Autonomy -> AutonomyStep(a, manage, busy, triggersOn, patch)
                Step.Triggers -> TriggersStep(orgId, d, manage, channelName)
                Step.Limits -> LimitsStep(a, d, manage, busy, patch)
                Step.Test -> {
                    TestStep(orgId, a.id, readiness, manage, d.permissions)
                    if (manage) {
                        Text(stringResource(R.string.aw_activate), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
                        d.upgrade?.let { up -> PillButton(stringResource(R.string.aw_update_to, up.version), { patch(mapOf("upgradeTo" to JsonPrimitive(up.version)), null) }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, enabled = !busy) }
                        val offText = stringResource(R.string.aw_turned_off)
                        val onText = stringResource(R.string.aw_turned_on)
                        PillButton(
                            stringResource(if (a.active) R.string.aw_turn_off else R.string.aw_turn_on),
                            { patch(mapOf("state" to JsonPrimitive(if (a.active) "disabled" else "active")), if (a.active) offText else onText) },
                            Modifier.fillMaxWidth(), tone = ButtonTone.Glass, enabled = !busy,
                        )
                        PillButton(stringResource(R.string.aw_remove), { removing = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, leadingIcon = Icons.Outlined.DeleteForever, enabled = !busy)
                    }
                }
            }
        }
        if (removing) RemoveAgentDialog(orgId, a.id, a.displayName, onDismiss = { removing = false }, onRemoved = { removing = false; nav.popBackStack() })
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun IdentityStep(orgId: String, d: AiAgentDetail, manage: Boolean, busy: Boolean, patch: AgentPatch, onAvatar: () -> Unit) {
    val a = d.agent
    val c = Griip.colors
    var name by remember(a.rev) { mutableStateOf(a.displayName) }
    var role by remember(a.rev) { mutableStateOf(a.roleTitle) }
    var description by remember(a.rev) { mutableStateOf(a.description) }
    var language by remember(a.rev) { mutableStateOf(a.language.orEmpty()) }
    var style by remember(a.rev) { mutableStateOf(a.style) }
    var instructions by remember(a.rev) { mutableStateOf(a.instructions) }
    Text(stringResource(R.string.aw_identity_sub, d.definition?.name ?: a.agentId), style = Griip.type.bodySmall, color = c.textSecondary)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        AgentAvatar(orgId, a.id, a.displayName, a.avatarColor, a.avatar != null, size = 56.dp)
        if (manage) PillButton(stringResource(R.string.aw_change_avatar), onAvatar, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Image, height = 40.dp, enabled = !busy)
    }
    if (manage) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        COLORS.forEach { hex ->
            val chosen = a.avatarColor.equals(hex, ignoreCase = true)
            Box(
                Modifier.size(30.dp).clip(CircleShape).background(Color(AgentRules.hexColor(hex) ?: 0))
                    .border(if (chosen) 3.dp else 0.dp, c.textPrimary, CircleShape)
                    .pressable({ if (!chosen) patch(mapOf("avatarColor" to JsonPrimitive(hex)), null) }),
            )
        }
    }
    GriipTextField(name, { name = it.take(40) }, stringResource(R.string.aw_name), helper = stringResource(R.string.aw_name_helper), enabled = manage)
    GriipTextField(role, { role = it.take(60) }, stringResource(R.string.aw_role), enabled = manage)
    GriipTextField(description, { description = it.take(500) }, stringResource(R.string.aw_description), singleLine = false, minLines = 2, enabled = manage)
    GriipTextField(language, { language = it.take(10) }, stringResource(R.string.aw_language), placeholder = stringResource(R.string.aw_language_ph), enabled = manage)
    Text(stringResource(R.string.aw_style), style = Griip.type.label, color = c.textSecondary)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        STYLES.forEach { s -> PillChip(s, s == style, { if (manage) style = s }) }
    }
    GriipTextField(instructions, { instructions = it.take(2000) }, stringResource(R.string.aw_instructions), placeholder = stringResource(R.string.aw_instructions_ph), helper = stringResource(R.string.aw_instructions_helper), singleLine = false, minLines = 3, enabled = manage)
    if (manage) PillButton(stringResource(R.string.aw_save), {
        patch(
            mapOf(
                "displayName" to JsonPrimitive(name.trim()), "roleTitle" to JsonPrimitive(role.trim()), "description" to JsonPrimitive(description.trim()),
                "language" to (language.trim().ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull), "style" to JsonPrimitive(style), "instructions" to JsonPrimitive(instructions.trim()),
            ),
            null,
        )
    }, Modifier.fillMaxWidth(), enabled = !busy && name.trim().length >= 2, loading = busy)
}

@Composable
private fun SkillsStep(d: AiAgentDetail, readiness: AiReadiness?) {
    val c = Griip.colors
    val def = d.definition ?: return
    Text(stringResource(R.string.aw_skill_title, def.skill.id, def.skill.version), style = Griip.type.titleSmall, color = c.textPrimary)
    Text(def.description, style = Griip.type.bodySmall, color = c.textSecondary)
    if (def.capabilities.isNotEmpty()) Text("• " + def.capabilities.joinToString("\n• "), style = Griip.type.bodySmall, color = c.textSecondary)
    val f = def.skill.files
    Text(stringResource(R.string.aw_skill_files, f.min, f.max, f.types.take(5).joinToString() + if (f.types.size > 5) "…" else ""), style = Griip.type.caption, color = c.textTertiary)
    Text(stringResource(R.string.aw_skill_needs), style = Griip.type.section, color = c.textSecondary)
    readiness?.let { ReadinessList(it, listOf("tool.", "media", "version", "state")) }
    if (def.skill.approvals.isNotEmpty()) {
        Text(stringResource(R.string.aw_skill_approvals), style = Griip.type.section, color = c.textSecondary)
        Text("• " + def.skill.approvals.joinToString("\n• "), style = Griip.type.bodySmall, color = c.textSecondary)
    }
    if (def.skill.errors.isNotEmpty()) {
        Text(stringResource(R.string.aw_skill_errors), style = Griip.type.section, color = c.textSecondary)
        Text("• " + def.skill.errors.joinToString("\n• "), style = Griip.type.bodySmall, color = c.textSecondary)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChannelsStep(orgId: String, d: AiAgentDetail, manage: Boolean, busy: Boolean, channels: List<com.meldiq.android.data.db.ConversationEntity>, run: (suspend () -> Unit) -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val a = d.agent
    Text(stringResource(R.string.aw_channels_sub), style = Griip.type.caption, color = c.textSecondary)
    val assigned = d.channels.associateBy { it.conversationId }
    if (channels.isEmpty()) Text(stringResource(R.string.aw_channels_none), style = Griip.type.body, color = c.textSecondary)
    channels.forEach { ch ->
        val on = assigned[ch.id]
        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("# " + ch.name.orEmpty(), style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
                GriipSwitch(on != null, { yes -> run { if (yes) container.ai.assign(orgId, a.id, ch.id, "mention") else container.ai.unassign(orgId, a.id, ch.id) } }, enabled = manage && !busy)
            }
            if (on != null) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ACTIVATIONS.forEach { act ->
                    val label = stringResource(
                        when (act) {
                            "mention" -> R.string.aw_activation_mention
                            "command" -> R.string.aw_activation_command
                            else -> R.string.aw_activation_explicit
                        },
                    )
                    PillChip(label, on.activation == act, { if (manage && on.activation != act) run { container.ai.assign(orgId, a.id, ch.id, act) } })
                }
            }
        }
    }
    Text(stringResource(R.string.aw_outside), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
    val integrations = d.definition?.integrations.orEmpty()
    if (integrations.isEmpty()) Text(stringResource(R.string.aw_outside_none), style = Griip.type.body, color = c.textSecondary)
    integrations.forEach { i -> ListCard(i.label, subtitle = stringResource(R.string.aw_outside_drafts), trailing = { TagPill(stringResource(R.string.aw_not_connected), c.textSecondary, c.surfaceVariant) }) }
}

@Composable
private fun PermissionsStep(d: AiAgentDetail, manage: Boolean, busy: Boolean, roles: List<CustomRoleDto>, patch: AgentPatch) {
    val a = d.agent
    val c = Griip.colors
    Text(stringResource(R.string.aw_tools_sub), style = Griip.type.caption, color = c.textSecondary)
    d.tools.forEach { t ->
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.label + if (t.required) " · " + stringResource(R.string.aw_tool_needed) else "", style = Griip.type.body, color = c.textPrimary)
                val notes = listOfNotNull(t.description.ifBlank { null }, stringResource(R.string.aw_tool_not_connected).takeIf { !t.connected }, stringResource(R.string.aw_tool_approval).takeIf { t.platformMode == "approval" })
                Text(notes.joinToString(" · "), style = Griip.type.caption, color = c.textSecondary)
            }
            GriipSwitch(t.granted, { on -> patch(mapOf("tools" to JsonArray((if (on) a.tools + t.key else a.tools - t.key).distinct().map(::JsonPrimitive))), null) }, enabled = manage && !busy && !(t.required && t.granted))
        }
    }
    Text(stringResource(R.string.aw_who_may_ask), style = Griip.type.section, color = c.textSecondary, modifier = Modifier.padding(top = 8.dp))
    Text(stringResource(R.string.aw_who_may_ask_sub), style = Griip.type.caption, color = c.textSecondary)
    fun invokers(everyone: Boolean, ids: List<String>): JsonElement = JsonObject(mapOf("everyone" to JsonPrimitive(everyone), "roles" to JsonArray(ids.map(::JsonPrimitive))))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.aw_everyone_may_ask), style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
        GriipSwitch(a.invokers.everyone, { on -> patch(mapOf("invokers" to invokers(on, a.invokers.roles)), null) }, enabled = manage && !busy)
    }
    if (!a.invokers.everyone) roles.forEach { r ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(r.name, style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
            val on = r.id in a.invokers.roles
            GriipSwitch(on, { yes -> patch(mapOf("invokers" to invokers(false, if (yes) a.invokers.roles + r.id else a.invokers.roles - r.id)), null) }, enabled = manage && !busy)
        }
    }
}

/** Removing an agent from the community: its requests in progress are cancelled, its channels unassigned; past files stay. */
@Composable
fun RemoveAgentDialog(orgId: String, installId: String, name: String, onDismiss: () -> Unit, onRemoved: () -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    ConfirmDialog(
        stringResource(R.string.aw_remove_title, name), error ?: stringResource(R.string.aw_uninstall_body, name), stringResource(R.string.aw_remove),
        onConfirm = { scope.launch { runCatching { container.ai.uninstall(orgId, installId) }.onSuccess { onRemoved() }.onFailure { error = it.friendly() } } },
        onDismiss = onDismiss, destructive = true,
    )
}

/** A picked photo as an avatar: at most 512 px and 512 KB, JPEG (the server takes PNG, JPEG or WebP). */
private fun avatarBytes(context: android.content.Context, uri: android.net.Uri): ByteArray? {
    val src = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
    val scale = minOf(1f, AVATAR_PX.toFloat() / maxOf(src.width, src.height))
    val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true) else src
    var quality = 90
    while (true) {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (out.size() <= AVATAR_MAX_BYTES || quality <= 40) return out.toByteArray()
        quality -= 15
    }
}
