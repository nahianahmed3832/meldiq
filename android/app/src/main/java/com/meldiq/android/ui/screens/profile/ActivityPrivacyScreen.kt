package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.QueryStats
import androidx.compose.material.icons.outlined.SignalWifiStatusbarConnectedNoInternet4
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.R
import com.meldiq.android.activity.GameDetector
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/**
 * Settings › Privacy › Activity privacy (API 0.56.0, docs/ACTIVITY_STATUS.md): "Share what I'm playing", off until the
 * person turns it on after the disclosure, Usage access, and games to never show. Google Play requires the disclosure
 * to appear before the person is sent to grant Usage access.
 */
@Composable
fun ActivityPrivacyScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val context = LocalContext.current
    val prefs by container.activitySettings.state.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val front by container.activityReporter.front.collectAsStateWithLifecycle()
    val detector = remember { GameDetector(context.applicationContext) }
    // Usage access is granted in system settings: read again whenever this screen comes back.
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    val hasAccess = remember(lifecycle) { lifecycle.isAtLeast(Lifecycle.State.RESUMED) && detector.hasUsageAccess() }
    var serverHas by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { serverHas = container.features.has(ServerFeatures.ACTIVITY_STATUS) }
    var disclosing by rememberSaveable { mutableStateOf(false) }
    val openAccess = { runCatching { context.startActivity(GameDetector.usageAccessIntent(context)) } }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.act_title), onBack = { nav.popBackStack() }) }
        if (serverHas == false) item {
            StatusBanner(stringResource(R.string.act_server_missing), BannerKind.Info, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp))
        }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(4.dp)) {
                MenuRow(
                    Icons.Outlined.SportsEsports, stringResource(R.string.act_share), subtitle = stringResource(R.string.act_share_sub),
                    trailing = { GriipSwitch(prefs.share, { on -> if (on) disclosing = true else container.activitySettings.setShare(false) }) },
                )
            }
        }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.Info, stringResource(R.string.act_explain), trailing = null)
            }
        }
        if (prefs.share) {
            item {
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(4.dp)) {
                    if (hasAccess) {
                        MenuRow(Icons.Outlined.QueryStats, stringResource(R.string.act_access_on), subtitle = stringResource(R.string.act_access_on_sub), onClick = { openAccess() })
                        MenuRow(
                            Icons.Outlined.SportsEsports, stringResource(R.string.act_now),
                            subtitle = front?.name ?: stringResource(R.string.act_now_none), trailing = null,
                        )
                    } else {
                        MenuRow(
                            Icons.Outlined.QueryStats, stringResource(R.string.act_access_off), subtitle = stringResource(R.string.act_access_off_sub),
                            tint = Griip.colors.warning, onClick = { openAccess() },
                            trailing = { TextButton(onClick = { openAccess() }) { Text(stringResource(R.string.act_access_open), style = Griip.type.button, color = Griip.colors.primary) } },
                        )
                    }
                    if (!settings.backgroundConnection) {
                        MenuRow(
                            Icons.Outlined.SignalWifiStatusbarConnectedNoInternet4, stringResource(R.string.act_background),
                            onClick = { nav.navigate(Routes.NOTIFICATION_SETTINGS) },
                        )
                    }
                }
            }
        }
        item { SectionHeader(stringResource(R.string.act_games), Modifier.padding(top = 14.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                if (prefs.seen.isEmpty()) {
                    MenuRow(Icons.Outlined.VisibilityOff, stringResource(R.string.act_games_empty), trailing = null)
                } else {
                    prefs.seen.forEach { (packageId, name) ->
                        val shown = packageId !in prefs.hidden
                        MenuRow(
                            Icons.Outlined.SportsEsports, name,
                            subtitle = stringResource(if (shown) R.string.act_game_shown else R.string.act_game_hidden),
                            trailing = { GriipSwitch(shown, { on -> container.activitySettings.setHidden(packageId, !on) }) },
                        )
                    }
                }
            }
        }
    }

    // The prominent disclosure (Google Play's User Data policy): before turning it on and before Usage access.
    if (disclosing) {
        val c = Griip.colors
        AlertDialog(
            onDismissRequest = { disclosing = false },
            containerColor = c.surface,
            shape = Shapes.hero,
            title = { Text(stringResource(R.string.act_disclosure_title), style = Griip.type.title, color = c.textPrimary) },
            text = { Text(stringResource(R.string.act_disclosure_body), style = Griip.type.bodySmall, color = c.textSecondary) },
            confirmButton = {
                TextButton(onClick = {
                    disclosing = false
                    container.activitySettings.setShare(true)
                    if (!detector.hasUsageAccess()) openAccess()
                }) { Text(stringResource(R.string.act_disclosure_agree), style = Griip.type.button, color = c.primary) }
            },
            dismissButton = {
                TextButton(onClick = { disclosing = false }) { Text(stringResource(R.string.act_disclosure_cancel), style = Griip.type.button, color = c.textSecondary) }
            },
        )
    }
}

/** The row on Privacy that opens Activity privacy. */
@Composable
fun ActivityPrivacyRow(nav: NavHostController) {
    val prefs by LocalContainer.current.activitySettings.state.collectAsStateWithLifecycle()
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
        MenuRow(
            Icons.Outlined.SportsEsports, stringResource(R.string.act_title),
            subtitle = stringResource(if (prefs.share) R.string.act_row_on else R.string.act_row_off),
            onClick = { nav.navigate(Routes.ACTIVITY_PRIVACY) },
        )
    }
}
