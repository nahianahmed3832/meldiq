package com.meldiq.android.ui.screens.profile

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.AutoStories
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.ColorLens
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.meldiq.android.BuildConfig
import com.meldiq.android.GriipApp
import com.meldiq.android.R
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.ValueChevron
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.rememberReducedMotion
import kotlinx.coroutines.launch

/**
 * Settings as a floating window (the floating redesign, 2026-10-28, as Meldiq Web's Settings window): it opens over
 * whatever screen you're on from the user panel's gear and closes back to it. A page opened from it (Notifications,
 * Meldiq Spark…) is pushed as before; coming Back from it shows the window again over the screen it was opened on.
 */
@Stable
class SettingsWindow {
    var open by mutableStateOf(false)
        private set

    /** The back-stack entry the window was over when a page was opened from it: Back to that entry reopens it. */
    internal var returnTo: String? = null

    fun show() { open = true }
    fun close() { open = false; returnTo = null }

    /** Opens a settings page over [nav]'s current screen; Back from it brings the window back. */
    fun openPage(nav: NavHostController, route: String) {
        returnTo = nav.currentBackStackEntry?.id
        open = false
        nav.navigate(route)
    }

    /** Called whenever the current back-stack entry changes: back on the screen the window was over, it reopens. */
    internal fun onEntry(id: String?) {
        if (returnTo != null && id == returnTo) {
            returnTo = null
            open = true
        }
    }
}

val LocalSettingsWindow = staticCompositionLocalOf { SettingsWindow() }

/** Draws the Settings window over [nav]'s screens while it's open. Placed once, above the app's navigation. */
@Composable
fun SettingsWindowHost(nav: NavHostController, window: SettingsWindow) {
    val entry by nav.currentBackStackEntryAsState()
    LaunchedEffect(entry?.id) { window.onEntry(entry?.id) }
    BackHandler(enabled = window.open) { window.close() }
    val c = Griip.colors
    val still = rememberReducedMotion()
    AnimatedVisibility(
        visible = window.open,
        enter = if (still) EnterTransition.None else fadeIn(Motion.enter(Motion.QUICK)),
        exit = if (still) ExitTransition.None else fadeOut(Motion.exit(Motion.QUICK)),
    ) {
        Box(
            Modifier.fillMaxSize().background(c.scrim)
                .clickable(remember { MutableInteractionSource() }, indication = null, onClick = window::close),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(10.dp).widthIn(max = 720.dp)
                    .animateEnterExit(
                        enter = if (still) EnterTransition.None else scaleIn(Motion.enter(Motion.STANDARD), initialScale = 0.96f),
                        exit = if (still) ExitTransition.None else scaleOut(Motion.exit(Motion.QUICK), targetScale = 0.98f),
                    )
                    .clip(Shapes.panel).background(c.surface).border(1.dp, c.border, Shapes.panel)
                    // Taps inside the window never reach the scrim behind it.
                    .clickable(remember { MutableInteractionSource() }, indication = null) {},
            ) {
                SettingsWindowContent(onOpen = { window.openPage(nav, it) }, onClose = window::close)
            }
        }
    }
}

/** The window's pages, in groups (as Meldiq Web's Settings: User settings, App settings), with a close button. */
@Composable
private fun SettingsWindowContent(onOpen: (String) -> Unit, onClose: () -> Unit) {
    val container = LocalContainer.current
    val app = LocalContext.current.applicationContext as GriipApp
    val c = Griip.colors
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val registry by app.profiles.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var versionTaps by remember { mutableIntStateOf(0) }
    var platformAdmin by remember { mutableStateOf(false) }
    var address by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        platformAdmin = runCatching { container.api.get<com.meldiq.android.data.api.PlatformMeRes>("/v1/platform/me").platformAdmin }.getOrDefault(false)
        address = runCatching { container.federation.info()?.address }.getOrNull()
    }
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = Space.xl, end = 6.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.settings_title), style = Griip.type.headline.copy(fontWeight = FontWeight.Bold), color = c.textPrimary,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            CircleIconButton(Icons.Rounded.Close, stringResource(R.string.sw_close), onClose, background = c.surfaceVariant, size = 40.dp)
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 6.dp, end = 6.dp, bottom = 16.dp)) {
            item(key = "user") {
                WindowGroup(stringResource(R.string.wp_settings_user_group)) {
                    MenuRow(Icons.Outlined.Key, stringResource(R.string.sw_my_account), subtitle = stringResource(R.string.wp_safety_sub), onClick = { onOpen(Routes.ACCOUNT_SAFETY) })
                    MenuRow(Icons.Outlined.Person, stringResource(R.string.sw_my_profile), onClick = { onOpen(Routes.EDIT_PROFILE) })
                    MenuRow(Icons.Outlined.Palette, stringResource(R.string.wp_style_title), onClick = { onOpen(Routes.PROFILE_STYLE) })
                    MenuRow(Icons.Outlined.Lock, stringResource(R.string.settings_privacy), subtitle = stringResource(R.string.settings_privacy_sub), onClick = { onOpen(Routes.PRIVACY) })
                    MenuRow(Icons.Outlined.Devices, stringResource(R.string.wp_settings_devices), onClick = { onOpen(Routes.DEVICES) })
                    MenuRow(Icons.Outlined.AutoAwesome, stringResource(R.string.mojo_title), subtitle = mojoValue(), onClick = { onOpen(Routes.MOJO) })
                    MenuRow(Icons.Outlined.Bolt, stringResource(R.string.mojo_spark_title), subtitle = stringResource(R.string.spark_entry_sub), onClick = { onOpen(Routes.SPARK) })
                    MenuRow(Icons.Outlined.People, stringResource(R.string.contacts_title), onClick = { onOpen(Routes.CONTACTS) })
                    MenuRow(
                        Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.settings_accounts),
                        subtitle = stringResource(R.string.settings_accounts_sub, registry.ids.size), onClick = { onOpen(Routes.ACCOUNTS) },
                    )
                }
            }
            item(key = "app") {
                WindowGroup(stringResource(R.string.wp_settings_app_group)) {
                    MenuRow(Icons.Outlined.ColorLens, stringResource(R.string.sw_appearance), onClick = { onOpen(Routes.CHAT_SETTINGS) }, trailing = { ValueChevron(appearanceValue()) })
                    MenuRow(Icons.Outlined.Headphones, stringResource(R.string.sw_voice_audio), subtitle = stringResource(R.string.settings_calls_sub), onClick = { onOpen(Routes.CALL_SETTINGS) })
                    MenuRow(Icons.Outlined.Notifications, stringResource(R.string.settings_notifications), onClick = { onOpen(Routes.NOTIFICATION_SETTINGS) }, trailing = { ValueChevron(notificationsValue()) })
                    MenuRow(Icons.Outlined.Language, stringResource(R.string.settings_language), onClick = { onOpen(Routes.LANGUAGE) }, trailing = { ValueChevron(languageValue()) })
                    MenuRow(Icons.Outlined.Storage, stringResource(R.string.settings_storage), subtitle = stringResource(R.string.settings_storage_sub), onClick = { onOpen(Routes.STORAGE) })
                }
            }
            item(key = "problems") {
                // What Android or the phone maker has silenced or blocked, with a link to fix each one.
                val problems = com.meldiq.android.ui.screens.home.rememberNotificationProblems(settings)
                if (problems.isNotEmpty()) com.meldiq.android.ui.screens.home.NotificationProblems(problems, Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
            }
            item(key = "advanced") {
                WindowGroup(stringResource(R.string.sw_advanced)) {
                    // Platform admins only (PLATFORM_ADMIN_USER_IDS on the server): the server's own health (round 7).
                    if (platformAdmin) {
                        MenuRow(Icons.Outlined.MonitorHeart, stringResource(R.string.ops_health), subtitle = stringResource(R.string.ops_health_sub), onClick = { onOpen(Routes.SERVICE_HEALTH) })
                    }
                    address?.let { a ->
                        MenuRow(
                            Icons.Outlined.AlternateEmail, a, subtitle = stringResource(R.string.settings_address_sub), trailing = null,
                            onClick = { scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("address", a))) } },
                        )
                    }
                    MenuRow(
                        Icons.Outlined.Info, stringResource(R.string.settings_about), subtitle = stringResource(R.string.settings_about_sub, BuildConfig.VERSION_NAME),
                        onClick = {
                            // Seven taps on About show the developer options (the server setup); seven more hide them.
                            versionTaps++
                            if (versionTaps >= 7) {
                                versionTaps = 0
                                container.settings.update { it.copy(developerMode = !it.developerMode) }
                            } else if (versionTaps == 1) onOpen(Routes.SECURITY)
                        },
                    )
                    MenuRow(Icons.Outlined.AutoStories, stringResource(R.string.settings_intro), subtitle = stringResource(R.string.settings_intro_sub), onClick = { onOpen(Routes.INTRO) })
                    if (settings.developerMode) {
                        MenuRow(Icons.Outlined.Dns, stringResource(R.string.settings_developer), subtitle = container.session.serverUrl, onClick = { onOpen(Routes.SERVERS) })
                    }
                }
                if (container.session.serverUrl.startsWith("http://")) {
                    StatusBanner(stringResource(R.string.settings_cleartext_warning), BannerKind.Warning, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
                }
            }
        }
    }
}

/** Meldiq Mojo's row value: the plan this account is on, or what Mojo adds. */
@Composable
private fun mojoValue(): String {
    val mojo = LocalContainer.current.mojo
    val state by mojo.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (state.entitlements == null) mojo.refresh() }
    val key = com.meldiq.android.data.billing.MojoPlans.currentKey(state.entitlements)
    val name = state.catalog?.plan(key)?.name
    return if (key != com.meldiq.android.data.billing.MojoPlans.FREE && name != null) stringResource(R.string.mojo_entry_sub_plan, name)
    else stringResource(R.string.mojo_entry_sub_free)
}

@Composable
internal fun WindowGroup(title: String, content: @Composable () -> Unit) {
    val c = Griip.colors
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(
            title.uppercase(), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp), color = c.textTertiary,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp).semantics { heading() },
        )
        Column(Modifier.fillMaxWidth().clip(Shapes.card).background(c.surfaceVariant).padding(4.dp)) { content() }
    }
}
