package com.meldiq.android.ui.screens.home

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.ChannelHitDto
import com.meldiq.android.data.api.ConversationDto
import com.meldiq.android.data.api.SearchRes
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.api.WorkspaceHitDto
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.AttachmentRef
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SearchPill
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.screens.home.SearchRules.Filter
import com.meldiq.android.ui.screens.home.SearchRules.Section
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the server found, per kind, with the cursor for each kind's next page. */
private data class ServerHits(
    val people: List<UserDto> = emptyList(),
    val channels: List<ChannelHitDto> = emptyList(),
    val workspaces: List<WorkspaceHitDto> = emptyList(),
    val groups: List<ConversationDto> = emptyList(),
    val next: Map<Section, String> = emptyMap(),
)

/** What this phone found in its own (decrypted) history. */
private data class DeviceHits(
    val messages: List<MessageEntity> = emptyList(),
    val files: List<Pair<MessageEntity, AttachmentRef>> = emptyList(),
    val pinned: List<MessageEntity> = emptyList(),
)

/**
 * Universal search (round 7 slice C2, docs/SEARCH.md): people, channels in every workspace you're in, workspaces and
 * groups from the server's search (each with its own access rule); messages, files and pinned messages from this
 * phone's history, which the server can't read. Searches 250 ms after typing stops; a filter narrows to one kind and
 * pages it. Servers without search fall back to the directory and the selected workspace's channels.
 */
@Composable
fun SearchScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val me = container.session.session?.userId
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(Filter.ALL) }
    var server by remember { mutableStateOf(ServerHits()) }
    var device by remember { mutableStateOf(DeviceHits()) }
    var searching by remember { mutableStateOf(false) }
    var serverFailed by remember { mutableStateOf(false) }
    var recent by remember { mutableStateOf(RecentSearches.load(ctx)) }
    val convs by container.conversations.observeAll().collectAsStateWithLifecycle(emptyList())

    LaunchedEffect(q, filter) {
        val term = SearchRules.usable(q)
        if (term == null) {
            server = ServerHits(); device = DeviceHits(); searching = false; serverFailed = false
            return@LaunchedEffect
        }
        searching = true
        delay(SearchRules.DEBOUNCE_MS)
        val sections = SearchRules.sections(filter)
        // 2026-10-23: from:, has:, before: and after: narrow the messages on this phone; the words alone go elsewhere.
        val sq = com.meldiq.android.data.model.SearchQuery.parse(term)
        val words = sq.text
        device = DeviceHits(
            messages = if (Section.MESSAGES !in sections) emptyList() else if (sq.filtered) container.messages.search(sq) else container.messages.search(term),
            files = if (Section.FILES in sections && words.isNotEmpty()) container.messages.searchFiles(words) else emptyList(),
            pinned = if (Section.PINNED in sections && words.isNotEmpty()) container.messages.searchPinned(words) else emptyList(),
        )
        val types = SearchRules.serverTypes(filter)?.takeIf { words.isNotEmpty() }
        val found = if (types == null) Result.success(ServerHits()) else runCatching { searchServer(container, words, types, filter) }
        serverFailed = found.isFailure
        server = found.getOrDefault(ServerHits())
        searching = false
    }

    fun opened() {
        recent = SearchRules.remember(recent, q).also { RecentSearches.save(ctx, it) }
    }

    fun showMore(section: Section) {
        val cursor = server.next[section] ?: return
        val type = when (section) {
            Section.PEOPLE -> "people"; Section.CHANNELS -> "channels"; Section.WORKSPACES -> "workspaces"; Section.GROUPS -> "groups"
            else -> return
        }
        scope.launch {
            runCatching { container.api.get<SearchRes>(searchPath(q.trim(), type, cursor)).results }.onSuccess { r ->
                server = server.copy(
                    people = server.people + r.people?.items.orEmpty(),
                    channels = server.channels + r.channels?.items.orEmpty(),
                    workspaces = server.workspaces + r.workspaces?.items.orEmpty(),
                    groups = server.groups + r.groups?.items.orEmpty(),
                    next = server.next - section + listOfNotNull(
                        (r.people?.next ?: r.channels?.next ?: r.workspaces?.next ?: r.groups?.next)?.let { section to it },
                    ),
                )
            }
        }
    }

    val term = q.trim()
    val sections = SearchRules.sections(filter)
    val titleWords = remember(term) { com.meldiq.android.data.model.SearchQuery.parse(term).text }
    val convMatches = if (titleWords.isEmpty() || Section.CONVERSATIONS !in sections) emptyList()
    else convs.filter { !it.removed && ConversationRepository.title(it, me).contains(titleWords, ignoreCase = true) }
    val limit = if (filter == Filter.ALL) SearchRules.PREVIEW_COUNT else Int.MAX_VALUE
    val nothing = term.isNotEmpty() && !searching && convMatches.isEmpty() && server == ServerHits() && device == DeviceHits()

    Column(Modifier.fillMaxSize().imePadding()) {
        GriipTopBar(stringResource(R.string.search_title), onBack = { nav.popBackStack() })
        SearchPill(q, { q = it }, stringResource(R.string.search_hint), Modifier.padding(horizontal = Space.gutter, vertical = 6.dp))
        ChipRow(Modifier.padding(vertical = 4.dp)) {
            Filter.entries.forEach { f -> PillChip(filterLabel(f), filter == f, { filter = f }) }
        }
        // Search operators for messages (2026-10-23): a tap adds one to the query to finish typing.
        if (filter == Filter.ALL || filter == Filter.MESSAGES) ChipRow(Modifier.padding(bottom = 4.dp)) {
            listOf("from:", "has:image", "has:file", "has:link", "before:", "after:").forEach { op ->
                PillChip(op, false, { q = (q.trimEnd() + " " + op).trimStart() })
            }
        }
        if (searching) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), color = c.primary, trackColor = c.surfaceVariant)
        if (serverFailed && !searching) StatusBanner(stringResource(R.string.search_server_failed), BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp))
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp, top = 4.dp)) {
            if (term.isEmpty()) {
                item {
                    Text(stringResource(R.string.search_scope_note), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter + 4.dp, vertical = 6.dp))
                }
                if (recent.isNotEmpty()) {
                    item {
                        SectionHeader(stringResource(R.string.search_recent), Modifier.padding(vertical = 8.dp), action = stringResource(R.string.search_recent_clear), onAction = {
                            recent = emptyList(); RecentSearches.save(ctx, emptyList())
                        })
                    }
                    items(recent, key = { "r$it" }) { r -> RecentRow(r) { q = r } }
                }
                return@LazyColumn
            }
            if (nothing) item { EmptyState(Icons.Outlined.SearchOff, stringResource(R.string.search_none), stringResource(R.string.search_none_body), art = com.meldiq.android.R.drawable.meldling_confused) }
            if (convMatches.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_conversations), Modifier.padding(vertical = 8.dp)) }
                items(convMatches.take(limit), key = { "c" + it.id }) { conv -> ConversationHit(conv, me) { opened(); nav.navigate(Routes.conversation(conv.id)) } }
            }
            if (server.channels.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_section_channels), Modifier.padding(vertical = 8.dp)) }
                items(server.channels.take(limit), key = { "ch" + it.id }) { ch ->
                    ChannelHit(ch, onOpen = { opened(); nav.navigate(Routes.conversation(ch.id)) }, onJoin = {
                        opened()
                        scope.launch { runCatching { container.conversations.join(ch.id) }.onSuccess { nav.navigate(Routes.conversation(ch.id)) } }
                    })
                }
                moreItem(filter, server.next[Section.CHANNELS]) { showMore(Section.CHANNELS) }
            }
            if (server.workspaces.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_workspaces), Modifier.padding(vertical = 8.dp)) }
                items(server.workspaces.take(limit), key = { "o" + it.id }) { o ->
                    WorkspaceHit(o) { opened(); scope.launch { container.orgs.select(o.id); nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = false } } } }
                }
                moreItem(filter, server.next[Section.WORKSPACES]) { showMore(Section.WORKSPACES) }
            }
            if (server.groups.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_groups), Modifier.padding(vertical = 8.dp)) }
                items(server.groups.take(limit), key = { "g" + it.id }) { g -> GroupHit(g) { opened(); nav.navigate(Routes.conversation(g.id)) } }
            }
            if (server.people.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_people), Modifier.padding(vertical = 8.dp)) }
                items(server.people.take(limit), key = { "p" + it.id }) { u ->
                    PersonHit(u) { opened(); scope.launch { runCatching { container.conversations.openDm(u.id) }.onSuccess { nav.navigate(Routes.conversation(it.id)) } } }
                }
                moreItem(filter, server.next[Section.PEOPLE]) { showMore(Section.PEOPLE) }
            }
            if (device.messages.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_messages), Modifier.padding(vertical = 8.dp)) }
                items(device.messages.take(if (filter == Filter.ALL) 8 else 100), key = { "m" + it.id }) { m ->
                    MessageHit(m, convs.firstOrNull { it.id == m.conversationId }, me, pinned = false) { opened(); nav.navigate(Routes.conversation(m.conversationId)) }
                }
            }
            if (device.pinned.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_pinned), Modifier.padding(vertical = 8.dp)) }
                items(device.pinned.take(limit), key = { "pin" + it.id }) { m ->
                    MessageHit(m, convs.firstOrNull { it.id == m.conversationId }, me, pinned = true) { opened(); nav.navigate(Routes.conversation(m.conversationId)) }
                }
            }
            if (device.files.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.search_files), Modifier.padding(vertical = 8.dp)) }
                items(device.files.take(limit), key = { (m, ref) -> "f" + m.id + ref.id }) { (m, ref) ->
                    FileHit(ref, convs.firstOrNull { it.id == m.conversationId }, me, m.sortTs) { opened(); nav.navigate(Routes.conversation(m.conversationId)) }
                }
            }
            item { Spacer(Modifier.height(8.dp).fillMaxWidth()) }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.moreItem(filter: Filter, next: String?, onMore: () -> Unit) {
    if (filter == Filter.ALL || next == null) return
    item { ShowMoreRow(onMore) }
}

private fun searchPath(q: String, types: String, cursor: String? = null, limit: Int = 20): String =
    "/v1/search?q=${java.net.URLEncoder.encode(q, "UTF-8")}&types=$types&limit=$limit" + (cursor?.let { "&cursor=$it" } ?: "")

/** The server's search, or the older endpoints on a server without it. */
private suspend fun searchServer(container: com.meldiq.android.di.AppContainer, q: String, types: String, filter: Filter): ServerHits {
    if (container.features.has(ServerFeatures.SEARCH) == true) {
        val r = container.api.get<SearchRes>(searchPath(q, types, limit = if (filter == Filter.ALL) SearchRules.PREVIEW_COUNT + 1 else 20)).results
        // Counted only (docs/product/EXPERIMENTS.md): the scope and a bucket of how many came back, never the words.
        val found = (r.people?.items?.size ?: 0) + (r.channels?.items?.size ?: 0) + (r.workspaces?.items?.size ?: 0) +
            (r.groups?.items?.size ?: 0)
        container.analytics.track("search.performed", mapOf("scope" to SearchRules.analyticsScope(filter), "results" to SearchRules.resultBucket(found)))
        return ServerHits(
            people = r.people?.items.orEmpty(), channels = r.channels?.items.orEmpty(),
            workspaces = r.workspaces?.items.orEmpty(), groups = r.groups?.items.orEmpty(),
            next = listOfNotNull(
                r.people?.next?.let { Section.PEOPLE to it }, r.channels?.next?.let { Section.CHANNELS to it },
                r.workspaces?.next?.let { Section.WORKSPACES to it }, r.groups?.next?.let { Section.GROUPS to it },
            ).toMap(),
        )
    }
    val selected = container.orgs.selectedOrg.value
    return ServerHits(
        people = if ("people" in types) container.users.search(q) else emptyList(),
        channels = if ("channels" in types && selected != null) container.orgs.channels(selected, q).filter { !it.archived }
            .map { ChannelHitDto(it.id, it.orgId, null, it.name, it.topic, it.kind, it.scopeName, it.joined) } else emptyList(),
        workspaces = if ("workspaces" in types) container.orgs.cachedOrgs().orEmpty().filter { it.name.contains(q, ignoreCase = true) }
            .map { WorkspaceHitDto(it.id, it.name, it.slug) } else emptyList(),
    )
}

@Composable
private fun filterLabel(f: Filter): String = stringResource(
    when (f) {
        Filter.ALL -> R.string.search_filter_all
        Filter.MESSAGES -> R.string.search_messages
        Filter.FILES -> R.string.search_files
        Filter.PINNED -> R.string.search_pinned
        Filter.PEOPLE -> R.string.search_people
        Filter.CHANNELS -> R.string.search_section_channels
        Filter.WORKSPACES -> R.string.search_workspaces
    },
)

/** The last few searches the person opened a result from, on this phone only (a convenience, never sent anywhere). */
private object RecentSearches {
    private const val PREFS = "search"
    private const val KEY = "recent"
    private const val SEP = "\u001F"

    fun load(ctx: Context): List<String> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.split(SEP)?.filter { it.isNotBlank() }.orEmpty()

    fun save(ctx: Context, list: List<String>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, list.joinToString(SEP)).apply()
    }
}
