package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.api.OrgDto
import com.meldiq.android.data.billing.Entitlements
import com.meldiq.android.data.billing.GiftView
import com.meldiq.android.data.billing.MojoCatalog
import com.meldiq.android.data.billing.MojoMe
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.data.billing.SparkAssignment
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/** What the person is about to do with a Spark: give a free one, or move a given one, to a server they pick. */
private sealed interface Pick {
    data object Give : Pick
    data class Move(val spark: SparkAssignment) : Pick
}

/**
 * The person's own Sparks (API 0.54.0): how many they hold and where each is given, with Give, Move and Take back. Taking
 * one back first reads the server's level, so the confirmation says when that server would drop a level.
 */
@Composable
internal fun MySparksCard(me: MojoMe) {
    val container = LocalContainer.current
    val mojo = container.mojo
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var pick by remember { mutableStateOf<Pick?>(null) }
    var removing by remember { mutableStateOf<SparkAssignment?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val s = me.sparks
    GlassCard(Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.mojo_spark_yours), style = Griip.type.titleSmall, color = c.textPrimary)
        Text(
            if (s.total == 0) stringResource(R.string.mojo_spark_none) else stringResource(R.string.mojo_spark_have, s.total, s.included, s.purchased),
            style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp),
        )
        s.assignments.forEach { a -> AssignmentRow(a, onMove = { pick = Pick.Move(a) }, onRemove = { removing = a }) }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
        if (s.total > 0) {
            Spacer(Modifier.height(10.dp))
            if (s.free > 0) {
                PillButton(stringResource(R.string.mojo_spark_give), { pick = Pick.Give }, Modifier.fillMaxWidth(), height = 44.dp)
                Text(stringResource(R.string.mojo_spark_free_n, s.free), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 4.dp))
            } else {
                Text(stringResource(R.string.mojo_spark_none_free), style = Griip.type.caption, color = c.textTertiary)
            }
        }
    }
    pick?.let { p ->
        ServerPicker(exclude = (p as? Pick.Move)?.spark?.orgId, onDismiss = { pick = null }) { org ->
            pick = null
            scope.launch {
                val r = when (p) {
                    Pick.Give -> mojo.giveSpark(org.id)
                    is Pick.Move -> mojo.moveSpark(p.spark.id, org.id)
                }
                error = r.exceptionOrNull()?.friendly()
            }
        }
    }
    removing?.let { a ->
        RemoveSparkDialog(a, onDismiss = { removing = null }) {
            removing = null
            scope.launch { error = mojo.removeSpark(a.id).exceptionOrNull()?.friendly() }
        }
    }
}

@Composable
private fun AssignmentRow(a: SparkAssignment, onMove: () -> Unit, onRemove: () -> Unit) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(a.orgName ?: a.orgId, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                when {
                    !a.member -> stringResource(R.string.mojo_spark_left_server)
                    a.paused -> stringResource(R.string.mojo_spark_paused)
                    else -> stringResource(R.string.mojo_spark_since, day(a.assignedAt))
                },
                style = Griip.type.caption, color = if (a.paused || !a.member) c.warning else c.textTertiary,
            )
        }
        TextButton(onMove) { Text(stringResource(R.string.mojo_spark_move), color = c.primary) }
        TextButton(onRemove) { Text(stringResource(R.string.mojo_spark_remove), color = c.danger) }
    }
}

/** Says before taking a Spark back whether that server drops a level for everyone there. */
@Composable
internal fun RemoveSparkDialog(a: SparkAssignment, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val mojo = LocalContainer.current.mojo
    var body by remember { mutableStateOf<String?>(null) }
    val name = a.orgName ?: a.orgId
    val drop = stringResource(R.string.mojo_spark_remove_drop)
    val same = stringResource(R.string.mojo_spark_remove_same, name)
    LaunchedEffect(a.id) {
        body = mojo.orgSparks(a.orgId).fold(
            { o ->
                // A paused Spark doesn't count now, so taking it back changes nothing there.
                val after = MojoPlans.levelWith(o.levels, if (a.paused) o.active else o.active - 1)
                if (after < o.level) drop.format(name, o.level, after) else same
            },
            { same },
        )
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.mojo_spark_remove_title)) },
        text = { Text(body ?: stringResource(R.string.mojo_loading)) },
        confirmButton = { TextButton(onConfirm, enabled = body != null) { Text(stringResource(R.string.mojo_spark_remove), color = Griip.colors.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.mojo_cancel)) } },
    )
}

/** The person's communities, to give or move a Spark to. */
@Composable
private fun ServerPicker(exclude: String?, onDismiss: () -> Unit, onPick: (OrgDto) -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    var orgs by remember { mutableStateOf<List<OrgDto>?>(null) }
    LaunchedEffect(Unit) { orgs = runCatching { container.orgs.orgs() }.getOrDefault(emptyList()).filter { it.id != exclude } }
    GlassSheet(onDismiss, title = stringResource(R.string.mojo_spark_pick_server)) {
        val list = orgs
        if (list == null) Text(stringResource(R.string.mojo_loading), style = Griip.type.bodySmall, color = c.textSecondary)
        else LazyColumn(Modifier.heightIn(max = 420.dp)) {
            items(list, key = { it.id }) { o ->
                Text(
                    o.name, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(Shapes.small)
                        .pressable({ onPick(o) }, role = Role.Button).padding(horizontal = 8.dp, vertical = 16.dp),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
    }
}

/** Show or hide the Go or Plus badge; shown only while the plan gives one. */
@Composable
internal fun BadgeCard(me: MojoMe) {
    val mojo = LocalContainer.current.mojo
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    if (me.badge.kind == null) return
    var saving by remember { mutableStateOf(false) }
    GlassCard(Modifier.padding(horizontal = Space.gutter).fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.mojo_badge_title), style = Griip.type.titleSmall, color = c.textPrimary)
                Text(stringResource(R.string.mojo_badge_sub), style = Griip.type.caption, color = c.textSecondary)
                if (me.badge.check) Text(stringResource(R.string.mojo_check_note), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 4.dp))
            }
            Switch(
                checked = !me.badge.hidden, enabled = !saving,
                onCheckedChange = { show -> saving = true; scope.launch { mojo.setBadgeHidden(!show); saving = false } },
            )
        }
    }
}

/** Gifts received (start one when you like) and sent (where each stands). */
@Composable
internal fun GiftsCard(me: MojoMe, catalog: MojoCatalog, e: Entitlements?) {
    val mojo = LocalContainer.current.mojo
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf<GiftView?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    if (me.gifts.received.isEmpty() && me.gifts.sent.isEmpty()) return
    fun start(g: GiftView) = scope.launch { error = mojo.redeemGift(g.id).exceptionOrNull()?.friendly() }
    GlassCard(Modifier.padding(horizontal = Space.gutter).fillMaxWidth()) {
        if (me.gifts.received.isNotEmpty()) {
            Text(stringResource(R.string.mojo_gifts_received), style = Griip.type.titleSmall, color = c.textPrimary)
            me.gifts.received.forEach { g ->
                GiftRow(g, catalog, received = true) {
                    if (MojoPlans.giftOverlaps(e, g.planKey)) confirm = g else start(g)
                }
            }
        }
        if (me.gifts.sent.isNotEmpty()) {
            Text(
                stringResource(R.string.mojo_gifts_sent), style = Griip.type.titleSmall, color = c.textPrimary,
                modifier = Modifier.padding(top = if (me.gifts.received.isEmpty()) 0.dp else 14.dp),
            )
            me.gifts.sent.forEach { g -> GiftRow(g, catalog, received = false, onStart = null) }
        }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
    }
    confirm?.let { g ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            text = { Text(stringResource(R.string.mojo_gift_overlap)) },
            confirmButton = { TextButton({ confirm = null; start(g) }) { Text(stringResource(R.string.mojo_gift_start_anyway)) } },
            dismissButton = { TextButton({ confirm = null }) { Text(stringResource(R.string.mojo_cancel)) } },
        )
    }
}

@Composable
private fun GiftRow(g: GiftView, catalog: MojoCatalog, received: Boolean, onStart: (() -> Unit)?) {
    val c = Griip.colors
    val plan = catalog.plan(g.planKey)?.name ?: g.planKey
    val length = when (g.months) {
        1 -> stringResource(R.string.mojo_gift_month_one)
        12 -> stringResource(R.string.mojo_gift_year)
        else -> stringResource(R.string.mojo_gift_months, g.months)
    }
    val who = g.person.name ?: stringResource(R.string.mojo_gift_someone)
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(if (received) R.string.mojo_gift_from else R.string.mojo_gift_to, plan, length, who),
                style = Griip.type.bodyMedium, color = c.textPrimary,
            )
            g.note?.takeIf { it.isNotBlank() }?.let { Text("“$it”", style = Griip.type.caption, color = c.textSecondary) }
            Text(
                stringResource(
                    when (g.status) {
                        "redeemed" -> R.string.mojo_gift_started
                        "refunded" -> R.string.mojo_gift_refunded
                        "paid" -> R.string.mojo_gift_waiting
                        else -> R.string.mojo_gift_unpaid
                    },
                ),
                style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.textTertiary,
            )
        }
        if (onStart != null && g.status == "paid") PillButton(stringResource(R.string.mojo_gift_start), onStart, tone = ButtonTone.Primary, height = 40.dp)
    }
}
