package com.meldiq.android.ui.screens.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
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
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.CommunityAccess
import com.meldiq.android.data.api.CommunityPreviewRes
import com.meldiq.android.data.api.DiscoverCommunityDto
import com.meldiq.android.data.model.ApplicationRules
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.chats.channelIcon
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Discover: public communities (owners list theirs), most members first, searchable. A preview shows the rules and the
 * channels everyone can see before joining; open ones are joined in one tap, invite-only ones need an invitation.
 */
@Composable
fun DiscoverScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val c = Griip.colors
    var q by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<DiscoverCommunityDto>?>(null) }
    var next by remember { mutableStateOf<Int?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var previewing by remember { mutableStateOf<DiscoverCommunityDto?>(null) }
    LaunchedEffect(q) {
        delay(if (q.isEmpty()) 0 else 300) // waits for typing to pause
        runCatching { container.orgs.discover(q) }.onSuccess { results = it.communities; next = it.nextCursor; error = null }.onFailure { error = it.friendly() }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { GriipTopBar(stringResource(R.string.dc_title), onBack = { nav.popBackStack() }) }
        item {
            GriipTextField(q, { q = it.take(60) }, stringResource(R.string.dc_search), Modifier.padding(horizontal = Space.gutter), leadingIcon = Icons.Outlined.Search)
            Spacer(Modifier.height(8.dp))
        }
        error?.let { item { StatusBanner(it, BannerKind.Warning, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        val list = results
        when {
            list == null -> item { ShimmerList(4) }
            list.isEmpty() -> item { EmptyState(Icons.Outlined.Explore, stringResource(R.string.dc_title), stringResource(R.string.dc_empty)) }
            else -> items(list, key = { it.id }) { o ->
                ListCard(
                    o.name, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                    subtitle = o.description,
                    leading = { OrgMark(o.id, o.name, o.id.hashCode(), o.photoRev, size = 48.dp) },
                    meta = {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            TagPill(stringResource(R.string.dc_members, o.memberCount), c.textSecondary, c.surfaceVariant)
                            when {
                                o.joined -> TagPill(stringResource(R.string.dc_joined), c.success, c.successSoft)
                                o.joinPolicy == CommunityAccess.OPEN -> TagPill(stringResource(R.string.dc_open), c.primaryDeep, c.primarySoft)
                                else -> TagPill(stringResource(R.string.dc_invite_only), c.warning, c.warningSoft)
                            }
                        }
                    },
                    onClick = { previewing = o },
                )
            }
        }
        next?.let { cursor ->
            item {
                PillButton(stringResource(R.string.dc_more), {
                    scope.launch { runCatching { container.orgs.discover(q, cursor) }.onSuccess { results = results.orEmpty() + it.communities; next = it.nextCursor }.onFailure { error = it.friendly() } }
                }, Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 10.dp), tone = ButtonTone.Glass)
            }
        }
    }
    previewing?.let { o ->
        CommunityPreviewSheet(o, onDismiss = { previewing = null }, onOpen = { orgId ->
            previewing = null
            scope.launch {
                container.orgs.select(orgId)
                nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = false } }
            }
        })
    }
}

@Composable
private fun CommunityPreviewSheet(o: DiscoverCommunityDto, onDismiss: () -> Unit, onOpen: (String) -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    val c = Griip.colors
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var preview by remember { mutableStateOf<CommunityPreviewRes?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var application by remember { mutableStateOf<com.meldiq.android.data.api.MyApplicationDto?>(null) }
    var applying by remember { mutableStateOf(false) }
    LaunchedEffect(o.id) {
        runCatching { container.orgs.preview(o.id) }.onSuccess { preview = it; application = it.application }.onFailure { error = it.friendly() }
    }
    GlassSheet(onDismiss, title = o.name) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            // API 0.44.0: the community's banner or accent band, as Meldiq Web's Discover cards show it.
            if (o.bannerRev != null || o.accent != null) {
                androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().clip(com.meldiq.android.ui.theme.Shapes.small)) {
                    com.meldiq.android.ui.screens.community.CommunityBanner(o.id, o.accent, o.bannerRev)
                }
                Spacer(Modifier.height(10.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OrgMark(o.id, o.name, o.id.hashCode(), o.photoRev, size = 56.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(o.name, style = Griip.type.title, color = c.textPrimary)
                    Text(stringResource(R.string.dc_members, o.memberCount), style = Griip.type.caption, color = c.textSecondary)
                }
            }
            o.description?.let { Spacer(Modifier.height(10.dp)); Text(it, style = Griip.type.body, color = c.textSecondary) }
            val p = preview
            if (p == null && error == null) ShimmerList(2, Modifier.padding(top = 12.dp))
            p?.community?.rules?.takeIf { it.isNotBlank() }?.let { rules ->
                Spacer(Modifier.height(12.dp))
                GlassCard(Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.cm_rules), style = Griip.type.section, color = c.textPrimary)
                    Spacer(Modifier.height(6.dp))
                    Text(rules, style = Griip.type.body, color = c.textSecondary)
                }
            }
            if (p != null && p.channels.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(stringResource(R.string.dc_channels), style = Griip.type.section, color = c.textSecondary)
                p.channels.take(12).forEach { ch ->
                    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(channelIcon(ch.kind, ch.voice, ch.format), null, tint = c.textSecondary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(ch.name.orEmpty(), style = Griip.type.bodyMedium, color = c.textPrimary)
                    }
                }
            }
            error?.let { Spacer(Modifier.height(10.dp)); StatusBanner(it, BannerKind.Error) }
            Spacer(Modifier.height(16.dp))
            // Batch B4b: a community with questions takes applications instead of open joining.
            val questions = p?.community?.joinQuestions
            val offer = ApplicationRules.offer(!questions.isNullOrEmpty() || (p == null && o.applications), application?.status, o.joinPolicy == CommunityAccess.OPEN)
            if (application?.status == ApplicationRules.DENIED && offer == ApplicationRules.Offer.Apply) {
                StatusBanner(stringResource(R.string.ja_denied), BannerKind.Info)
                Spacer(Modifier.height(10.dp))
            }
            when {
                p?.banned == true -> StatusBanner(stringResource(R.string.dc_banned), BannerKind.Warning)
                p?.joined == true || o.joined -> PillButton(stringResource(R.string.dc_open_it), { onOpen(o.id) }, Modifier.fillMaxWidth(), height = 50.dp)
                offer == ApplicationRules.Offer.Waiting -> {
                    StatusBanner(stringResource(R.string.ja_waiting), BannerKind.Info)
                    PillButton(stringResource(R.string.ja_withdraw), {
                        val id = application?.id ?: return@PillButton
                        scope.launch {
                            runCatching { container.applications.withdraw(id) }
                                .onSuccess { application = application?.copy(status = ApplicationRules.WITHDRAWN) }
                                .onFailure { error = it.friendly() }
                        }
                    }, Modifier.fillMaxWidth().padding(top = 10.dp), tone = ButtonTone.Glass, height = 46.dp, showKnob = false)
                }
                offer == ApplicationRules.Offer.Apply -> PillButton(stringResource(R.string.ja_apply), { applying = true }, Modifier.fillMaxWidth(), enabled = !questions.isNullOrEmpty(), height = 50.dp)
                offer == ApplicationRules.Offer.Join -> PillButton(stringResource(R.string.cm_join), {
                    busy = true
                    scope.launch {
                        runCatching { container.orgs.join(o.id) }
                            .onSuccess {
                                android.widget.Toast.makeText(ctx, ctx.getString(R.string.dc_joined_toast, o.name), android.widget.Toast.LENGTH_SHORT).show()
                                onOpen(o.id)
                            }
                            .onFailure { error = it.friendly() }
                        busy = false
                    }
                }, Modifier.fillMaxWidth(), loading = busy, height = 50.dp)
                else -> StatusBanner(stringResource(R.string.dc_ask_invite), BannerKind.Info)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
    val questions = preview?.community?.joinQuestions
    if (applying && !questions.isNullOrEmpty()) {
        com.meldiq.android.ui.screens.moderation.ApplySheet(o.id, o.name, questions, onDismiss = { applying = false }, onSent = {
            applying = false
            application = com.meldiq.android.data.api.MyApplicationDto("", ApplicationRules.PENDING)
            android.widget.Toast.makeText(ctx, ctx.getString(R.string.ja_sent), android.widget.Toast.LENGTH_SHORT).show()
            scope.launch { runCatching { container.orgs.preview(o.id) }.onSuccess { preview = it; application = it.application } }
        })
    }
}
