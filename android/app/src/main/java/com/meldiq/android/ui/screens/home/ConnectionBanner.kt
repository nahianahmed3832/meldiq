package com.meldiq.android.ui.screens.home

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.meldiq.android.data.api.ConnState
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.StatusBanner

/** How long the connection must stay down before the banner shows (as Meldiq Web v4): brief reconnects stay quiet. */
private const val BANNER_DELAY_MS = 1500L

/** Relay connection state for list and conversation screens. Nothing is shown while connected, nor in the first 1.5 s down. */
@Composable
fun ConnectionBanner(state: ConnState, modifier: Modifier = Modifier, onRetry: () -> Unit) {
    val down = state == ConnState.Offline || state == ConnState.Connecting
    var shown by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(down) {
        if (!down) { shown = false; return@LaunchedEffect }
        kotlinx.coroutines.delay(BANNER_DELAY_MS)
        shown = true
    }
    if (!shown) return
    when (state) {
        ConnState.Offline -> StatusBanner("You're offline. Messages will send when you reconnect.", BannerKind.Warning, modifier, icon = Icons.Outlined.CloudOff)
        ConnState.Connecting -> StatusBanner("Connecting…", BannerKind.Info, modifier, icon = Icons.Outlined.Sync, action = "Retry", onAction = onRetry)
        else -> {}
    }
}
