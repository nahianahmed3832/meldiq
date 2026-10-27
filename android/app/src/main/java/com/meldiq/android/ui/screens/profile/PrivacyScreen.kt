package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Cake
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.ShortText
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.model.Audience
import com.meldiq.android.data.model.PrivacyField
import com.meldiq.android.data.model.ProfileRules
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.ShimmerList
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

private data class FieldRow(val field: PrivacyField, val icon: ImageVector, val title: String, val explain: String)

private val PROFILE_ROWS = listOf(
    FieldRow(PrivacyField.PHOTO, Icons.Outlined.PhotoCamera, "Profile photo", "Not end-to-end encrypted: the server stores it to show it."),
    FieldRow(PrivacyField.NAME, Icons.Outlined.Person, "First and last name", "Your display name is always shown in chats."),
    FieldRow(PrivacyField.BIO, Icons.Outlined.ShortText, "Bio", ""),
    FieldRow(PrivacyField.BIRTHDAY, Icons.Outlined.Cake, "Birthday", ""),
    FieldRow(PrivacyField.PHONE, Icons.Outlined.Phone, "Phone number", ""),
    FieldRow(PrivacyField.LAST_SEEN, Icons.Outlined.Schedule, "Online and last seen", ""),
)
private val FIND_ROWS = listOf(
    FieldRow(PrivacyField.FIND_BY_USERNAME, Icons.Outlined.AlternateEmail, "Find me by username", "Including from other servers on the Meldiq network."),
    FieldRow(PrivacyField.FIND_BY_PHONE, Icons.Outlined.PersonSearch, "Find me by phone number", "Only someone who types your exact number. Your address book is never uploaded."),
)

/**
 * Privacy (2026-10-17, docs/PROFILE_AND_PRIVACY.md): who sees each part of the profile, who can find you, receipts and
 * typing, and blocked people. The server enforces the profile settings; receipts and typing are decided on this phone.
 */
@Composable
fun PrivacyScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    var stored by remember { mutableStateOf<Map<String, String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf<FieldRow?>(null) }
    LaunchedEffect(Unit) { runCatching { container.profiles.me() }.onSuccess { stored = it.privacy ?: emptyMap() }.onFailure { error = it.friendly() } }
    val privacy = stored?.let { ProfileRules.privacy(it) }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.settings_privacy), onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        item { SectionHeader("Security", Modifier.padding(top = 6.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.Key, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_security_row), subtitle = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.wp_security_row_sub), onClick = { nav.navigate(Routes.SECURITY) })
                MenuRow(Icons.Outlined.Devices, "Devices & sessions", subtitle = "Phones signed in to this account; sign one out", onClick = { nav.navigate(Routes.DEVICES) })
            }
        }
        item { SectionHeader("Who can see my profile", Modifier.padding(top = 6.dp, bottom = 6.dp)) }
        if (privacy == null && error == null) item { ShimmerList(4) }
        if (privacy != null) {
            item {
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                    PROFILE_ROWS.forEach { r ->
                        MenuRow(r.icon, r.title, subtitle = ProfileRules.audienceSummary(privacy.getValue(r.field)) + if (r.explain.isNotEmpty()) " · ${r.explain}" else "", onClick = { choosing = r })
                    }
                }
            }
            item { SectionHeader("Who can find me", Modifier.padding(top = 14.dp, bottom = 6.dp)) }
            item {
                GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                    FIND_ROWS.forEach { r ->
                        MenuRow(r.icon, r.title, subtitle = ProfileRules.audienceSummary(privacy.getValue(r.field)) + " · ${r.explain}", onClick = { choosing = r })
                    }
                }
            }
        }
        item { SectionHeader("Messages", Modifier.padding(top = 14.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.DoneAll, "Send read receipts", subtitle = "Direct messages and groups of up to 20", trailing = {
                    GriipSwitch(settings.readReceipts, { v -> container.settings.update { it.copy(readReceipts = v) } })
                })
                MenuRow(Icons.Outlined.Keyboard, "Show when I'm typing", trailing = {
                    GriipSwitch(settings.typingIndicators, { v -> container.settings.update { it.copy(typingIndicators = v) } })
                })
                MenuRow(Icons.Outlined.Block, "Blocked people", subtitle = "Their messages and calls don't reach you", onClick = { nav.navigate(Routes.BLOCKED) })
            }
        }
        // Batch B6: who can message you directly, and who can send you requests.
        item { MessagingPrivacyCard() }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 14.dp)) {
                MenuRow(
                    Icons.Outlined.Info, "What these settings don't hide",
                    subtitle = "Messages and calls are end-to-end encrypted. To deliver them, servers still see your username, display name, " +
                        "who you talk to and when, and message sizes. People on other servers see your username, display name and address.",
                    trailing = null,
                )
            }
        }
    }

    choosing?.let { row ->
        val current = privacy?.get(row.field) ?: row.field.default
        GlassSheet({ choosing = null }, title = row.title) {
            Audience.entries.forEach { a ->
                MenuRow(
                    row.icon, ProfileRules.audienceSummary(a),
                    subtitle = when (a) {
                        Audience.EVERYONE -> if (row.field == PrivacyField.FIND_BY_USERNAME) "Anyone on the Meldiq network" else "Anyone who can look you up"
                        Audience.CONTACTS -> "People you share a chat with, or a workspace where neither of you is a guest"
                        Audience.NOBODY -> "Only you"
                    },
                    trailing = { if (a == current) Text("✓", style = Griip.type.titleSmall, color = c.primary) },
                    onClick = {
                        choosing = null
                        scope.launch {
                            runCatching { container.profiles.setPrivacy(row.field, a) }
                                .onSuccess { stored = it }.onFailure { error = it.friendly() }
                        }
                    },
                )
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

/** People this account has blocked, each with Unblock. */
@Composable
fun BlockedUsersScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<UserDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        runCatching { container.profiles.blockedUsers(container.federation) }.onSuccess { list = it }.onFailure { error = it.friendly() }
    }
    LaunchedEffect(Unit) { load() }
    val l = list
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar("Blocked people", onBack = { nav.popBackStack() }) }
        error?.let { item { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) } }
        when {
            l == null && error == null -> item { ShimmerList(3) }
            l != null && l.isEmpty() -> item {
                EmptyState(Icons.Outlined.Block, "No one blocked", "Block someone from their profile. They aren't told; their messages and calls stop reaching you.")
            }
            l != null -> items(l, key = { it.id }) { u ->
                ListCard(
                    u.displayName, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), subtitle = "@${u.username}",
                    leading = { UserAvatar(u.id, u.displayName, u.avatarColor, u.photoRev, size = 44.dp) },
                    trailing = {
                        PillButton("Unblock", {
                            scope.launch {
                                runCatching { container.federation.unblock(u.id) }.onSuccess { load() }.onFailure { error = it.friendly() }
                            }
                        }, tone = ButtonTone.Glass, height = 36.dp)
                    },
                    onClick = { nav.navigate(Routes.user(u.id)) },
                )
            }
        }
    }
}
