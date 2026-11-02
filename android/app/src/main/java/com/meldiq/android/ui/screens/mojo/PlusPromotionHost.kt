package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.data.billing.*
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Only mounted on the settled Home surface. Purchases always enter the native store flow. */
@Composable
fun PlusPromotionHost(nav: NavHostController, safe: Boolean) {
    val container = LocalContainer.current
    val state by container.mojo.state.collectAsStateWithLifecycle()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var promotion by remember { mutableStateOf<PlusPromotion?>(null) }
    var claimed by remember { mutableStateOf(false) }
    val currentSafe by rememberUpdatedState(safe && lifecycle == Lifecycle.State.RESUMED)
    val latestState by rememberUpdatedState(state)
    val offer = state.offers[PlayProducts.MOJO_PLUS]
    val canPromote = safe && lifecycle == Lifecycle.State.RESUMED && state.me?.plan == "free" && state.busy == null && offer != null && offer.period == "P1M" && (offer.currency != "USD" || offer.priceMicros == 4_990_000L)
    LaunchedEffect(Unit) {
        if (state.catalog == null) container.mojo.refresh()
        while (true) {
            delay(5_000)
            val activeOffer = latestState.offers[PlayProducts.MOJO_PLUS]
            if (!currentSafe || latestState.me?.plan != "free" || latestState.busy != null || activeOffer == null || activeOffer.period != "P1M" || activeOffer.currency == "USD" && activeOffer.priceMicros != 4_990_000L) { promotion = null; continue }
            try {
                container.plusPromotions.activity()
                val p = promotion
                if (p != null) {
                    val current = container.plusPromotions.current(p.id)
                    promotion = if (current.active && current.expiresAt != null) p.copy(expiresAt = current.expiresAt) else null
                } else if (!claimed && latestState.offers[PlayProducts.MOJO_PLUS] != null) {
                    val result = container.plusPromotions.claim()
                    if (result != null) { claimed = true; if (currentSafe) promotion = result }
                }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { promotion = null }
        }
    }
    PlusRenewalHost(nav, safe)
    val p = promotion
    LaunchedEffect(p?.id) { if (p != null) runCatching { container.plusPromotions.feedback(p.id, "impression") }.onFailure { if (it is CancellationException) throw it; promotion = null } }
    LaunchedEffect(p?.expiresAt) { if (p != null) { delay((p.expiresAt - System.currentTimeMillis()).coerceAtLeast(0)); promotion = null } }
    if (!canPromote || p == null) return
    val action: (String) -> Unit = { event -> promotion = null; scope.launch { runCatching { container.plusPromotions.feedback(p.id, event); if (event == "click") container.plusPromotions.feedback(p.id, "pricing_visit") } }; if (event == "click") nav.navigate(Routes.MOJO) }
    val content: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(Griip.colors.surface, RoundedCornerShape(20.dp))) {
            Column(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Color(0xFF6C3B31), Color(0xFF42285F))), RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(20.dp)) {
                Row { Text(p.heading, color = Color.White, style = Griip.type.title, modifier = Modifier.weight(1f)); TextButton(onClick = { action("dismiss") }) { Text("Close", color = Color.White) } }
                Text(p.description, color = Color(0xFFDDD0E0), style = Griip.type.bodySmall)
            }
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                latestState.catalog?.plan("plus")?.let { perks ->
                    Text("Files up to ${MojoPlans.size(perks.uploadBytes)}", color = Griip.colors.textPrimary)
                    Text("${perks.sparks} included Sparks · Plus badge", color = Griip.colors.textPrimary)
                }
                Text("Profile customization stays free. Renews monthly until canceled.", color = Griip.colors.textSecondary, style = Griip.type.bodySmall)
                Button(onClick = { action("click") }) { Text("${p.cta} · ${offer?.price}/month") }
                TextButton(onClick = { action("snooze") }) { Text("Not now") }
                TextButton(onClick = { promotion = null; scope.launch { runCatching { container.plusPromotions.optOut() } } }) { Text("Don’t show again") }
            }
        }
    }
    if (p.presentation == "modal") androidx.compose.ui.window.Dialog(onDismissRequest = { action("dismiss") }) { content() }
    else Box(Modifier.padding(12.dp)) { content() }
}
