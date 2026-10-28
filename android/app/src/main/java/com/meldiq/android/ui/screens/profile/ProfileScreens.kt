package com.meldiq.android.ui.screens.profile

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CallMade
import androidx.compose.material.icons.outlined.CallReceived
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PhoneMissed
import androidx.compose.material.icons.outlined.PhonelinkSetup
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SyncAlt
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.BuildConfig
import com.meldiq.android.GriipApp
import com.meldiq.android.crypto.Fingerprint
import com.meldiq.android.crypto.b64
import com.meldiq.android.crypto.unb64
import com.meldiq.android.data.api.DevicesRes
import com.meldiq.android.data.api.MyDeviceDto
import com.meldiq.android.data.api.OkRes
import com.meldiq.android.data.api.PairingRequestInfo
import com.meldiq.android.data.api.UpdateMeReq
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.api.UserRes
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.data.repo.GlobalAddress
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.Phone
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.IconTile
import com.meldiq.android.ui.components.LargeHeader
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.SegmentedPills
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.screens.onboarding.ServerSheet
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.ThemeMode
import kotlinx.coroutines.launch

/** The Settings tab: profile, then account, appearance, notifications, privacy, calls, server and about. */
// ───────────────────────────── Devices ─────────────────────────────

@Composable
fun DevicesScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var devices by remember { mutableStateOf<List<MyDeviceDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var revoke by remember { mutableStateOf<MyDeviceDto?>(null) }
    var linking by remember { mutableStateOf(false) }
    LaunchedEffect(reload) { runCatching { container.api.get<DevicesRes>("/v1/devices") }.onSuccess { devices = it.devices }.onFailure { error = it.friendly() } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Devices", onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter)) } }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp)) {
                Row {
                    IconTile(Icons.Outlined.PhonelinkSetup, c.primary, c.primarySoft, size = 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Link a new device", style = Griip.type.titleSmall, color = c.textPrimary)
                        Text("On the new phone choose “Link device”, then enter the code it shows here. Its history starts empty — messages are stored per device.", style = Griip.type.bodySmall, color = c.textSecondary)
                    }
                }
                Spacer(Modifier.height(12.dp))
                PillButton("Enter link code", { linking = true }, Modifier.fillMaxWidth(), height = 48.dp)
            }
        }
        item { SectionHeader("Signed-in devices", Modifier.padding(top = 10.dp, bottom = 6.dp)) }
        items(devices.orEmpty(), key = { it.id }) { d ->
            ListCard(
                d.name, Modifier.padding(horizontal = 8.dp, vertical = 1.dp),
                subtitle = (if (d.revokedAt != null) "Removed ${TimeFmt.listStamp(d.revokedAt)}" else "Added ${TimeFmt.listStamp(d.createdAt)} · last seen ${TimeFmt.relative(d.lastSeenAt)}") +
                    "\nKey ${Fingerprint.of(d.signingKey.unb64()).take(17)}…",
                leading = { IconTile(Icons.Outlined.Devices, if (d.revokedAt == null) c.primary else c.textTertiary, if (d.revokedAt == null) c.primarySoft else c.surfaceVariant, size = 42.dp) },
                trailing = {
                    when {
                        d.current -> TagPill("This device", c.primaryDeep, c.primarySoft)
                        d.revokedAt == null -> PillButton("Remove", { revoke = d }, tone = ButtonTone.Glass, showKnob = false, height = 36.dp)
                    }
                },
            )
        }
    }
    revoke?.let { d ->
        ConfirmDialog("Remove ${d.name}?", "It is signed out immediately and stops receiving new messages. Its local history isn't erased remotely.", "Remove",
            onConfirm = { revoke = null; scope.launch { runCatching { container.api.delete<OkRes>("/v1/devices/${d.id}") }.onFailure { error = it.friendly() }; reload++ } },
            onDismiss = { revoke = null }, destructive = true)
    }
    if (linking) ApproveLinkSheet({ linking = false }) { reload++ }
}

@Composable
private fun ApproveLinkSheet(onDismiss: () -> Unit, onDone: () -> Unit) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var info by remember { mutableStateOf<PairingRequestInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    GlassSheet(onDismiss, title = "Approve new device") {
        if (info == null) {
            GriipTextField(code, { code = it.uppercase().take(14) }, "Link code from the new device", placeholder = "ABCDE FGHJK", keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters))
            error?.let { Spacer(Modifier.height(10.dp)); StatusBanner(it, BannerKind.Error) }
            Spacer(Modifier.height(16.dp))
            PillButton("Look up", {
                busy = true
                scope.launch { runCatching { container.session.lookupPairing(code) }.onSuccess { info = it }.onFailure { error = it.friendly() }; busy = false }
            }, Modifier.fillMaxWidth(), enabled = code.filter { it.isLetterOrDigit() }.length >= 10, loading = busy, height = 50.dp)
        } else {
            val i = info!!
            StatusBanner("Only approve a device you're holding right now. It will get full access to your account and receive new messages.", BannerKind.Warning, icon = Icons.Rounded.Warning)
            Spacer(Modifier.height(12.dp))
            Text(i.deviceName, style = Griip.type.title, color = c.textPrimary)
            Text("Requested ${TimeFmt.relative(i.createdAt)}", style = Griip.type.caption, color = c.textTertiary)
            Spacer(Modifier.height(8.dp))
            Text("Device key: ${Fingerprint.of(i.signingKey.unb64())}", style = Griip.type.bodySmall.copy(fontFamily = FontFamily.Monospace), color = c.textSecondary)
            error?.let { Spacer(Modifier.height(10.dp)); StatusBanner(it, BannerKind.Error) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton("Cancel", onDismiss, Modifier.weight(1f), tone = ButtonTone.Glass, showKnob = false, height = 50.dp)
                PillButton("Approve", {
                    busy = true
                    scope.launch {
                        runCatching { container.session.approvePairing(code, i) }.onSuccess { onDone(); onDismiss() }.onFailure { error = it.friendly() }
                        busy = false
                    }
                }, Modifier.weight(1f), loading = busy, height = 50.dp)
            }
        }
    }
}

// ───────────────────────────── Security ─────────────────────────────

@Composable
fun SecurityScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val keys = container.session.keys
    var showKey by remember { mutableStateOf(false) }
    var revealConfirm by remember { mutableStateOf(false) }
    var eraseConfirm by remember { mutableStateOf(false) }
    var unconfirmedRevoke by remember { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Security & recovery", onBack = { nav.popBackStack() }) }
        // Orbit 2.0: the email-and-password account (shown only on profiles that have one).
        item { com.meldiq.android.ui.screens.account.AccountSecurityCard(onEditProfile = { nav.navigate(Routes.EDIT_PROFILE) }) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconTile(Icons.Outlined.Key, c.lavender, c.lavenderSoft, size = 42.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Recovery key", style = Griip.type.titleSmall, color = c.textPrimary)
                        Text("Lets you sign in on a new phone if you lose this one. Anyone with it can impersonate you — store it offline.", style = Griip.type.bodySmall, color = c.textSecondary)
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (showKey) {
                    val code = container.session.recoveryKey() ?: ""
                    Text(code, style = Griip.type.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        PillButton("Copy", { scope.launch { clipboard.setClipEntry(ClipData.newPlainText("recovery", code).toClipEntry()) } }, Modifier.weight(1f), tone = ButtonTone.Glass, showKnob = false, height = 46.dp)
                        PillButton("Hide", { showKey = false }, Modifier.weight(1f), tone = ButtonTone.Glass, showKnob = false, height = 46.dp)
                    }
                } else PillButton("Show recovery key", { revealConfirm = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 48.dp)
            }
        }
        item { SectionHeader("How your data is protected", Modifier.padding(top = 12.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) {
                MenuRow(Icons.Outlined.Shield, "Messages", subtitle = "Encrypted on this phone (HPKE X25519 + AES-256-GCM, Ed25519 signatures) before upload. No forward secrecy yet — see SECURITY.md.", trailing = null)
                MenuRow(Icons.Outlined.ChatBubbleOutline, "History", subtitle = "On your devices in an encrypted database (SQLCipher), and, where your server keeps history, encrypted on the server with a key only your devices and recovery key have (Data & Storage). Relayed copies are deleted once delivered, or after 7 days.", trailing = null)
                MenuRow(Icons.Outlined.Videocam, "Calls", subtitle = "Media is encrypted with a per-call key sent through your chat, which Meldiq's servers keep. The call screen shows the live status.", trailing = null)
                MenuRow(Icons.Outlined.SyncAlt, "What the server can see", subtitle = "Your messages and files, who talks to whom and when, community structure, channel names and your IP address.", trailing = null)
            }
        }
        item {
            PillButton("Sign out & erase this device", { eraseConfirm = true }, Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 20.dp), tone = ButtonTone.Danger, showKnob = false, leadingIcon = Icons.AutoMirrored.Outlined.Logout, height = 50.dp)
        }
    }
    if (revealConfirm) ConfirmDialog("Show recovery key?", "Make sure nobody can see your screen.", "Show", onConfirm = { revealConfirm = false; showKey = true }, onDismiss = { revealConfirm = false })
    if (eraseConfirm) ConfirmDialog(
        "Erase this device?", "Deletes this account's keys, message history and files from this phone. Accounts on other servers on this phone aren't affected. Without your recovery key or another linked device, you can't get back into this account.", "Erase",
        onConfirm = {
            eraseConfirm = false
            scope.launch {
                // Revoke this device first (T1.9): the server drops its sessions and queue, and contacts stop
                // encrypting to keys that are about to be deleted. Erasing never pretends this happened.
                val myDevice = container.session.session?.deviceId
                val revoked = runCatching { container.api.delete<OkRes>("/v1/devices/$myDevice") }
                if (myDevice != null && revoked.isSuccess) (ctx.applicationContext as GriipApp).eraseEverything()
                else unconfirmedRevoke = revoked.exceptionOrNull()?.friendly() ?: "not signed in"
            }
        },
        onDismiss = { eraseConfirm = false }, destructive = true,
    )
    unconfirmedRevoke?.let { reason ->
        ConfirmDialog(
            "Couldn't remove this device from your account",
            "The server didn't confirm it ($reason). If you erase now, contacts may keep encrypting messages to this phone's keys until you remove it from another device under Profile → Devices.",
            "Erase anyway",
            onConfirm = { unconfirmedRevoke = null; (ctx.applicationContext as GriipApp).eraseEverything() },
            onDismiss = { unconfirmedRevoke = null }, destructive = true,
        )
    }
}

// ───────────────────────────── Settings ─────────────────────────────

// The contact profile is ProfileCard.kt (UserProfileScreen) since the floating redesign (2026-10-28).

@Suppress("unused")
private fun keyB64(k: ByteArray) = k.b64()
