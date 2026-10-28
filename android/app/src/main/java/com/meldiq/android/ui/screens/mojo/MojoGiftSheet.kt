package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.billing.MojoCatalog
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.data.billing.MojoPurchase
import com.meldiq.android.data.billing.PlayOffer
import com.meldiq.android.data.billing.PlayProducts
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import kotlinx.coroutines.delay

/** Pause after typing before searching people. */
private const val SEARCH_DEBOUNCE_MS = 300L
private const val SEARCH_MAX = 40

/**
 * A gift of Mojo Go or Plus for a friend (docs/MOJO_ANDROID.md › Gifts): who, which plan, how long, a note, and
 * Google Play's price for that exact gift. One payment that never renews; the server records the gift before Google's
 * sheet opens and delivers it once the payment is verified.
 */
@Composable
internal fun GiftSheet(
    catalog: MojoCatalog,
    offers: Map<String, PlayOffer>,
    me: String?,
    busy: Boolean,
    onBuy: (MojoPurchase.Gift) -> Unit,
    onDismiss: () -> Unit,
) {
    val container = LocalContainer.current
    val c = Griip.colors
    var q by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var to by remember { mutableStateOf<UserDto?>(null) }
    var plan by rememberSaveable { mutableStateOf(MojoPlans.PLUS) }
    val months = catalog.gifts.months.ifEmpty { PlayProducts.GIFT_MONTHS }
    var length by rememberSaveable { mutableIntStateOf(months.first()) }
    var note by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(q) {
        if (q.isBlank()) { found = emptyList(); return@LaunchedEffect }
        delay(SEARCH_DEBOUNCE_MS)
        found = runCatching { container.users.search(q.trim()) }.getOrDefault(emptyList()).filter { it.id != me }
    }
    GlassSheet(onDismiss, title = stringResource(R.string.mojo_gift_title)) {
        Label(stringResource(R.string.mojo_gift_who))
        val picked = to
        if (picked != null) {
            PersonRow(picked, selected = true) { to = null }
        } else {
            GriipTextField(q, { q = it.take(SEARCH_MAX) }, stringResource(R.string.mojo_gift_search), Modifier.fillMaxWidth(), leadingIcon = Icons.Outlined.Search)
            LazyColumn(Modifier.heightIn(max = 220.dp)) {
                items(found, key = { it.id }) { u -> PersonRow(u, selected = false) { to = u } }
            }
        }
        Label(stringResource(R.string.mojo_gift_plan))
        Choices(listOf(MojoPlans.GO, MojoPlans.PLUS), plan, { catalog.plan(it)?.name ?: it }) { plan = it }
        Label(stringResource(R.string.mojo_gift_length))
        Choices(months, length, { monthsLabel(it) }) { length = it }
        Label(stringResource(R.string.mojo_gift_note))
        val noteMax = catalog.gifts.noteMax.takeIf { it > 0 } ?: DEFAULT_NOTE_MAX
        GriipTextField(note, { note = it.take(noteMax) }, stringResource(R.string.mojo_gift_note), Modifier.fillMaxWidth(), helper = "${note.length}/$noteMax")
        Spacer(Modifier.height(10.dp))
        Text(stringResource(R.string.mojo_gift_policy), style = Griip.type.caption, color = c.textTertiary)
        Spacer(Modifier.height(12.dp))
        val productId = PlayProducts.gift(plan, length)
        val offer = productId?.let { offers[it] }
        PillButton(
            if (offer != null) stringResource(R.string.mojo_gift_buy, offer.price) else stringResource(R.string.mojo_gift_unavailable),
            { if (picked != null && productId != null) onBuy(MojoPurchase.Gift(plan, length, picked.id, note, productId)) },
            Modifier.fillMaxWidth(), enabled = picked != null && offer != null && !busy, loading = busy, height = 48.dp,
        )
        Spacer(Modifier.height(12.dp))
    }
}

private const val DEFAULT_NOTE_MAX = 280

@Composable
private fun monthsLabel(n: Int): String = when (n) {
    1 -> stringResource(R.string.mojo_gift_month_one)
    12 -> stringResource(R.string.mojo_gift_year)
    else -> stringResource(R.string.mojo_gift_months, n)
}

@Composable
private fun Label(text: String) {
    Text(
        text, style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = Griip.colors.textPrimary,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
    )
}

@Composable
private fun <T> Choices(options: List<T>, selected: T, label: @Composable (T) -> String, onPick: (T) -> Unit) {
    val c = Griip.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { o ->
            val on = o == selected
            Text(
                label(o), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = if (on) c.textPrimary else c.textSecondary,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp).clip(Shapes.pill).background(if (on) c.primarySoft else c.surface)
                    .border(1.dp, if (on) c.primary else c.border, Shapes.pill)
                    .selectable(on, role = Role.RadioButton) { onPick(o) }.padding(vertical = 12.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun PersonRow(u: UserDto, selected: Boolean, onClick: () -> Unit) {
    val c = Griip.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(Shapes.small).selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected, onClick = null)
        UserAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, size = 36.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(u.displayName, style = Griip.type.bodyMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("@${u.username}", style = Griip.type.caption, color = c.textTertiary, maxLines = 1)
        }
    }
}
