package com.meldiq.android.ui.screens.ai

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.ListAlt
import androidx.compose.material.icons.outlined.SmartToy
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.ai.AiApproval
import com.meldiq.android.data.ai.AiCatalogEntry
import com.meldiq.android.data.ai.AiFile
import com.meldiq.android.data.ai.AiInstall
import com.meldiq.android.data.ai.AiJobSummary
import com.meldiq.android.data.ai.AiOverview
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/** Routes of the AI agents area (registered in AppRoot). */
object AiRoutes {
    fun agents(orgId: String) = "ai/$orgId"
    fun agent(orgId: String, installId: String) = "ai/$orgId/agent/$installId"
}

private enum class AiTab { Overview, Agents, Manager, Tasks, Requests, Approvals, Files, Health }

/**
 * Community › AI agents (server docs/AI_WORKFORCE.md, as Meldiq Web's AgentsPage): the installed agents and the catalog,
 * the Agent Manager, requests, approvals and files. "Ask AI agents" uses them, "Manage AI agents" installs and
 * configures them, "Approve AI agent actions" approves; the server checks every one of these again. Lists update on the
 * `ai.job` frame; work runs on the server whatever this screen does.
 */
@Composable
fun AgentsScreen(nav: NavHostController, orgId: String) {
    val container = LocalContainer.current
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    var overview by remember { mutableStateOf<AiOverview?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(orgId, rev, reload) {
        runCatching { container.ai.overview(orgId) }.onSuccess { overview = it; error = null }.onFailure { error = it.friendly() }
    }
    var tab by rememberSaveable { mutableStateOf(AiTab.Overview) }
    // A task the overview asked to open in Tasks.
    var openTask by remember { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<String?>(null) }
    var openJob by remember { mutableStateOf<String?>(null) }
    var browsing by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<AiInstall?>(null) }
    val o = overview
    val tabs = buildList {
        add(AiTab.Overview); add(AiTab.Agents); add(AiTab.Manager); add(AiTab.Tasks); add(AiTab.Requests)
        if (o?.permissions?.canApprove == true) add(AiTab.Approvals)
        add(AiTab.Files)
        if (o?.permissions?.canManage == true) add(AiTab.Health)
    }
    val labels = tabs.map {
        stringResource(
            when (it) {
                AiTab.Overview -> R.string.aw_tab_overview
                AiTab.Health -> R.string.aw_tab_health
                AiTab.Agents -> R.string.aw_tab_agents
                AiTab.Manager -> R.string.aw_tab_manager
                AiTab.Tasks -> R.string.aw_tab_tasks
                AiTab.Requests -> R.string.aw_tab_requests
                AiTab.Approvals -> R.string.aw_tab_approvals
                AiTab.Files -> R.string.aw_tab_files
            },
        )
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.aw_title), subtitle = stringResource(R.string.aw_subtitle), onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        if (o == null) {
            if (error == null) item { ShimmerList(3) }
            return@LazyColumn
        }
        item {
            Column(Modifier.padding(horizontal = Space.gutter, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (!o.enabled) StatusBanner(stringResource(R.string.aw_off_here), BannerKind.Info)
                if (o.paused) StatusBanner(stringResource(R.string.aw_paused), BannerKind.Warning)
                if (!o.aiRequestsOn) StatusBanner(stringResource(R.string.aw_requests_off), BannerKind.Warning)
                AiNotice(text = o.notice)
            }
        }
        // Eight tabs don't fit a segmented control on a phone: they scroll as chips.
        item { com.meldiq.android.ui.components.ChipRow { tabs.forEachIndexed { i, t -> PillChip(labels[i], tab == t, { openTask = null; tab = t }) } } }
        when (tab) {
            AiTab.Agents -> agentsTab(o, orgId, onAsk = { asking = it }, onSettings = { nav.navigate(AiRoutes.agent(orgId, it)) }, onBrowse = { browsing = true }, onRemove = { removing = it })
            AiTab.Manager -> item { ManagerTab(orgId, o, onAsk = { asking = it }, onOpen = { openJob = it }) }
            AiTab.Tasks -> item { androidx.compose.runtime.key(openTask) { TasksTab(orgId, o, open = openTask) } }
            AiTab.Overview -> item { WorkTab(orgId, o, onOpenTask = { openTask = it; tab = AiTab.Tasks }, onOpenHealth = { tab = AiTab.Health }) }
            AiTab.Health -> item { SystemCheckTab(orgId, o) }
            AiTab.Requests -> item { RequestsTab(orgId, o, rev, onOpen = { openJob = it }) }
            AiTab.Approvals -> item { ApprovalsTab(orgId, rev, onOpen = { openJob = it }) }
            AiTab.Files -> item { FilesTab(orgId, rev) }
        }
    }
    asking?.let { id ->
        AskAgentSheet(
            orgId, o?.agents.orEmpty().filter { it.active }.map { AskableAgent(it.id, it.displayName, o?.permissions?.canUse == true) }, initialAgent = id,
            onDismiss = { asking = null }, onSent = { asking = null; openJob = it.id },
        )
    }
    openJob?.let { id -> JobSheet(orgId, id, o?.permissions ?: com.meldiq.android.data.ai.AiPermissions(), onDismiss = { openJob = null }) }
    removing?.let { a -> RemoveAgentDialog(orgId, a.id, a.displayName, onDismiss = { removing = null }, onRemoved = { removing = null; reload++ }) }
    if (browsing) CatalogSheet(orgId, onDismiss = { browsing = false }, onInstalled = { browsing = false; reload++; nav.navigate(AiRoutes.agent(orgId, it)) })
}

private fun androidx.compose.foundation.lazy.LazyListScope.agentsTab(o: AiOverview, orgId: String, onAsk: (String) -> Unit, onSettings: (String) -> Unit, onBrowse: () -> Unit, onRemove: (AiInstall) -> Unit) {
    item {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.aw_installed), style = Griip.type.section, color = Griip.colors.textSecondary, modifier = Modifier.weight(1f))
            if (o.permissions.canManage && o.enabled) PillButton(stringResource(R.string.aw_add_agents), onBrowse, tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, height = 38.dp)
        }
    }
    if (o.agents.isEmpty()) item { EmptyState(Icons.Outlined.SmartToy, stringResource(R.string.aw_none_title), stringResource(if (o.permissions.canManage) R.string.aw_none_manage else R.string.aw_none_member)) }
    items(o.agents, key = { it.id }) { a -> AgentRow(orgId, a, o, onAsk, onSettings, onRemove) }
}

@Composable
private fun AgentRow(orgId: String, a: AiInstall, o: AiOverview, onAsk: (String) -> Unit, onSettings: (String) -> Unit, onRemove: (AiInstall) -> Unit) {
    val mode = stringResource(if (a.effectiveMode == "review") R.string.aw_mode_review_short else R.string.aw_mode_auto_short)
    ListCard(
        a.displayName, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
        subtitle = listOfNotNull(a.roleTitle.ifBlank { null }, a.skill?.name, mode, stringResource(R.string.aw_off).takeIf { !a.active }).joinToString(" · "),
        leading = { AgentAvatar(orgId, a.id, a.displayName, a.avatarColor, a.avatar != null) },
        trailing = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (o.permissions.canUse && a.active) PillButton(stringResource(R.string.aw_ask), { onAsk(a.id) }, tone = ButtonTone.Glass, height = 36.dp)
                if (o.permissions.canManage) com.meldiq.android.ui.components.CircleIconButton(
                    androidx.compose.material.icons.Icons.Outlined.DeleteOutline, stringResource(R.string.aw_remove_title, a.displayName), { onRemove(a) },
                    size = 36.dp, tint = Griip.colors.danger,
                )
            }
        },
        onClick = if (o.permissions.canManage) ({ onSettings(a.id) }) else null,
    )
}

@Composable
private fun ManagerTab(orgId: String, o: AiOverview, onAsk: (String) -> Unit, onOpen: (String) -> Unit) {
    val container = LocalContainer.current
    val rev by container.aiSignals.jobs.collectAsStateWithLifecycle()
    val manager = o.agents.firstOrNull { it.agentId == "agent_manager" && it.active }
    var jobs by remember { mutableStateOf<List<AiJobSummary>?>(null) }
    LaunchedEffect(orgId, rev, manager?.id) { jobs = manager?.let { m -> runCatching { container.ai.jobs(orgId, all = false).jobs.filter { it.agent.installId == m.id } }.getOrNull() } }
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.aw_manager_title), style = Griip.type.titleSmall, color = Griip.colors.textPrimary)
        Text(stringResource(R.string.aw_manager_sub), style = Griip.type.bodySmall, color = Griip.colors.textSecondary)
        if (manager == null) {
            Text(stringResource(if (o.permissions.canManage) R.string.aw_manager_install else R.string.aw_manager_ask_admin), style = Griip.type.body, color = Griip.colors.textSecondary)
            return@Column
        }
        if (o.permissions.canUse) PillButton(stringResource(R.string.aw_manager_new), { onAsk(manager.id) }, Modifier.fillMaxWidth(), leadingIcon = Icons.Outlined.AutoAwesome, height = 46.dp)
        val list = jobs
        when {
            list == null -> ShimmerList(2)
            list.isEmpty() -> Text(stringResource(R.string.aw_no_requests), style = Griip.type.body, color = Griip.colors.textSecondary)
            else -> list.forEach { JobRow(it, showAgent = false, onOpen) }
        }
    }
}

@Composable
private fun JobRow(j: AiJobSummary, showAgent: Boolean, onOpen: (String) -> Unit) {
    ListCard(
        if (showAgent) j.agent.displayName else TimeFmt.relative(j.createdAt),
        subtitle = listOfNotNull(TimeFmt.relative(j.createdAt).takeIf { showAgent }, j.note?.lineSequence()?.firstOrNull()?.take(80)).joinToString(" · ").ifEmpty { null },
        trailing = { JobStatePill(j.state) },
        onClick = { onOpen(j.id) },
    )
}

@Composable
private fun RequestsTab(orgId: String, o: AiOverview, rev: Int, onOpen: (String) -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var all by rememberSaveable { mutableStateOf(false) }
    var jobs by remember { mutableStateOf<List<AiJobSummary>?>(null) }
    var next by remember { mutableStateOf<Long?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, rev, all) {
        runCatching { container.ai.jobs(orgId, all) }.onSuccess { jobs = it.jobs; next = it.next; error = null }.onFailure { error = it.friendly() }
    }
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (o.permissions.canManage) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PillChip(stringResource(R.string.aw_requests_mine), !all, { all = false })
            PillChip(stringResource(R.string.aw_requests_all), all, { all = true })
        }
        error?.let { StatusBanner(it, BannerKind.Error) }
        val list = jobs
        when {
            list == null -> ShimmerList(3)
            list.isEmpty() -> EmptyState(Icons.Outlined.ListAlt, stringResource(R.string.aw_tab_requests), stringResource(R.string.aw_no_requests))
            else -> {
                list.forEach { JobRow(it, showAgent = true, onOpen) }
                next?.let { before ->
                    PillButton(stringResource(R.string.aw_older), {
                        scope.launch { runCatching { container.ai.jobs(orgId, all, before) }.onSuccess { p -> jobs = list + p.jobs; next = p.next }.onFailure { error = it.friendly() } }
                    }, tone = ButtonTone.Glass, height = 40.dp)
                }
            }
        }
    }
}

@Composable
private fun ApprovalsTab(orgId: String, rev: Int, onOpen: (String) -> Unit) {
    val container = LocalContainer.current
    var list by remember { mutableStateOf<List<AiApproval>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, rev) { runCatching { container.ai.approvals(orgId) }.onSuccess { list = it; error = null }.onFailure { error = it.friendly() } }
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.aw_approvals_sub), style = Griip.type.bodySmall, color = Griip.colors.textSecondary)
        error?.let { StatusBanner(it, BannerKind.Error) }
        val l = list
        when {
            l == null -> ShimmerList(2)
            l.isEmpty() -> EmptyState(Icons.Outlined.HowToReg, stringResource(R.string.aw_tab_approvals), stringResource(R.string.aw_no_approvals))
            else -> l.forEach { a ->
                ListCard(a.summary, subtitle = TimeFmt.relative(a.requestedAt), trailing = { JobStatePill(com.meldiq.android.data.ai.AiJobStates.AWAITING_APPROVAL) }, onClick = { onOpen(a.jobId) })
            }
        }
    }
}

@Composable
private fun FilesTab(orgId: String, rev: Int) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var files by remember { mutableStateOf<List<AiFile>?>(null) }
    var next by remember { mutableStateOf<Long?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId, rev) { runCatching { container.ai.deliverables(orgId) }.onSuccess { files = it.files; next = it.next; error = null }.onFailure { error = it.friendly() } }
    Column(Modifier.padding(horizontal = Space.gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.aw_files_sub), style = Griip.type.bodySmall, color = Griip.colors.textSecondary)
        error?.let { StatusBanner(it, BannerKind.Error) }
        val l = files
        when {
            l == null -> ShimmerList(2)
            l.isEmpty() -> EmptyState(Icons.Outlined.Folder, stringResource(R.string.aw_tab_files), stringResource(R.string.aw_no_files))
            else -> {
                l.forEach { AiFileRow(orgId, it) }
                next?.let { before ->
                    PillButton(stringResource(R.string.aw_older), {
                        scope.launch { runCatching { container.ai.deliverables(orgId, before) }.onSuccess { p -> files = l + p.files; next = p.next }.onFailure { error = it.friendly() } }
                    }, tone = ButtonTone.Glass, height = 40.dp)
                }
            }
        }
    }
}

/** The platform's published agents: search, kind, what's missing here, and Install (people who manage agents). */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun CatalogSheet(orgId: String, onDismiss: () -> Unit, onInstalled: (String) -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var catalog by remember { mutableStateOf<List<AiCatalogEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(orgId) { runCatching { container.ai.catalog(orgId) }.onSuccess { catalog = it }.onFailure { error = it.friendly() } }
    val c = Griip.colors
    GlassSheet(onDismiss, title = stringResource(R.string.aw_catalog)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            GriipTextField(query, { query = it }, stringResource(R.string.aw_catalog_search))
            val all = catalog.orEmpty()
            val kinds = all.map { it.agent.category }.distinct().sorted()
            if (kinds.size > 1) androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                PillChip(stringResource(R.string.aw_catalog_all), kind == null, { kind = null })
                kinds.forEach { k -> PillChip(k, kind == k, { kind = k }) }
            }
            error?.let { StatusBanner(it, BannerKind.Error) }
            if (catalog == null && error == null) ShimmerList(3)
            val q = query.trim().lowercase()
            val list = all.filter { e -> (kind == null || e.agent.category == kind) && (q.isEmpty() || "${e.agent.name} ${e.agent.description} ${e.agent.capabilities.joinToString(" ")}".lowercase().contains(q)) }
            if (catalog != null && list.isEmpty()) Text(stringResource(R.string.aw_catalog_none), style = Griip.type.body, color = c.textSecondary)
            list.forEach { e ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AgentAvatar(orgId, e.agent.id, e.agent.name, e.agent.avatarColor, hasAvatar = false, size = 36.dp)
                        Column(Modifier.weight(1f).padding(start = 10.dp)) {
                            Text(e.agent.name, style = Griip.type.bodyMedium, color = c.textPrimary)
                            Text(e.agent.category, style = Griip.type.caption, color = c.textSecondary)
                        }
                    }
                    Text(e.agent.description, style = Griip.type.bodySmall, color = c.textSecondary)
                    if (e.agent.capabilities.isNotEmpty()) Text("• " + e.agent.capabilities.joinToString("\n• "), style = Griip.type.caption, color = c.textSecondary)
                    if (e.setup.missing.isNotEmpty()) Text(stringResource(R.string.aw_catalog_setup, e.setup.missing.joinToString(" ")), style = Griip.type.caption, color = c.warning)
                    if (e.setup.unavailableActions.isNotEmpty()) Text(stringResource(R.string.aw_catalog_unavailable, e.setup.unavailableActions.joinToString(" ")), style = Griip.type.caption, color = c.textTertiary)
                    val inst = e.installed
                    when {
                        inst != null -> Text(stringResource(if (inst.upgradeAvailable) R.string.aw_catalog_installed_update else R.string.aw_catalog_installed), style = Griip.type.label, color = c.success)
                        e.available -> PillButton(stringResource(R.string.aw_catalog_install), {
                            busy = e.agent.id
                            scope.launch {
                                runCatching { container.ai.install(orgId, e.agent.id) }.onSuccess { onInstalled(it.id) }.onFailure { error = it.friendly() }
                                busy = null
                            }
                        }, enabled = busy == null, loading = busy == e.agent.id, height = 40.dp)
                        else -> Text(e.unavailableReason.orEmpty(), style = Griip.type.caption, color = c.textTertiary)
                    }
                }
            }
        }
    }
}
