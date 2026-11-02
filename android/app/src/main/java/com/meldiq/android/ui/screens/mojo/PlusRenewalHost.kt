package com.meldiq.android.ui.screens.mojo

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.data.billing.RenewalNotice
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

@Composable
internal fun PlusRenewalHost(nav: NavHostController, safe: Boolean) {
    val container = LocalContainer.current
    val state by container.mojo.state.collectAsStateWithLifecycle()
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsStateWithLifecycle()
    var notice by remember { mutableStateOf<RenewalNotice?>(null) }
    var claimed by remember { mutableStateOf(false) }
    val currentSafe by rememberUpdatedState(safe && lifecycle == Lifecycle.State.RESUMED && state.me?.plan == "plus" && state.busy == null)
    LaunchedEffect(Unit) {
        while(true) {
            delay(5_000)
            if(!currentSafe) { notice = null; continue }
            if(claimed && notice == null) continue
            try { val n = container.plusPromotions.renewal(!claimed); if(n != null) claimed = true; if(currentSafe) notice = n }
            catch(e: CancellationException) { throw e } catch(_: Exception) { notice = null }
        }
    }
    LaunchedEffect(notice?.expiresAt) { notice?.let { delay((it.expiresAt-System.currentTimeMillis()).coerceAtLeast(0)); notice = null } }
    val n = notice ?: return
    if(!currentSafe) return
    Card(Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if(n.autoRenew) "Your Plus renewal is coming up" else "Your Plus time ends soon", style = Griip.type.title)
            val date = DateFormat.getDateInstance().format(Date(n.endsAt))
            Text(if(n.autoRenew) "Your existing agreement renews on $date. You don’t need to purchase again. Review the charge and cancellation options with your billing provider." else "Your current Plus access ends on $date. Review your renewal options in Meldiq Plus.")
            TextButton(onClick = { notice = null; nav.navigate(Routes.MOJO) }) { Text("Manage Plus") }
            TextButton(onClick = { notice = null }) { Text("Dismiss") }
        }
    }
}
