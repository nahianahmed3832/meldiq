package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.meldiq.android.data.billing.*
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.theme.Griip
import java.text.NumberFormat
import java.util.Currency

/** Interval choice belongs to checkout. Play's own localized price is the charge the user authorizes. */
@Composable
internal fun PlusBillingSheet(catalog: MojoCatalog, offers: Map<String, PlayOffer>, busy: Boolean, onBuy: (String) -> Unit, onDismiss: () -> Unit) {
    var months by remember { mutableIntStateOf(1) }
    val terms = catalog.plusTerms.ifEmpty { listOf(PlusTerm("monthly",1,499,"USD","month",1)) }
    val selected = PlayProducts.plusProduct(months)
    val offer = offers[selected]
    fun format(micros: Long, currency: String): String = NumberFormat.getCurrencyInstance().apply { this.currency = Currency.getInstance(currency) }.format(micros / 1_000_000.0)
    GlassSheet(onDismiss, title = "Meldiq Plus checkout") {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Choose your billing interval", style = Griip.type.title, color = Griip.colors.textPrimary)
            terms.forEach { term ->
                val product = PlayProducts.plusProduct(term.months)
                val price = offers[product]
                val expected = when(term.months) { 3 -> "P3M"; 12 -> "P1Y"; else -> "P1M" }
                val available = price != null && price.period == expected && (price.currency != "USD" || price.priceMicros == term.amountMinor * 10_000L)
                Row(Modifier.fillMaxWidth()) {
                    RadioButton(selected = months == term.months, onClick = { months = term.months }, enabled = available && !busy)
                    Column(Modifier.weight(1f).padding(top = 10.dp)) {
                        Text(if(term.months == 1) "Monthly" else "${term.months} months", color = Griip.colors.textPrimary)
                        Text(if(available) "${price!!.price} billed every ${if(term.months == 1) "month" else "${term.months} months"}" else "Not available yet", color = Griip.colors.textSecondary)
                        val monthly = offers[PlayProducts.MOJO_PLUS]
                        if(available && term.months > 1 && price!!.currency != null && monthly?.currency == price.currency && monthly.priceMicros != null && price.priceMicros != null) {
                            val saving = monthly.priceMicros * term.months - price.priceMicros
                            if(saving > 0) Text("Save ${format(saving,price.currency!!)} vs monthly · about ${format(price.priceMicros / term.months,price.currency)}/month", color = Griip.colors.primary)
                        }
                    }
                }
            }
            Text("Your full payment helps cover Meldiq’s servers, storage and ongoing development.", color = Griip.colors.textSecondary)
            Text("${offer?.price.orEmpty()} renews automatically every ${if(months == 1) "month" else "$months months"} until canceled. Manage or cancel through Google Play. Benefits begin after verified payment.", color = Griip.colors.textSecondary)
            PillButton("Continue with Google Play", { selected?.let(onBuy) }, Modifier.fillMaxWidth(), enabled = !busy && offer != null, height = 48.dp)
        }
    }
}
