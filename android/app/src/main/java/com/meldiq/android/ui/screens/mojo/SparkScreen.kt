package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.billing.MojoPurchase
import com.meldiq.android.data.billing.OrgSparks
import com.meldiq.android.data.billing.SparkGoalRules
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.OrgMark
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.screens.workspace.WorkspaceList
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * Settings › Meldiq Spark (the floating redesign, 2026-10-28, as Meldiq Web's own Spark page, apart from the Mojo plans):
 * your Sparks and where they are, your communities' Spark goals, the levels and what each gives everyone, give, move,
 * take back and more Sparks. Everything comes from the server (`/v2/mojo/…`, `/v1/orgs/:orgId/sparks`).
 */
@Composable
fun SparkScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val mojo = container.mojo
    val state by mojo.state.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var orgs by remember { mutableStateOf<List<OrgDto>?>(null) }
    val goals = remember { mutableStateMapOf<String, OrgSparks>() }
    var sheetFor by remember { mutableStateOf<OrgDto?>(null) }
    // Given, moved or taken-back Sparks change the communities' levels: read them again after each change.
    val given = state.me?.sparks?.assignments?.map { it.id to it.orgId }

    LaunchedEffect(Unit) { mojo.refresh() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { mojo.reconcile() } }
    LaunchedEffect(Unit) { orgs = runCatching { container.orgs.orgs() }.getOrDefault(emptyList()) }
    LaunchedEffect(orgs, given) {
        orgs.orEmpty().take(MAX_GOALS).forEach { o -> mojo.orgSparks(o.id).onSuccess { goals[o.id] = it } }
    }

    fun buy(purchase: MojoPurchase) {
        val activity = ctx.findActivity() ?: return
        scope.launch { mojo.prepare(purchase)?.let { mojo.launch(activity, it) } }
    }

    val catalog = state.catalog
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item { GriipTopBar(stringResource(R.string.mojo_spark_title), onBack = { nav.popBackStack() }) }
        item(key = "hero") { SparkHero(state.me?.sparks?.total, state.me?.sparks?.free) }
        if (catalog == null) {
            item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Griip.colors.primary) }
            }
            return@LazyColumn
        }
        val list = orgs.orEmpty().take(MAX_GOALS)
        if (list.isNotEmpty()) {
            item(key = "communities-title") { SectionTitle(stringResource(R.string.spark_communities)) }
            items(list, key = { "goal-" + it.id }) { o ->
                CommunityGoalRow(o, goals[o.id]?.let(SparkGoalRules::of), onClick = { sheetFor = o })
            }
        }
        item(key = "sparks") { SparkSection(catalog, state.entitlements, state.offers, state.busy, state.me, onBuy = ::buy) }
    }
    sheetFor?.let { o ->
        CommunitySparkSheet(o, onSeePlans = { sheetFor = null; nav.navigate(Routes.MOJO) }) {
            sheetFor = null
            scope.launch { mojo.orgSparks(o.id).onSuccess { goals[o.id] = it } }
        }
    }
}

/** How many communities' goals the page reads (one request each). */
private const val MAX_GOALS = 12

@Composable
internal fun SparkHero(total: Int?, free: Int?) {
    val c = Griip.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Space.gutter).clip(Shapes.hero)
            .background(Brush.linearGradient(listOf(c.primarySoft, c.surface))).border(1.dp, c.border, Shapes.hero).padding(20.dp),
    ) {
        Box(Modifier.size(44.dp).clip(Shapes.pill).background(Brush.linearGradient(listOf(c.accentStart, c.accentEnd))), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Bolt, null, tint = c.onAccent, modifier = Modifier.size(26.dp))
        }
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.mojo_spark_title), style = Griip.type.headline.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(4.dp))
        Text(stringResource(R.string.mojo_spark_body), style = Griip.type.bodySmall, color = c.textSecondary)
        if (total != null && total > 0) {
            Spacer(Modifier.height(10.dp))
            Text(
                stringResource(R.string.spark_hero_yours, total, free ?: 0), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.primary,
            )
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text, style = Griip.type.title, color = Griip.colors.textPrimary,
        modifier = Modifier.padding(horizontal = Space.gutter).semantics { heading() },
    )
}

/** One community: its mark, name, level chip and the bar toward its next level; opens its Sparks. */
@Composable
private fun CommunityGoalRow(org: OrgDto, goal: SparkGoalRules.Goal?, onClick: () -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.gutter).clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card)
            .pressable(onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrgMark(org.id, org.name, WorkspaceList.colorSeed(org), org.photoRev, size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(org.name, style = Griip.type.titleSmall, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.width(6.dp))
                goal?.let { SparkLevelChip(it.level) }
            }
            Spacer(Modifier.height(6.dp))
            SparkBar(goal?.fraction ?: 0f)
            goal?.let {
                Text(
                    it.nextLevel?.let { n -> stringResource(R.string.mojo_spark_next, it.needs, n) } ?: stringResource(R.string.mojo_spark_max),
                    style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}
