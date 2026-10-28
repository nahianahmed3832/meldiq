package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CardGiftcard
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.billing.Entitlements
import com.meldiq.android.data.billing.MojoCatalog
import com.meldiq.android.data.billing.MojoMe
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.data.billing.MojoPurchase
import com.meldiq.android.data.billing.PlayOffer
import com.meldiq.android.data.billing.PlayProducts
import com.meldiq.android.data.billing.SparkLevel
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/**
 * Meldiq Spark (docs/MOJO_ANDROID.md): what each server level gives everyone there, the Sparks this person holds, and
 * extra Sparks as monthly packs. Google Play has no quantity for subscriptions, so each pack is its own subscription
 * and the note says so before anyone buys two.
 */
@Composable
internal fun SparkSection(
    catalog: MojoCatalog,
    e: Entitlements?,
    offers: Map<String, PlayOffer>,
    busy: String?,
    me: MojoMe?,
    onBuy: (MojoPurchase) -> Unit,
) {
    val c = Griip.colors
    val plan = catalog.plan(MojoPlans.currentKey(e))
    Column(Modifier.padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Bolt, null, tint = c.primary, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.mojo_spark_title), style = Griip.type.title, color = c.textPrimary, modifier = Modifier.semantics { heading() })
        }
        Text(stringResource(R.string.mojo_spark_body), style = Griip.type.bodySmall, color = c.textSecondary)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            catalog.spark.levels.filter { it.level > 0 }.forEach { LevelCard(catalog, it, last = it.level == catalog.spark.levels.maxOf { l -> l.level }) }
        }
        Text(stringResource(R.string.mojo_spark_level_cap), style = Griip.type.caption, color = c.textTertiary)
        if (me != null) MySparksCard(me)
        else GlassCard(Modifier.fillMaxWidth()) {
            // An older server: what the plan includes, and where giving one happens.
            Text(stringResource(R.string.mojo_spark_yours), style = Griip.type.titleSmall, color = c.textPrimary)
            val included = plan?.sparks ?: 0
            Text(
                stringResource(R.string.mojo_spark_have, MojoPlans.sparksHeld(plan, 0), included, 0),
                style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(top = 4.dp),
            )
            Text(stringResource(R.string.mojo_spark_give_hint), style = Griip.type.caption, color = c.textTertiary, modifier = Modifier.padding(top = 6.dp))
        }
        SparkPacks(offers, busy, onBuy)
    }
}

@Composable
private fun LevelCard(catalog: MojoCatalog, level: SparkLevel, last: Boolean) {
    val c = Griip.colors
    Column(
        Modifier.width(196.dp).clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(stringResource(R.string.mojo_spark_level, level.level), style = Griip.type.titleSmall, color = c.textPrimary)
        Text(
            when {
                last -> stringResource(R.string.mojo_spark_needs_more, level.sparks)
                level.sparks == 1 -> stringResource(R.string.mojo_spark_needs_one)
                else -> stringResource(R.string.mojo_spark_needs, level.sparks)
            },
            style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.primary,
        )
        Spacer(Modifier.height(4.dp))
        LevelLine(stringResource(R.string.mojo_spark_emoji, level.emojiSlots))
        level.uploadBytes?.let { LevelLine(stringResource(R.string.mojo_spark_upload, MojoPlans.size(it))) }
        LevelLine(stringResource(R.string.mojo_spark_voice, level.voiceKbps))
        if (level.screen.isNotEmpty()) LevelLine(stringResource(R.string.mojo_spark_screen, presets(catalog, level.screen)))
    }
}

@Composable
private fun LevelLine(text: String) {
    Text("• $text", style = Griip.type.caption, color = Griip.colors.textSecondary)
}

@Composable
private fun SparkPacks(offers: Map<String, PlayOffer>, busy: String?, onBuy: (MojoPurchase) -> Unit) {
    val c = Griip.colors
    val packs = PlayProducts.SPARK_PACKS.filterValues { it in offers }
    if (packs.isEmpty()) return
    var picked by rememberSaveable { mutableIntStateOf(packs.keys.first()) }
    if (picked !in packs) picked = packs.keys.first()
    Text(stringResource(R.string.mojo_spark_buy), style = Griip.type.titleSmall, color = c.textPrimary)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        packs.keys.forEach { n ->
            val selected = n == picked
            Text(
                stringResource(R.string.mojo_spark_pack, n),
                style = Griip.type.label.copy(fontWeight = FontWeight.Bold), color = if (selected) c.textPrimary else c.textSecondary,
                modifier = Modifier.heightIn(min = 44.dp).clip(Shapes.pill).background(if (selected) c.primarySoft else c.surface)
                    .border(1.dp, if (selected) c.primary else c.border, Shapes.pill)
                    .selectable(selected, role = Role.RadioButton) { picked = n }.padding(horizontal = 18.dp, vertical = 12.dp),
            )
        }
    }
    val productId = packs.getValue(picked)
    val offer = offers.getValue(productId)
    Text(
        if (picked == 1) stringResource(R.string.mojo_spark_pack_desc_one) else stringResource(R.string.mojo_spark_pack_desc, picked),
        style = Griip.type.bodySmall, color = c.textSecondary,
    )
    PillButton(
        stringResource(R.string.mojo_spark_pack_buy, offer.price), { onBuy(MojoPurchase.Sparks(picked, productId)) },
        Modifier.fillMaxWidth(), enabled = busy == null, loading = busy == productId, height = 48.dp,
    )
    Text(stringResource(R.string.mojo_spark_pack_note), style = Griip.type.caption, color = c.textTertiary)
}

/** The gift entry: opens the gift sheet when Google Play sells at least one gift. */
@Composable
internal fun GiftCard(enabled: Boolean, onOpen: () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.padding(horizontal = Space.gutter).fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.CardGiftcard, null, tint = c.primary, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.mojo_gift_title), style = Griip.type.titleSmall, color = c.textPrimary)
                Text(stringResource(R.string.mojo_gift_body), style = Griip.type.caption, color = c.textSecondary)
            }
        }
        Spacer(Modifier.height(10.dp))
        PillButton(
            if (enabled) stringResource(R.string.mojo_gift_open) else stringResource(R.string.mojo_gift_unavailable), onOpen,
            Modifier.fillMaxWidth(), tone = ButtonTone.Glass, enabled = enabled, height = 44.dp,
        )
    }
}
