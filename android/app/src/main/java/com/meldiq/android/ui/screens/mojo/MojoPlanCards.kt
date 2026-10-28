package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Monitor
import androidx.compose.material.icons.outlined.WorkspacePremium
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.billing.Entitlements
import com.meldiq.android.data.billing.MojoCatalog
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.data.billing.MojoPlans.PlanAction
import com.meldiq.android.data.billing.MojoPurchase
import com.meldiq.android.data.billing.PlanPerks
import com.meldiq.android.data.billing.PlayOffer
import com.meldiq.android.data.billing.PlayProducts
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import java.text.DateFormat
import java.util.Date

/** The top card: what Mojo is, in the palette's hero colours, and the plan this account is on. */
@Composable
internal fun MojoHero(e: Entitlements?, catalog: MojoCatalog?) {
    val c = Griip.colors
    val current = MojoPlans.currentKey(e)
    Column(
        Modifier.padding(horizontal = Space.gutter).fillMaxWidth().clip(Shapes.panel)
            .background(Brush.linearGradient(listOf(c.heroStart, c.heroMid, c.heroEnd)))
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AutoAwesome, null, tint = c.onAccent, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.mojo_kicker), style = Griip.type.label.copy(fontWeight = FontWeight.Bold), color = c.onAccent)
        }
        Spacer(Modifier.height(10.dp))
        Text(stringResource(R.string.mojo_headline), style = Griip.type.headline, color = c.onAccent, modifier = Modifier.semantics { heading() })
        Text(stringResource(R.string.mojo_headline_accent), style = Griip.type.headline, color = c.onAccent.copy(alpha = 0.85f))
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.mojo_hero_body), style = Griip.type.bodySmall, color = c.onAccent.copy(alpha = 0.9f))
        Spacer(Modifier.height(14.dp))
        val label = if (isPaid(current)) stringResource(R.string.mojo_on_plan, catalog?.plan(current)?.name ?: current) else stringResource(R.string.mojo_on_free)
        Text(
            label, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.onAccent,
            modifier = Modifier.clip(Shapes.pill).background(c.onAccent.copy(alpha = 0.16f)).padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

/** Where the current plan comes from and until when: Google Play, the website, a trial, an invite or a gift. */
@Composable
internal fun PlanStatusCard(e: Entitlements?, onManage: (String?) -> Unit, onRestore: () -> Unit) {
    val c = Griip.colors
    val p = e?.personal
    val current = MojoPlans.currentKey(e)
    val sub = p?.subscription
    val playBilled = sub?.provider == MojoPlans.PROVIDER_PLAY
    GlassCard(Modifier.padding(horizontal = Space.gutter).fillMaxWidth()) {
        val until = p?.accessUntil?.let(::day)
        val lines = buildList {
            if (p?.standing == MojoPlans.STANDING_GRACE && until != null) add(stringResource(R.string.mojo_grace, until) to c.warning)
            else if (isPaid(current) && until != null) {
                val trial = p?.trial
                when {
                    trial != null -> add(stringResource(trialText(trial.source), day(trial.endsAt)) to c.textSecondary)
                    p?.renews == true -> add(stringResource(R.string.mojo_renews_on, until) to c.textSecondary)
                    else -> add(stringResource(R.string.mojo_ends_on, until) to c.textSecondary)
                }
            }
            if (sub != null && isPaid(current)) add(stringResource(if (playBilled) R.string.mojo_source_play else R.string.mojo_source_web) to c.textTertiary)
        }
        if (lines.isEmpty()) Text(stringResource(R.string.mojo_on_free), style = Griip.type.bodyMedium, color = c.textPrimary)
        lines.forEach { (t, color) -> Text(t, style = Griip.type.bodySmall, color = color, modifier = Modifier.padding(vertical = 2.dp)) }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (playBilled) {
                PillButton(stringResource(R.string.mojo_manage_play), { onManage(PlayProducts.subscriptionFor(current)) }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
            }
            PillButton(stringResource(R.string.mojo_restore), onRestore, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
        }
    }
}

private fun trialText(source: String): Int = when (source) {
    "invite", "invite_bonus" -> R.string.mojo_source_invite
    "gift" -> R.string.mojo_source_gift
    else -> R.string.mojo_source_trial
}

internal fun day(t: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(t))

/** Go and Plus, each with Google Play's price and the action this account can take; Free as a short reminder. */
@Composable
internal fun PlanCards(
    catalog: MojoCatalog,
    e: Entitlements?,
    offers: Map<String, PlayOffer>,
    busy: String?,
    onBuy: (MojoPurchase) -> Unit,
    onManage: (String?) -> Unit,
) {
    Column(Modifier.padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.mojo_plans), style = Griip.type.title, color = Griip.colors.textPrimary, modifier = Modifier.semantics { heading() })
        catalog.plans.filter { isPaid(it.key) }.sortedByDescending { MojoPlans.rank(it.key) }.forEach { plan ->
            val productId = PlayProducts.subscriptionFor(plan.key)
            val offer = productId?.let { offers[it] }
            PlanCard(catalog, plan, offer, MojoPlans.action(plan.key, e, offer != null), busy = busy, inTrial = e?.personal?.trial != null) { action ->
                when (action) {
                    is PlanAction.Buy -> productId?.let { onBuy(MojoPurchase.Plan(plan.key, it, action.replacing)) }
                    else -> onManage(PlayProducts.subscriptionFor(MojoPlans.currentKey(e)))
                }
            }
        }
        val freeAction = MojoPlans.action(MojoPlans.FREE, e, true)
        if (freeAction == PlanAction.CancelInPlay) {
            PillButton(
                stringResource(R.string.mojo_cancel_in_play), { onManage(PlayProducts.subscriptionFor(MojoPlans.currentKey(e))) },
                Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 44.dp,
            )
        }
    }
}

@Composable
private fun PlanCard(catalog: MojoCatalog, plan: PlanPerks, offer: PlayOffer?, action: PlanAction, busy: String?, inTrial: Boolean, onAction: (PlanAction) -> Unit) {
    val c = Griip.colors
    val featured = plan.key == MojoPlans.PLUS
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.surface)
            .border(if (featured || action == PlanAction.Current) 2.dp else 1.dp, if (featured || action == PlanAction.Current) c.primary else c.border, shape)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(plan.name, style = Griip.type.title, color = c.textPrimary, modifier = Modifier.weight(1f))
            if (action == PlanAction.Current) {
                Text(
                    stringResource(R.string.mojo_current), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primary,
                    modifier = Modifier.clip(Shapes.pill).background(c.primarySoft).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        Text(
            offer?.let { stringResource(R.string.mojo_per_month, it.price) } ?: stringResource(R.string.mojo_price_unavailable),
            style = if (offer != null) Griip.type.headline else Griip.type.bodySmall,
            color = if (offer != null) c.textPrimary else c.textTertiary,
        )
        Spacer(Modifier.height(10.dp))
        perkLines(catalog, plan).forEach { line ->
            Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                Icon(Icons.Outlined.CheckCircle, null, tint = c.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(line, style = Griip.type.bodySmall, color = c.textPrimary)
            }
        }
        if (plan.check) Text(stringResource(R.string.mojo_check_note), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(12.dp))
        PlanButton(plan, offer, action, busy, onAction)
        if (action is PlanAction.Buy && action.replacing != null) Note(stringResource(R.string.mojo_upgrade_note))
        if (action is PlanAction.Buy && action.replacing == null && inTrial) Note(stringResource(R.string.mojo_trial_note))
    }
}

@Composable
private fun PlanButton(plan: PlanPerks, offer: PlayOffer?, action: PlanAction, busy: String?, onAction: (PlanAction) -> Unit) {
    val productId = PlayProducts.subscriptionFor(plan.key)
    val (label, enabled, tone) = when (action) {
        is PlanAction.Buy -> Triple(
            when {
                action.replacing == null -> stringResource(R.string.mojo_get, plan.name, stringResource(R.string.mojo_per_month, offer?.price.orEmpty()))
                action.upgrade -> stringResource(R.string.mojo_upgrade, plan.name)
                else -> stringResource(R.string.mojo_switch, plan.name)
            },
            busy == null, ButtonTone.Primary,
        )
        PlanAction.Current -> Triple(stringResource(R.string.mojo_current), false, ButtonTone.Glass)
        PlanAction.ManagedElsewhere -> Triple(stringResource(R.string.mojo_managed_elsewhere), false, ButtonTone.Glass)
        PlanAction.Unavailable -> Triple(stringResource(R.string.mojo_price_unavailable), false, ButtonTone.Glass)
        PlanAction.CancelInPlay -> Triple(stringResource(R.string.mojo_cancel_in_play), true, ButtonTone.Glass)
        PlanAction.Included -> Triple(stringResource(R.string.mojo_included_ends), false, ButtonTone.Glass)
    }
    PillButton(label, { onAction(action) }, Modifier.fillMaxWidth(), tone = tone, enabled = enabled, loading = busy != null && busy == productId, height = 48.dp)
}

@Composable
private fun Note(text: String) {
    Text(text, style = Griip.type.caption, color = Griip.colors.textTertiary, modifier = Modifier.padding(top = 6.dp))
}

@Composable
private fun perkLines(catalog: MojoCatalog, plan: PlanPerks): List<String> = buildList {
    add(stringResource(R.string.mojo_perk_chars, "%,d".format(plan.messageChars)))
    add(stringResource(R.string.mojo_perk_upload, MojoPlans.size(plan.uploadBytes)))
    add(stringResource(R.string.mojo_perk_screen, presets(catalog, plan.screen)))
    when (plan.sparks) {
        0 -> Unit
        1 -> add(stringResource(R.string.mojo_perk_sparks_one))
        else -> add(stringResource(R.string.mojo_perk_sparks, plan.sparks))
    }
    add(stringResource(R.string.mojo_perk_items, plan.customItems))
    when (plan.badge) {
        "plus" -> add(stringResource(R.string.mojo_perk_badge_plus))
        "go" -> add(stringResource(R.string.mojo_perk_badge_go))
    }
}

/** "1080p 60 fps or 2K (1440p) 30 fps": the catalog's own labels for a plan's or a level's screen-share ceilings. */
@Composable
internal fun presets(catalog: MojoCatalog, ids: List<String>): String {
    val labels = ids.mapNotNull { catalog.preset(it)?.label }
    return when (labels.size) {
        0 -> stringResource(R.string.mojo_none)
        1 -> labels.first()
        else -> stringResource(R.string.mojo_or, labels.dropLast(1).joinToString(", "), labels.last())
    }
}

/** What Mojo Plus adds, one card per benefit, with the catalog's numbers (as the plan comparison, in words). */
@Composable
internal fun BenefitCards(catalog: MojoCatalog) {
    val plus = catalog.plan(MojoPlans.PLUS) ?: return
    val c = Griip.colors
    val items = listOf(
        Icons.Outlined.ChatBubbleOutline to (stringResource(R.string.mojo_perk_chars, "%,d".format(plus.messageChars)) to stringResource(R.string.mojo_perk_chars_body)),
        Icons.Outlined.Inventory2 to (stringResource(R.string.mojo_perk_upload, MojoPlans.size(plus.uploadBytes)) to stringResource(R.string.mojo_perk_upload_body)),
        Icons.Outlined.Monitor to (stringResource(R.string.mojo_perk_screen, presets(catalog, plus.screen)) to stringResource(R.string.mojo_perk_screen_body)),
        Icons.Outlined.WorkspacePremium to (stringResource(R.string.mojo_perk_badge_plus) to stringResource(R.string.mojo_perk_badge_body)),
    )
    Column(Modifier.padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items.forEach { (icon, text) ->
            Row(Modifier.fillMaxWidth().clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card).padding(14.dp)) {
                Box(
                    Modifier.size(40.dp).clip(Shapes.iconTile).background(Brush.linearGradient(listOf(c.accentStart, c.accentEnd))),
                    contentAlignment = Alignment.Center,
                ) { Icon(icon, null, tint = c.onAccent, modifier = Modifier.size(22.dp)) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(text.first, style = Griip.type.titleSmall, color = c.textPrimary)
                    Text(text.second, style = Griip.type.bodySmall, color = c.textSecondary)
                }
            }
        }
    }
}

/** Free, Go and Plus side by side, every number from the catalog. Bots aren't listed: Meldiq has none yet. */
@Composable
internal fun CompareTable(catalog: MojoCatalog, offers: Map<String, PlayOffer>) {
    val c = Griip.colors
    val plans = catalog.plans.sortedBy { MojoPlans.rank(it.key) }
    if (plans.isEmpty()) return
    val rows: List<Pair<String, List<String>>> = listOf(
        stringResource(R.string.mojo_row_chars) to plans.map { "%,d".format(it.messageChars) },
        stringResource(R.string.mojo_row_upload) to plans.map { MojoPlans.size(it.uploadBytes) },
        stringResource(R.string.mojo_row_screen) to plans.map { presets(catalog, it.screen) },
        stringResource(R.string.mojo_row_sparks) to plans.map { it.sparks.toString() },
        stringResource(R.string.mojo_row_items) to plans.map { it.customItems.toString() },
        stringResource(R.string.mojo_row_badge) to plans.map { it.badge?.replaceFirstChar(Char::uppercase) ?: stringResource(R.string.mojo_none) },
        stringResource(R.string.mojo_row_check) to plans.map { stringResource(if (it.check) R.string.mojo_yes else R.string.mojo_no) },
        stringResource(R.string.mojo_row_price) to plans.map { p ->
            if (!isPaid(p.key)) "0" else PlayProducts.subscriptionFor(p.key)?.let { offers[it]?.price } ?: "—"
        },
    )
    Column(Modifier.padding(horizontal = Space.gutter)) {
        Text(stringResource(R.string.mojo_compare), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.padding(bottom = 8.dp).semantics { heading() })
        Column(Modifier.fillMaxWidth().clip(Shapes.card).border(1.dp, c.border, Shapes.card)) {
            CompareRow("", plans.map { if (isPaid(it.key)) it.name else stringResource(R.string.mojo_plan_free) }, header = true)
            rows.forEach { (label, values) -> CompareRow(label, values, header = false) }
        }
    }
}

@Composable
private fun CompareRow(label: String, values: List<String>, header: Boolean) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().background(if (header) c.surfaceVariant else c.surface).padding(horizontal = 10.dp, vertical = 10.dp)) {
        Text(label, style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary, modifier = Modifier.weight(1.3f))
        values.forEachIndexed { i, v ->
            val plus = i == values.lastIndex
            Text(
                v, style = Griip.type.caption.copy(fontWeight = if (header || plus) FontWeight.Bold else FontWeight.Normal),
                color = if (plus) c.primary else c.textSecondary, modifier = Modifier.weight(1f).padding(start = 6.dp),
            )
        }
    }
}

@Composable
internal fun WhyCard() {
    val c = Griip.colors
    GlassCard(Modifier.padding(horizontal = Space.gutter).fillMaxWidth()) {
        Text(stringResource(R.string.mojo_why_title), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(6.dp))
        Text(stringResource(R.string.mojo_why_body), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(10.dp))
        Text(stringResource(R.string.mojo_still_free), style = Griip.type.caption, color = c.textTertiary)
    }
}
