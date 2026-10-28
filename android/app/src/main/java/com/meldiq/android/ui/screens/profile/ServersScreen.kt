package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.BuildConfig
import com.meldiq.android.GriipApp
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.repo.ServerAddress
import com.meldiq.android.data.repo.ServerCompat
import com.meldiq.android.data.repo.SessionRepository
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The result of checking a server address before it's saved or added. */
data class ServerCheck(val ok: Boolean, val message: String, val url: String?, val cleartext: Boolean = false)

/** Normalises the address, reads `/v1/server-info` and checks this app can use the server. No account is touched. */
suspend fun checkServer(session: SessionRepository, input: String): ServerCheck {
    val parsed = ServerAddress.parse(input, allowCleartext = BuildConfig.DEBUG).getOrElse { return ServerCheck(false, it.message ?: "Invalid address", null) }
    val info = try {
        session.serverInfo(parsed.url)
    } catch (e: ApiException) {
        val why = when {
            e.code == "decode" || e.status == 404 -> "That address answered, but not like a Meldiq server."
            else -> e.message
        }
        return ServerCheck(false, why, parsed.url, parsed.cleartext)
    } catch (e: Exception) {
        return ServerCheck(false, "Couldn't check that server.", parsed.url, parsed.cleartext)
    }
    (ServerCompat.check(info) as? ServerCompat.Verdict.Unsupported)?.let { return ServerCheck(false, it.reason, parsed.url, parsed.cleartext) }
    val name = info.instanceName ?: hostOf(parsed.url)
    val facts = listOfNotNull(
        "server ${info.version}",
        if (info.calling) "calls available" else "calls not set up",
        when (info.registration) {
            "open" -> "anyone can sign up"
            "invite" -> "sign-up needs an invitation"
            else -> null
        },
    )
    return ServerCheck(true, "$name · ${facts.joinToString(" · ")}", parsed.url, parsed.cleartext)
}

fun hostOf(url: String): String = url.substringAfter("://").substringBefore('/')

/**
 * Servers on this phone. Each has its own account, keys and messages; switching closes one and opens the
 * other without moving or merging anything. Only the active server is connected.
 */
@Composable
fun ServersScreen(nav: NavHostController) {
    val app = LocalContext.current.applicationContext as GriipApp
    val container = LocalContainer.current
    val c = Griip.colors
    val call by container.calls.state.collectAsStateWithLifecycle()
    val registry by app.profiles.state.collectAsStateWithLifecycle()
    var refresh by remember { mutableIntStateOf(0) }
    var rows by remember { mutableStateOf<List<GriipApp.ProfileSummary>>(emptyList()) }
    LaunchedEffect(registry, refresh) { rows = withContext(Dispatchers.IO) { app.profileSummaries() } }
    var adding by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<GriipApp.ProfileSummary?>(null) }
    var confirmSwitch by remember { mutableStateOf<GriipApp.ProfileSummary?>(null) }
    var confirmRemove by remember { mutableStateOf<GriipApp.ProfileSummary?>(null) }
    val inCall = call.phase != CallPhase.Idle

    Column(Modifier.fillMaxSize()) {
        GriipTopBar("Servers", onBack = { nav.popBackStack() })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                Text(
                    "Each server keeps its own account, security keys and messages on this phone. Switching doesn't move, merge or delete anything. " +
                        "Only the active server is connected, so messages and calls from the others arrive when you switch back.",
                    style = Griip.type.bodySmall, color = c.textSecondary,
                    modifier = Modifier.padding(horizontal = Space.gutter, vertical = 8.dp),
                )
            }
            if (inCall) item { StatusBanner("Finish the call before switching servers.", BannerKind.Info, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
            items(rows, key = { it.id }) { p ->
                ListCard(
                    hostOf(p.serverUrl), Modifier.padding(horizontal = 8.dp),
                    subtitle = (p.username?.let { "@$it" } ?: "Not signed in") + if (p.original) " · first account on this phone" else "",
                    leading = { IconTile(Icons.Outlined.Dns, c.primaryDeep, c.primarySoft, size = 40.dp) },
                    trailing = { if (p.active) TagPill("Active", c.success, c.successSoft) },
                    onClick = { if (!p.active) selected = p },
                )
            }
            item {
                Spacer(Modifier.height(12.dp))
                PillButton(
                    "Add a server", { adding = true }, Modifier.fillMaxWidth().padding(horizontal = Space.gutter),
                    tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, enabled = !inCall, height = 50.dp,
                )
            }
        }
    }

    selected?.let { p ->
        GlassSheet({ selected = null }, title = hostOf(p.serverUrl)) {
            Text(p.serverUrl, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
            MenuRow(
                Icons.Outlined.SwapHoriz, "Switch to this server",
                subtitle = if (inCall) "Finish the call first" else p.username?.let { "Opens @$it" } ?: "Sign in or create an account there",
                onClick = if (inCall) null else ({ selected = null; confirmSwitch = p }), trailing = null,
            )
            if (!p.original) {
                MenuRow(
                    Icons.Outlined.DeleteOutline, "Remove from this phone", subtitle = "Deletes this server's messages and keys on this phone",
                    tint = c.danger, tintBg = c.dangerSoft, onClick = { selected = null; confirmRemove = p }, trailing = null,
                )
            }
        }
    }
    confirmSwitch?.let { p ->
        ConfirmDialog(
            "Switch to ${hostOf(p.serverUrl)}?",
            "You'll stay signed in here too. This server disconnects until you switch back.",
            "Switch", { confirmSwitch = null; app.switchProfile(p.id) }, { confirmSwitch = null },
        )
    }
    confirmRemove?.let { p ->
        ConfirmDialog(
            "Remove ${hostOf(p.serverUrl)}?",
            (p.username?.let { "Messages and security keys for @$it are deleted from this phone. The account itself isn't deleted: you can sign in again with your recovery key or from another device. " } ?: "") +
                "This can't be undone.",
            "Remove", { confirmRemove = null; app.removeProfile(p.id); refresh++ }, { confirmRemove = null }, destructive = true,
        )
    }
    if (adding) AddServerSheet(existing = rows, onDismiss = { adding = false }, onSwitchExisting = { adding = false; confirmSwitch = it }) { url ->
        adding = false
        app.addProfile(url)
    }
}

@Composable
private fun AddServerSheet(
    existing: List<GriipApp.ProfileSummary>,
    onDismiss: () -> Unit,
    onSwitchExisting: (GriipApp.ProfileSummary) -> Unit,
    onAdd: (String) -> Unit,
) {
    val c = Griip.colors
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var check by remember { mutableStateOf<ServerCheck?>(null) }
    var busy by remember { mutableStateOf(false) }
    val checked = check?.takeIf { it.ok }
    val duplicate = checked?.url?.let { u -> existing.firstOrNull { ServerAddress.same(it.serverUrl, u) } }
    GlassSheet(onDismiss, title = "Add a server") {
        Text(
            "Use a server run by your organisation or community. You'll create a new account there, or sign in with that server's recovery key. " +
                "Your current account stays on this phone and keeps its keys.",
            style = Griip.type.bodySmall, color = c.textSecondary,
        )
        Spacer(Modifier.height(14.dp))
        GriipTextField(
            url, { url = it.trim(); check = null }, "Server address", placeholder = "https://msg.example.org", leadingIcon = Icons.Outlined.Dns,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        check?.let {
            Spacer(Modifier.height(10.dp))
            StatusBanner(it.message, if (it.ok) BannerKind.Success else BannerKind.Error)
            if (it.ok && it.cleartext) {
                Spacer(Modifier.height(8.dp))
                StatusBanner("Unencrypted connection (http): use it only for local testing. Messages, files and sign-in tokens travel in the clear.", BannerKind.Warning, icon = Icons.Rounded.GppMaybe)
            }
        }
        if (duplicate != null) {
            Spacer(Modifier.height(8.dp))
            StatusBanner(
                if (duplicate.active) "You're already using this server." else "This server is already on this phone.", BannerKind.Info,
                action = if (duplicate.active) null else "Switch", onAction = if (duplicate.active) null else ({ onSwitchExisting(duplicate) }),
            )
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PillButton("Check", {
                busy = true
                scope.launch {
                    check = checkServer(container.session, url)
                    busy = false
                }
            }, Modifier.weight(1f), tone = ButtonTone.Glass, loading = busy, enabled = url.isNotBlank(), height = 50.dp)
            PillButton("Add and switch", { checked?.url?.let(onAdd) }, Modifier.weight(1f), enabled = checked != null && duplicate == null && !busy, height = 50.dp)
        }
    }
}
