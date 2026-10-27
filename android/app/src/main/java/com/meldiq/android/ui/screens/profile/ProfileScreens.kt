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
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), shape = Shapes.hero) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconTile(Icons.Outlined.VerifiedUser, c.primary, c.primarySoft, size = 46.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Your safety number", style = Griip.type.titleSmall, color = c.textPrimary)
                        Text("Compare in person to verify your identity key", style = Griip.type.caption, color = c.textTertiary)
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(keys?.let { Fingerprint.of(it.identityPublic) } ?: "—", style = Griip.type.title.copy(fontFamily = FontFamily.Monospace, letterSpacing = 1.sp), color = c.primaryDeep, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
            }
        }
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
                MenuRow(Icons.Outlined.Videocam, "Calls", subtitle = "Media is end-to-end encrypted with a per-call key sent through your encrypted messages. The call screen shows the live status.", trailing = null)
                MenuRow(Icons.Outlined.SyncAlt, "What the server can see", subtitle = "Who talks to whom and when, message sizes, org structure, channel names and your IP address.", trailing = null)
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

/** Older pushed route to the settings; same sections as the Settings tab. */
// ───────────────────────────── Contact profile ─────────────────────────────

@Composable
fun UserProfileScreen(nav: NavHostController, userId: String) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf<UserDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val local by container.db.users().observe(userId).collectAsStateWithLifecycle(null)
    val myKey = container.session.keys?.identityPublic
    LaunchedEffect(userId) { runCatching { container.users.fetch(userId) }.onSuccess { user = it }.onFailure { error = it.friendly() } }
    var blocked by remember { mutableStateOf<Boolean?>(null) }
    var reporting by remember { mutableStateOf(false) }
    var reportsAvailable by remember { mutableStateOf(false) }
    // Batch B4b: inviting this person to one of your communities.
    var inviteLinks by remember { mutableStateOf(false) }
    var inviting by remember { mutableStateOf(false) }
    // Batch B6: the connection button.
    var connectionsAvailable by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        reportsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.REPORTS) == true
        inviteLinks = container.features.has(com.meldiq.android.data.repo.ServerFeatures.INVITE_LINKS) == true
        connectionsAvailable = container.features.has(com.meldiq.android.data.repo.ServerFeatures.CONNECTIONS) == true
    }
    LaunchedEffect(userId) { blocked = runCatching { userId in container.federation.blocked() }.getOrNull() }
    val u = user
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar("Profile", onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter)) } }
        if (u != null) {
            item {
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), shape = Shapes.hero) {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        // API 0.45.0–0.46.0, as Meldiq Web's profile card: the banner with its effect, the animated and
                        // framed avatar, the styled name with the tag they wear.
                        val look = com.meldiq.android.data.model.PersonLook(u.avatarMedia, u.profileStyle, u.tag)
                        if (u.profileBanner != null || u.profileStyle?.accent != null || u.profileStyle?.effect != null) {
                            com.meldiq.android.ui.components.ProfileBannerView(
                                u.id, u.profileBanner, u.profileStyle,
                                Modifier.fillMaxWidth().height(com.meldiq.android.ui.components.ProfileBannerHeight).clip(Shapes.small),
                            )
                            Spacer(Modifier.height(10.dp))
                        }
                        com.meldiq.android.ui.components.LookAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, look, size = 84.dp, online = u.online, presence = u.presence)
                        Spacer(Modifier.height(10.dp))
                        com.meldiq.android.ui.components.StyledName(u.displayName, look, Griip.type.headline, c.textPrimary)
                        if ("bug-hunter" in u.badges.orEmpty()) {
                            Spacer(Modifier.height(4.dp))
                            com.meldiq.android.ui.components.TagPill(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_badge_bug_hunter), c.lavender, c.lavenderSoft, icon = androidx.compose.material.icons.Icons.Outlined.BugReport)
                        }
                        Text("@${u.username}" + (u.pronouns?.let { " · $it" } ?: ""), style = Griip.type.bodySmall, color = c.textSecondary)
                        val fullName = listOfNotNull(u.firstName, u.lastName).joinToString(" ")
                        if (fullName.isNotBlank() && fullName != u.displayName) Text(fullName, style = Griip.type.bodySmall, color = c.textSecondary)
                        val server = if (GlobalAddress.isRemote(u.username, u.homeServer)) GlobalAddress.serverOf(u.username) else null
                        if (server != null) {
                            // Presence isn't shared between servers.
                            Text("On another server: $server", style = Griip.type.caption, color = c.textTertiary)
                        } else {
                            // Batch B6b: idle and do not disturb show as such.
                            val shown = when {
                                u.online != true -> "Last seen ${TimeFmt.relative(u.lastSeenAt)}"
                                u.presence == com.meldiq.android.data.model.PresenceRules.IDLE -> androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b6b_idle)
                                u.presence == com.meldiq.android.data.model.PresenceRules.DND -> androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b6b_dnd)
                                else -> "Online"
                            }
                            Text(shown, style = Griip.type.caption, color = if (u.online == true) c.success else c.textTertiary)
                        }
                        u.statusText?.let { Spacer(Modifier.height(6.dp)); Text(it, style = Griip.type.bodySmall, color = c.textSecondary) }
                        Spacer(Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PillButton("Message", {
                                scope.launch { runCatching { container.conversations.openDm(u.id) }.onSuccess { nav.navigate(Routes.conversation(it.id)) }.onFailure { error = it.friendly() } }
                            }, Modifier.weight(1f), height = 48.dp)
                            if (connectionsAvailable && !GlobalAddress.isRemote(u.username, u.homeServer)) {
                                com.meldiq.android.ui.screens.contacts.ConnectionButton(u.id, Modifier.weight(1f)) { error = it }
                            }
                            if (inviteLinks && !GlobalAddress.isRemote(u.username, u.homeServer)) PillButton(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.pi_invite), { inviting = true }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 48.dp)
                        }
                    }
                }
            }
            // API 0.46.0: About me and up to five links, under the bio's privacy setting.
            if (!u.aboutMe.isNullOrBlank() || !u.links.isNullOrEmpty()) item {
                AboutCard(u.aboutMe, u.links.orEmpty())
            }
            // What they chose to show this account (the server leaves out everything else).
            val birthday = com.meldiq.android.data.model.ProfileRules.Birthday.parse(u.birthday)
            if (birthday != null || u.phone != null) item {
                val ctx = androidx.compose.ui.platform.LocalContext.current
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), contentPadding = PaddingValues(4.dp)) {
                    birthday?.let { MenuRow(Icons.Outlined.Cake, it.display(), subtitle = "Birthday", trailing = null) }
                    u.phone?.let { ph ->
                        MenuRow(
                            Icons.Outlined.Phone, ph, subtitle = "Phone · not verified by Meldiq · tap to dial",
                            onClick = { runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL, android.net.Uri.parse("tel:$ph"))) } },
                        )
                    }
                }
            }
            item {
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconTile(if (local?.identityChanged == true) Icons.Rounded.GppMaybe else Icons.Outlined.VerifiedUser, if (local?.identityChanged == true) c.warning else c.primary, if (local?.identityChanged == true) c.warningSoft else c.primarySoft, size = 42.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Safety number", style = Griip.type.titleSmall, color = c.textPrimary)
                            Text(
                                when {
                                    local?.identityChanged == true -> "Their identity key changed since you first talked. Verify before trusting."
                                    local?.verified == true -> "You marked this identity as verified."
                                    else -> "Compare with ${u.displayName}'s screen in person."
                                },
                                style = Griip.type.caption, color = c.textTertiary,
                            )
                        }
                        if (local?.verified == true) TagPill("Verified", c.success, c.successSoft)
                    }
                    Spacer(Modifier.height(10.dp))
                    val theirs = u.identityKey?.unb64()
                    val combined = if (theirs != null && myKey != null) safetyNumber(myKey, theirs) else "—"
                    Text(combined, style = Griip.type.bodyMedium.copy(fontFamily = FontFamily.Monospace, letterSpacing = 1.sp), color = c.primaryDeep, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(12.dp))
                    if (local?.identityChanged == true) {
                        PillButton("I verified the new key", {
                            // Pin exactly the key whose safety number is shown, not whatever the server returns next.
                            val shown = u.identityKey ?: return@PillButton
                            scope.launch { container.messages.acceptIdentity(userId, shown); container.users.markVerified(userId) }
                        }, Modifier.fillMaxWidth(), height = 46.dp)
                    } else if (local?.verified != true) {
                        PillButton("Mark as verified", { scope.launch { container.users.markVerified(userId) } }, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 46.dp)
                    }
                }
            }
            blocked?.let { isBlocked ->
                item {
                    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp), contentPadding = PaddingValues(4.dp)) {
                        MenuRow(
                            Icons.Outlined.Block, if (isBlocked) "Unblock ${u.displayName}" else "Block ${u.displayName}",
                            subtitle = if (isBlocked) "Their messages are dropped before they reach you." else "Their messages are dropped; they aren't told.",
                            tint = c.danger, tintBg = c.dangerSoft, trailing = null,
                            onClick = {
                                scope.launch {
                                    runCatching { if (isBlocked) container.federation.unblock(userId) else container.federation.block(userId) }
                                        .onSuccess { blocked = !isBlocked }
                                        .onFailure { error = it.friendly() }
                                }
                            },
                        )
                        // Batch B4: a person reported from their profile goes to Meldiq's team (from a community's
                        // member list it goes to that community's moderators).
                        if (reportsAvailable) MenuRow(
                            Icons.Outlined.Flag, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.rp_title_person, u.displayName),
                            tint = c.danger, tintBg = c.dangerSoft, trailing = null, onClick = { reporting = true },
                        )
                    }
                }
            }
        }
    }
    if (reporting) user?.let { who ->
        com.meldiq.android.ui.screens.moderation.ReportSheet(
            com.meldiq.android.ui.screens.moderation.ReportTarget(userId = userId, name = who.displayName), onDismiss = { reporting = false },
        )
    }
    if (inviting) user?.let { who ->
        InviteToCommunitySheet(userId, who.displayName, onDismiss = { inviting = false }, onSent = { cid -> inviting = false; nav.navigate(Routes.conversation(cid)) })
    }
}

/** Both parties see the same number: fingerprints of both identity keys, sorted. */
fun safetyNumber(a: ByteArray, b: ByteArray): String {
    val fa = Fingerprint.of(a)
    val fb = Fingerprint.of(b)
    return listOf(fa, fb).sorted().joinToString("\n")
}

@Suppress("unused")
private fun keyB64(k: ByteArray) = k.b64()

/** About me and links (API 0.46.0): links open in the browser, https only (the server accepts nothing else). */
@Composable
private fun AboutCard(about: String?, links: List<com.meldiq.android.data.api.ProfileLinkDto>) {
    val c = Griip.colors
    val ctx = androidx.compose.ui.platform.LocalContext.current
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_about_me), style = Griip.type.label.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.textSecondary)
            about?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = Griip.type.body, color = c.textPrimary)
            }
            links.filter { it.url.startsWith("https://") }.forEach { link ->
                Spacer(Modifier.height(8.dp))
                Text(
                    link.label.ifBlank { link.url }, style = Griip.type.bodyMedium, color = c.primary,
                    modifier = Modifier.clip(Shapes.small).clickable { com.meldiq.android.ui.LinkOpener.open(ctx, link.url, inApp = true) }.padding(vertical = 4.dp),
                )
            }
        }
    }
}
