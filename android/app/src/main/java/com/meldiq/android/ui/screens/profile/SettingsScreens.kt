package com.meldiq.android.ui.screens.profile

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.asPaddingValues
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.AutoStories
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Preview
import androidx.compose.material.icons.outlined.RingVolume
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.SyncAlt
import androidx.compose.material.icons.outlined.TextFields
import androidx.compose.material.icons.outlined.Vibration
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Wallpaper
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Slider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.BuildConfig
import com.meldiq.android.GriipApp
import com.meldiq.android.R
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.repo.AutoDownload
import com.meldiq.android.data.model.AttachmentPolicy.Quality
import com.meldiq.android.data.repo.LinkOpening
import com.meldiq.android.data.repo.Settings
import com.meldiq.android.ui.AppLanguage
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.ChipRow
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipSwitch
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.LargeHeader
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.PillChip
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.TagPill
import com.meldiq.android.ui.components.UserAvatar
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.Wallpapers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Older links to the Settings page (`Routes.PROFILE`, `Routes.SETTINGS`): since the floating redesign (2026-10-28)
 * Settings is a window over the current screen ([SettingsWindow]), so the link goes back and opens it there.
 */
@Composable
fun SettingsHub(nav: NavHostController) {
    val window = LocalSettingsWindow.current
    LaunchedEffect(Unit) {
        nav.popBackStack()
        window.show()
    }
}

// ───────────────────────────── Chats ─────────────────────────────

@Composable
fun ChatSettingsScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val s by container.settings.state.collectAsStateWithLifecycle()
    fun update(f: (Settings) -> Settings) = container.settings.update(f)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.settings_chats), onBack = { nav.popBackStack() }) }
        item { SectionHeader(stringResource(R.string.chat_appearance), Modifier.padding(top = 6.dp, bottom = 6.dp)) }
        item { AppearanceSettings(s, ::update) }
        item {
            Text(stringResource(R.string.chat_wallpaper), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = Space.gutter, top = 18.dp, bottom = 6.dp))
            Row(Modifier.padding(horizontal = Space.gutter), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Wallpapers.ALL.forEach { w ->
                    val selected = s.wallpaper == w.id
                    Box(
                        Modifier.size(width = 56.dp, height = 80.dp).clip(com.meldiq.android.ui.theme.Shapes.small)
                            .then(Wallpapers.modifier(w.id, c)).background(if (w.id == "none") c.background else Color.Transparent)
                            .border(if (selected) 3.dp else 1.dp, if (selected) c.primary else c.border, com.meldiq.android.ui.theme.Shapes.small)
                            .pressable({ update { it.copy(wallpaper = w.id) } }, onClickLabel = w.label).semantics { contentDescription = w.label },
                    )
                }
            }
        }
        item {
            Text(stringResource(R.string.chat_text_size), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = Space.gutter, top = 14.dp))
            Slider(
                s.textScale, { v -> update { it.copy(textScale = (Math.round(v * 20) / 20f)) } }, valueRange = 0.9f..1.3f, steps = 7,
                modifier = Modifier.padding(horizontal = Space.gutter),
                colors = androidx.compose.material3.SliderDefaults.colors(
                    thumbColor = c.primary, activeTrackColor = c.primary, inactiveTrackColor = c.surfaceVariant,
                    activeTickColor = c.onPrimary, inactiveTickColor = c.textSecondary,
                ),
            )
            val body = Griip.type.body
            Box(Modifier.padding(horizontal = Space.gutter).clip(com.meldiq.android.ui.theme.Shapes.tile).background(c.bubbleOutgoing).padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(stringResource(R.string.chat_text_preview), style = body.copy(fontSize = body.fontSize * s.textScale), color = c.onBubbleOutgoing)
            }
        }
        item { SectionHeader(stringResource(R.string.chat_messages), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.AutoAwesome, stringResource(R.string.chat_animated_emoji), subtitle = stringResource(R.string.chat_animated_emoji_sub), trailing = {
                    GriipSwitch(s.animatedEmoji, { v -> update { it.copy(animatedEmoji = v) } })
                })
            }
        }
        item { SectionHeader(stringResource(R.string.chat_links), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                listOf(
                    LinkOpening.IN_APP to (R.string.link_in_app to R.string.link_in_app_sub),
                    LinkOpening.EXTERNAL to (R.string.link_external to R.string.link_external_sub),
                    LinkOpening.ASK to (R.string.link_ask to R.string.link_ask_sub),
                ).forEach { (mode, labels) ->
                    MenuRow(Icons.Outlined.Link, stringResource(labels.first), subtitle = stringResource(labels.second),
                        trailing = { if (s.linkOpening == mode) androidx.compose.material3.Icon(Icons.Rounded.Check, null, tint = c.primary) },
                        onClick = { update { it.copy(linkOpening = mode) } })
                }
                MenuRow(Icons.Outlined.Preview, stringResource(R.string.chat_link_previews), subtitle = stringResource(R.string.chat_link_previews_sub), trailing = {
                    GriipSwitch(s.linkPreviews, { v -> update { it.copy(linkPreviews = v) } })
                })
                MenuRow(Icons.Outlined.MusicNote, stringResource(R.string.chat_media_cards), subtitle = stringResource(R.string.chat_media_cards_sub), trailing = {
                    GriipSwitch(s.mediaCards, { v -> update { it.copy(mediaCards = v) } })
                })
                if (s.mediaCards) MenuRow(Icons.Outlined.MusicNote, stringResource(R.string.ux_in_app_video), subtitle = stringResource(R.string.ux_in_app_video_sub), trailing = {
                    GriipSwitch(s.inAppVideo, { v -> update { it.copy(inAppVideo = v) } })
                })
            }
        }
        item { SectionHeader(stringResource(R.string.chat_media), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                Text(stringResource(R.string.chat_auto_download), style = Griip.type.titleSmall, color = c.textPrimary, modifier = Modifier.padding(start = 12.dp, top = 10.dp))
                ChipRow {
                    listOf(AutoDownload.NEVER to R.string.auto_never, AutoDownload.WIFI to R.string.auto_wifi, AutoDownload.ALWAYS to R.string.auto_always).forEach { (m, label) ->
                        PillChip(stringResource(label), s.autoDownload == m, { update { it.copy(autoDownload = m) } })
                    }
                }
                Text(stringResource(R.string.chat_auto_download_sub), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp))
            }
        }
        item {
            // Where a send of photos and videos starts; the send preview can still change it each time.
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter).padding(top = 8.dp), contentPadding = PaddingValues(4.dp)) {
                Text(stringResource(R.string.ux_upload_quality), style = Griip.type.titleSmall, color = c.textPrimary, modifier = Modifier.padding(start = 12.dp, top = 10.dp))
                Text(stringResource(R.string.ux_photos), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp, top = 8.dp))
                ChipRow {
                    listOf(Quality.STANDARD to R.string.ux_q_standard, Quality.HD to R.string.ux_q_hd, Quality.ORIGINAL to R.string.ux_q_original).forEach { (q, label) ->
                        PillChip(stringResource(label), s.photoQuality == q, { update { it.copy(photoQuality = q) } })
                    }
                }
                Text(stringResource(R.string.ux_videos), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp, top = 4.dp))
                ChipRow {
                    listOf(Quality.ORIGINAL to R.string.ux_q_original, Quality.HD to R.string.ux_q_1080, Quality.STANDARD to R.string.ux_q_720).forEach { (q, label) ->
                        PillChip(stringResource(label), s.videoQuality == q, { update { it.copy(videoQuality = q) } })
                    }
                }
                Text(stringResource(R.string.ux_upload_quality_sub), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp))
            }
        }
        item { SectionHeader(stringResource(R.string.ux_gestures), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.ChatBubbleOutline, stringResource(R.string.ux_swipe_reply), subtitle = stringResource(R.string.ux_swipe_reply_sub), trailing = {
                    GriipSwitch(s.swipeReply, { v -> update { it.copy(swipeReply = v) } })
                })
                MenuRow(Icons.Outlined.AutoAwesome, stringResource(R.string.ux_double_tap), subtitle = stringResource(R.string.ux_double_tap_sub), trailing = {
                    GriipSwitch(s.doubleTapReact, { v -> update { it.copy(doubleTapReact = v) } })
                })
                if (s.doubleTapReact) ChipRow {
                    com.meldiq.android.data.repo.DOUBLE_TAP_EMOJI.forEach { e -> PillChip(e, s.doubleTapEmoji == e, { update { it.copy(doubleTapEmoji = e) } }) }
                }
            }
        }
    }
}

// ───────────────────────────── Notifications & sounds ─────────────────────────────

@Composable
fun NotificationSettingsScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val ctx = LocalContext.current
    val c = Griip.colors
    val s by container.settings.state.collectAsStateWithLifecycle()
    fun update(f: (Settings) -> Settings) {
        container.settings.update(f)
        com.meldiq.android.notify.Channels.applySoundSettings(ctx, container.settings.current)
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.settings_notifications), onBack = { nav.popBackStack() }) }
        item { SectionHeader(stringResource(R.string.notif_messages_section), Modifier.padding(top = 6.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.Notifications, stringResource(R.string.notif_messages), subtitle = stringResource(R.string.notif_messages_sub), trailing = {
                    GriipSwitch(s.notifications, { v -> update { it.copy(notifications = v) } })
                })
                MenuRow(Icons.Outlined.Groups, stringResource(R.string.notif_groups), subtitle = stringResource(R.string.notif_groups_sub), trailing = {
                    GriipSwitch(s.groupNotifications, { v -> update { it.copy(groupNotifications = v) } })
                })
                MenuRow(Icons.Outlined.Visibility, stringResource(R.string.notif_previews), subtitle = stringResource(R.string.notif_previews_sub), trailing = {
                    GriipSwitch(s.notificationPreviews, { v -> update { it.copy(notificationPreviews = v) } })
                })
                MenuRow(Icons.Outlined.MusicNote, stringResource(R.string.notif_sound), subtitle = stringResource(R.string.notif_sound_sub), trailing = {
                    GriipSwitch(s.messageSound, { v -> update { it.copy(messageSound = v) } })
                })
                MenuRow(Icons.Outlined.Vibration, stringResource(R.string.notif_vibrate), trailing = {
                    GriipSwitch(s.vibrate, { v -> update { it.copy(vibrate = v) } })
                })
            }
        }
        item { SectionHeader(stringResource(R.string.notif_calls_section), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.RingVolume, stringResource(R.string.notif_ringtone), subtitle = stringResource(R.string.notif_ringtone_sub), trailing = {
                    GriipSwitch(s.callRingtone, { v -> update { it.copy(callRingtone = v) } })
                })
            }
        }
        item { SectionHeader(stringResource(R.string.notif_delivery_section), Modifier.padding(top = 16.dp, bottom = 6.dp)) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(4.dp)) {
                MenuRow(Icons.Outlined.SyncAlt, stringResource(R.string.notif_background), subtitle = stringResource(R.string.notif_background_sub), trailing = {
                    GriipSwitch(s.backgroundConnection, { v -> update { it.copy(backgroundConnection = v) } })
                })
                PushWakeupRow(s, ::update)
                MenuRow(Icons.Outlined.NotificationsActive, stringResource(R.string.notif_system), subtitle = stringResource(R.string.notif_system_sub), onClick = {
                    val i = if (Build.VERSION.SDK_INT >= 26) Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(AndroidSettings.EXTRA_APP_PACKAGE, ctx.packageName)
                    else Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(android.net.Uri.parse("package:" + ctx.packageName))
                    runCatching { ctx.startActivity(i) }
                })
            }
        }
        item { PushExplainer(Modifier.padding(start = Space.gutter, end = Space.gutter, top = 10.dp)) }
        item {
            val problems = com.meldiq.android.ui.screens.home.rememberNotificationProblems(s)
            if (problems.isNotEmpty()) com.meldiq.android.ui.screens.home.NotificationProblems(problems, Modifier.padding(horizontal = Space.gutter, vertical = 10.dp))
        }
        item {
            Text(stringResource(R.string.notif_per_chat_hint), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 10.dp))
        }
    }
}

// ───────────────────────────── Calls ─────────────────────────────

@Composable
fun CallSettingsScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val s by container.settings.state.collectAsStateWithLifecycle()
    fun update(f: (Settings) -> Settings) = container.settings.update(f)
    var checking by remember { mutableStateOf(false) }
    if (checking) com.meldiq.android.ui.screens.calls.PreCallCheckSheet(onDismiss = { checking = false })
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.settings_calls), onBack = { nav.popBackStack() }) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(4.dp)) {
                MenuRow(
                    Icons.Outlined.Shield, stringResource(R.string.call_e2ee),
                    subtitle = stringResource(if (s.mediaE2ee) R.string.call_e2ee_on else R.string.call_e2ee_off),
                    trailing = { GriipSwitch(s.mediaE2ee, { v -> update { it.copy(mediaE2ee = v) } }) },
                )
                MenuRow(
                    Icons.Outlined.GraphicEq, stringResource(R.string.call_hw_aec),
                    subtitle = stringResource(if (s.hardwareEchoCanceller) R.string.call_hw_aec_on else R.string.call_hw_aec_off),
                    trailing = { GriipSwitch(s.hardwareEchoCanceller, { v -> update { it.copy(hardwareEchoCanceller = v) } }) },
                )
                // Batch B10: noise reduction, off for music.
                MenuRow(
                    Icons.Outlined.GraphicEq, stringResource(R.string.b10_noise),
                    subtitle = stringResource(if (s.noiseReduction) R.string.b10_noise_on else R.string.b10_noise_off),
                    trailing = { GriipSwitch(s.noiseReduction, { v -> update { it.copy(noiseReduction = v) } }) },
                )
                // Batch B10: check the microphone and camera before a call.
                MenuRow(Icons.Outlined.Mic, stringResource(R.string.b10_check), subtitle = stringResource(R.string.b10_check_sub), onClick = { checking = true })
            }
        }
    }
}

// ───────────────────────────── Language ─────────────────────────────

@Composable
fun LanguageScreen(nav: NavHostController) {
    val ctx = LocalContext.current
    val c = Griip.colors
    val container = LocalContainer.current
    val current = AppLanguage.current(ctx)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.settings_language), onBack = { nav.popBackStack() }) }
        item {
            GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp), contentPadding = PaddingValues(4.dp)) {
                AppLanguage.SUPPORTED.forEach { tag ->
                    MenuRow(
                        Icons.Outlined.Language, if (tag == "system") stringResource(R.string.lang_system) else AppLanguage.nativeName(tag),
                        trailing = { if (tag == current) androidx.compose.material3.Icon(Icons.Rounded.Check, null, tint = c.primary) },
                        onClick = {
                            if (tag != current) {
                                container.settings.update { it.copy(language = tag) }
                                (ctx as? Activity)?.let { AppLanguage.apply(it, tag) }
                            }
                        },
                    )
                }
            }
        }
        item { Text(stringResource(R.string.lang_note), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 10.dp)) }
    }
}

// ───────────────────────────── Accounts ─────────────────────────────

/**
 * Accounts on this phone (docs/SETTINGS.md › Accounts). Each account has its own identity keys, device credentials,
 * encrypted database, files and server address (ProfileStorage); nothing is merged or moved between them, and signing
 * out of one leaves the others signed in. Only the active account is connected.
 */
@Composable
fun AccountsScreen(nav: NavHostController) {
    val app = LocalContext.current.applicationContext as GriipApp
    val container = LocalContainer.current
    val c = Griip.colors
    val call by container.calls.state.collectAsStateWithLifecycle()
    val registry by app.profiles.state.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    var rows by remember { mutableStateOf<List<GriipApp.ProfileSummary>>(emptyList()) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(registry, refresh) { rows = withContext(Dispatchers.IO) { app.profileSummaries() } }
    var selected by remember { mutableStateOf<GriipApp.ProfileSummary?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<GriipApp.ProfileSummary?>(null) }
    val inCall = call.phase != CallPhase.Idle
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { GriipTopBar(stringResource(R.string.settings_accounts), onBack = { nav.popBackStack() }) }
        item { Text(stringResource(R.string.accounts_explain), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter, vertical = 8.dp)) }
        if (inCall) item { StatusBanner(stringResource(R.string.accounts_in_call), BannerKind.Info, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
        items(rows, key = { it.id }) { p ->
            val defaultServer = com.meldiq.android.data.repo.ServerAddress.same(p.serverUrl, BuildConfig.DEFAULT_SERVER_URL)
            ListCard(
                p.displayName ?: p.username?.let { "@$it" } ?: stringResource(R.string.accounts_not_signed_in), Modifier.padding(horizontal = 8.dp),
                subtitle = listOfNotNull(p.username?.let { "@$it" }, if (!defaultServer || settings.developerMode) hostOf(p.serverUrl) else null).joinToString(" · ").ifEmpty { null },
                leading = { com.meldiq.android.ui.components.Avatar(p.displayName ?: p.username ?: "?", p.id.hashCode(), size = 44.dp) },
                trailing = { if (p.active) TagPill(stringResource(R.string.accounts_active), c.success, c.successSoft) },
                onClick = { selected = p },
            )
        }
        item {
            Spacer(Modifier.height(12.dp))
            PillButton(
                stringResource(R.string.accounts_add), { app.addProfile(BuildConfig.DEFAULT_SERVER_URL) }, Modifier.fillMaxWidth().padding(horizontal = Space.gutter),
                tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Add, enabled = !inCall, height = 50.dp,
            )
            if (settings.developerMode) PillButton(
                stringResource(R.string.accounts_add_other_server), { nav.navigate(Routes.SERVERS) }, Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 8.dp),
                tone = ButtonTone.Glass, leadingIcon = Icons.Outlined.Dns, enabled = !inCall, height = 46.dp,
            )
        }
    }
    selected?.let { p ->
        GlassSheet({ selected = null }, title = p.displayName ?: p.username?.let { "@$it" } ?: stringResource(R.string.accounts_not_signed_in)) {
            if (!p.active) MenuRow(
                Icons.Outlined.SwapHoriz, stringResource(R.string.accounts_switch), subtitle = if (inCall) stringResource(R.string.accounts_in_call) else null,
                onClick = if (inCall) null else ({ selected = null; app.switchProfile(p.id) }), trailing = null,
            )
            if (p.active) {
                MenuRow(Icons.Outlined.Security, stringResource(R.string.accounts_recovery), subtitle = stringResource(R.string.accounts_recovery_sub), onClick = { selected = null; nav.navigate(Routes.SECURITY) }, trailing = null)
                MenuRow(Icons.Outlined.Devices, stringResource(R.string.accounts_devices), onClick = { selected = null; nav.navigate(Routes.DEVICES) }, trailing = null)
                MenuRow(Icons.Outlined.Logout, stringResource(R.string.accounts_sign_out), subtitle = stringResource(R.string.accounts_sign_out_sub), tint = c.danger, tintBg = c.dangerSoft,
                    onClick = { selected = null; confirmSignOut = true }, trailing = null)
            } else if (!p.original) {
                MenuRow(Icons.Outlined.DeleteOutline, stringResource(R.string.accounts_remove), subtitle = stringResource(R.string.accounts_remove_sub), tint = c.danger, tintBg = c.dangerSoft,
                    onClick = { selected = null; confirmRemove = p }, trailing = null)
            }
            Spacer(Modifier.height(12.dp))
        }
    }
    if (confirmSignOut) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text(stringResource(R.string.accounts_sign_out_confirm_title)) },
            text = { Text(stringResource(R.string.accounts_sign_out_confirm_body)) },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { confirmSignOut = false; app.eraseEverything() }) { Text(stringResource(R.string.accounts_sign_out), color = c.danger) } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    confirmRemove?.let { p ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(stringResource(R.string.accounts_remove)) },
            text = { Text(stringResource(R.string.accounts_remove_confirm_body)) },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { confirmRemove = null; app.removeProfile(p.id); refresh++ }) { Text(stringResource(R.string.accounts_remove), color = c.danger) } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { confirmRemove = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}
