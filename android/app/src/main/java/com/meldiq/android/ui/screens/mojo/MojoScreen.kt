package com.meldiq.android.ui.screens.mojo

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.data.billing.MojoNotice
import com.meldiq.android.data.billing.MojoPlans
import com.meldiq.android.data.billing.MojoPurchase
import com.meldiq.android.data.billing.PlayProducts
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * Settings › Meldiq Mojo (docs/MOJO_ANDROID.md): the plan this account has and where it is billed, the plans with
 * Google Play's own prices, Meldiq Spark, gifts, and why Meldiq charges at all. Every purchase opens Google Play's sheet
 * and counts once the server has verified it; a plan bought on the website is shown, never sold again here.
 */
@Composable
fun MojoScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val mojo = container.mojo
    val state by mojo.state.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var giftOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { mojo.refresh() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { mojo.reconcile() } }

    fun buy(purchase: MojoPurchase) {
        val activity = ctx.findActivity() ?: return
        scope.launch { mojo.prepare(purchase)?.let { mojo.launch(activity, it) } }
    }

    fun openPlay(productId: String?) {
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PlayProducts.manageUrl(ctx.packageName, productId)))) }
    }

    val catalog = state.catalog
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 48.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item { GriipTopBar(stringResource(R.string.mojo_title), onBack = { nav.popBackStack() }) }
        item(key = "hero") { MojoHero(state.entitlements, catalog) }
        state.notice?.let { n -> item(key = "notice") { NoticeBanner(n) { mojo.clearNotice() } } }
        when {
            catalog == null && state.unavailable -> item(key = "unavailable") {
                Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusBanner(stringResource(R.string.mojo_unavailable), BannerKind.Info)
                    PillButton(stringResource(R.string.mojo_retry), { scope.launch { mojo.refresh() } }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 48.dp)
                }
            }
            catalog == null -> item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Griip.colors.primary)
                }
            }
            else -> {
                item(key = "status") { PlanStatusCard(state.entitlements, onManage = { openPlay(it) }, onRestore = { scope.launch { mojo.reconcile() } }) }
                if (state.offers.isEmpty()) item(key = "play-missing") {
                    StatusBanner(stringResource(R.string.mojo_play_missing), BannerKind.Info, Modifier.padding(horizontal = Space.gutter))
                }
                item(key = "plans") {
                    PlanCards(catalog, state.entitlements, state.offers, state.busy, onBuy = ::buy, onManage = { openPlay(it) })
                }
                item(key = "benefits") { BenefitCards(catalog) }
                item(key = "compare") { CompareTable(catalog, state.offers) }
                item(key = "sparks") {
                    SparkSection(catalog, state.entitlements, state.offers, state.busy, state.me, onBuy = ::buy)
                }
                state.me?.let { me ->
                    item(key = "badge") { BadgeCard(me) }
                    item(key = "gifts") { GiftsCard(me, catalog, state.entitlements) }
                }
                item(key = "gift") { GiftCard(enabled = state.offers.keys.any { it.startsWith("gift_") }) { giftOpen = true } }
            }
        }
        item(key = "why") { WhyCard() }
        item(key = "fine") {
            Text(
                stringResource(R.string.mojo_fine_print), style = Griip.type.caption, color = Griip.colors.textTertiary,
                modifier = Modifier.padding(horizontal = Space.gutter),
            )
        }
    }
    if (giftOpen && catalog != null) {
        GiftSheet(catalog, state.offers, me = container.session.session?.userId, busy = state.busy != null, onBuy = { buy(it); giftOpen = false }, onDismiss = { giftOpen = false })
    }
}

@Composable
private fun NoticeBanner(notice: MojoNotice, onDismiss: () -> Unit) {
    val (text, kind) = when (notice) {
        is MojoNotice.Confirmed -> stringResource(
            if (notice.productId.startsWith("gift_")) R.string.mojo_notice_gift_sent else R.string.mojo_notice_confirmed,
        ) to BannerKind.Success
        MojoNotice.Pending -> stringResource(R.string.mojo_notice_pending) to BannerKind.Info
        MojoNotice.Cancelled -> stringResource(R.string.mojo_notice_cancelled) to BannerKind.Info
        MojoNotice.NotConfirmedYet -> stringResource(R.string.mojo_notice_unconfirmed) to BannerKind.Warning
        MojoNotice.OtherAccount -> stringResource(R.string.mojo_notice_other_account) to BannerKind.Warning
        MojoNotice.Rejected -> stringResource(R.string.mojo_notice_rejected) to BannerKind.Error
        is MojoNotice.Failed -> stringResource(errorText(notice.error)) to BannerKind.Error
    }
    StatusBanner(text, kind, Modifier.padding(horizontal = Space.gutter), action = stringResource(R.string.rq_dismiss), onAction = onDismiss)
}

private fun errorText(e: com.meldiq.android.data.billing.PlayError): Int = when (e) {
    com.meldiq.android.data.billing.PlayError.UNAVAILABLE -> R.string.mojo_err_unavailable
    com.meldiq.android.data.billing.PlayError.NETWORK -> R.string.mojo_err_network
    com.meldiq.android.data.billing.PlayError.ALREADY_OWNED -> R.string.mojo_err_owned
    com.meldiq.android.data.billing.PlayError.ITEM_UNAVAILABLE -> R.string.mojo_err_item
    com.meldiq.android.data.billing.PlayError.NOT_SET_UP -> R.string.mojo_err_setup
    com.meldiq.android.data.billing.PlayError.OTHER -> R.string.mojo_err_other
}

/** The activity hosting [this] context (Google Play's sheet opens over an activity). */
internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** Whether a plan key is one of the paid plans. */
internal fun isPaid(key: String): Boolean = MojoPlans.rank(key) > 0
