package com.meldiq.android.ui.screenshots

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.ColorLens
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.rounded.AccountCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.call.AudioRoute
import com.meldiq.android.call.AudioRouteKind
import com.meldiq.android.call.CallPhase
import com.meldiq.android.call.CallUiState
import com.meldiq.android.call.ParticipantUi
import com.meldiq.android.data.billing.SparkGoalRules
import com.meldiq.android.data.billing.SparkLevel
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.FloatingNavBar
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.NavItem
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.screens.calls.CallControlBar
import com.meldiq.android.ui.screens.calls.ParticipantTile
import com.meldiq.android.ui.screens.chats.MeldiqInviteCardContent
import com.meldiq.android.ui.screens.chats.MojoPromoRow
import com.meldiq.android.ui.screens.community.PanelChannel
import com.meldiq.android.ui.screens.community.PanelChannelRow
import com.meldiq.android.ui.screens.community.PanelHeader
import com.meldiq.android.ui.screens.community.PanelSectionHeader
import com.meldiq.android.ui.screens.mojo.SparkGoalCard
import com.meldiq.android.ui.screens.mojo.SparkHero
import com.meldiq.android.ui.screens.profile.WindowGroup
import com.meldiq.android.ui.screens.you.UserPanelContent
import com.meldiq.android.ui.screens.you.UserPanelRules
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.GriipTheme
import com.meldiq.android.ui.theme.ProvideGriipPalette
import com.meldiq.android.ui.theme.MeldiqPalettes
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.ThemeMode
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Screenshots of the floating redesign (2026-10-28) drawn from the app's own components and theme, on the JVM. Run with
 * `./gradlew :app:testDebugUnitTest -Pmeldiq.screenshots=true --tests '*DesignScreenshotsTest*'`; the PNGs go to
 * `app/build/screenshots`. Skipped otherwise. The data is made up for the pictures; nothing talks to a server.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = android.app.Application::class, sdk = [35], qualifiers = "w411dp-h891dp-night-xxhdpi")
class DesignScreenshotsTest {
    @get:Rule val compose = createAndroidComposeRule<androidx.activity.ComponentActivity>()

    @Before
    fun onlyWhenAsked() = assumeTrue(System.getProperty("meldiq.screenshots") == "true")

    private fun shot(name: String, dark: Boolean = true, palette: String = MeldiqPalettes.DEFAULT, content: @Composable () -> Unit) {
        compose.setContent {
            GriipTheme(if (dark) ThemeMode.DARK else ThemeMode.LIGHT, palette) {
                Box(Modifier.fillMaxSize().background(Griip.colors.background)) { content() }
            }
        }
        compose.waitForIdle()
        // Drawn in software from the window's root view (Robolectric has no hardware frames to capture).
        val root = compose.activity.window.decorView.rootView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(android.graphics.Canvas(bitmap))
        val dir = File(System.getProperty("meldiq.screenshots.dir") ?: "build/screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private val levels = listOf(SparkLevel(0, 0, 50, voiceKbps = 64), SparkLevel(1, 2, 100, voiceKbps = 128), SparkLevel(2, 5, 150, voiceKbps = 256), SparkLevel(3, 8, 250, voiceKbps = 384))

    private fun channel(id: String, name: String, voice: Boolean = false, unread: Int = 0, mentions: Int = 0) =
        PanelChannel(id, name, null, voice, "TEXT", "cat", "General", 0, null, joined = true, unread = unread, mentions = mentions)

    @Composable
    private fun NavBar(selected: String) = FloatingNavBar(
        listOf(
            NavItem("home", "Home", Icons.Outlined.Home, Icons.Rounded.Home, badge = 3),
            NavItem("chats", "Messages", Icons.AutoMirrored.Outlined.Chat, Icons.AutoMirrored.Rounded.Chat, badge = 2),
            NavItem("activity", "Activity", Icons.Outlined.Notifications, Icons.Rounded.Notifications),
            NavItem("you", "You", Icons.Outlined.AccountCircle, Icons.Rounded.AccountCircle),
        ),
        selected, {},
    )

    @Composable
    private fun Rail() {
        val c = Griip.colors
        Column(Modifier.width(72.dp).padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf("GB" to true, "TR" to false, "SP" to false, "MJ" to false).forEachIndexed { i, (t, sel) ->
                Box(
                    Modifier.size(52.dp).clip(if (sel) Shapes.tile else CircleShape).background(if (sel) c.primarySoft else c.surface),
                    contentAlignment = Alignment.Center,
                ) { Text(t, style = Griip.type.label, color = if (sel) c.primary else c.textSecondary) }
            }
        }
    }

    @Test
    fun communityWithSparkGoal() = shot("01-community-spark-goal") {
        val goal = SparkGoalRules.goal(levels, 3)
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.weight(1f)) {
                Rail()
                Column(Modifier.weight(1f).fillMaxSize().padding(top = 4.dp, end = 8.dp).clip(Shapes.panel).background(Griip.colors.surface)) {
                    PanelHeader("GriipBuddy Studio", "128 members", onMenu = {}, onSearch = {}, onInvite = {}, sparkLevel = goal.level)
                    SparkGoalCard(goal, {}, Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                    PanelSectionHeader("General", false, 0, {}, {}, {})
                    PanelChannelRow(channel("1", "rules"), false, {}, {})
                    PanelChannelRow(channel("2", "general", unread = 4), true, {}, {})
                    PanelChannelRow(channel("3", "design", mentions = 1, unread = 2), false, {}, {})
                    PanelSectionHeader("Chatting rooms", false, 0, {}, {}, {})
                    PanelChannelRow(channel("4", "Room 1", voice = true), false, {}, {})
                    PanelChannelRow(channel("5", "Room 2", voice = true), false, {}, {})
                }
            }
            NavBar("home")
        }
    }

    @Test
    fun messagesInviteAndMojo() = shot("02-messages-invite-mojo") {
        val c = Griip.colors
        Column(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Messages", style = Griip.type.headline.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
                StatusBanner(
                    "Your messages now live on Meldiq's servers, so they're on every device you sign in to. They travel over encrypted connections; members of a conversation can read them, and Meldiq's staff can when a report or the law requires it.",
                    BannerKind.Info, action = "Got it", onAction = {},
                )
                MeldiqInviteCardContent({})
                MojoPromoRow("Bigger files, longer messages, sharper screen share", {})
                listOf("Bob" to "Hey! Welcome to Meldiq 🎉", "Carol" to "Did you see the new Spark goal?").forEachIndexed { i, (n, t) ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(n, i + 2, size = 48.dp, online = true)
                        Spacer(Modifier.width(12.dp))
                        Column {
                            Text(n, style = Griip.type.titleSmall, color = c.textPrimary)
                            Text(t, style = Griip.type.bodySmall, color = c.textSecondary)
                        }
                    }
                }
            }
            NavBar("chats")
        }
    }

    @Test
    fun userPanelAndSettingsWindow() = shot("03-user-panel-settings-window") {
        val c = Griip.colors
        Column(Modifier.fillMaxSize().padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            UserPanelContent(
                "Nahian", "🥶 Cold", UserPanelRules.Audio(micOff = false, deafened = false), inCall = false,
                avatar = { Avatar("Nahian", 5, size = 44.dp, online = true) },
                styledName = { Text("NAHIAN", style = Griip.type.titleSmall.copy(fontWeight = FontWeight.Bold), color = c.textPrimary) },
                banner = null, onStatus = {}, onMic = {}, onDeafen = {}, onSettings = {},
            )
            Column(Modifier.fillMaxWidth().weight(1f).clip(Shapes.panel).background(c.surface).padding(6.dp)) {
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Settings", style = Griip.type.headline.copy(fontWeight = FontWeight.Bold), color = c.textPrimary, modifier = Modifier.weight(1f))
                    CircleIconButton(Icons.Rounded.Close, "Close settings", {}, background = c.surfaceVariant, size = 40.dp)
                }
                WindowGroup("User settings") {
                    MenuRow(Icons.Outlined.Key, "My Account")
                    MenuRow(Icons.Outlined.Person, "My Profile")
                    MenuRow(Icons.Outlined.Palette, "Profile style")
                    MenuRow(Icons.Outlined.Lock, "Privacy & safety")
                    MenuRow(Icons.Outlined.Devices, "Devices")
                    MenuRow(Icons.Outlined.AutoAwesome, "Meldiq Mojo", subtitle = "Bigger files, longer messages, sharper screen share")
                    MenuRow(Icons.Outlined.Bolt, "Meldiq Spark", subtitle = "Levels, your Sparks, give and get more")
                    MenuRow(Icons.AutoMirrored.Outlined.Logout, "Accounts on this phone")
                }
                WindowGroup("App settings") {
                    MenuRow(Icons.Outlined.ColorLens, "Appearance")
                    MenuRow(Icons.Outlined.Headphones, "Voice & Audio")
                    MenuRow(Icons.Outlined.Notifications, "Notifications")
                    MenuRow(Icons.Outlined.Language, "Language")
                }
            }
        }
    }

    @Test
    fun groupCall() = shot("04-community-call") {
        val people = listOf(
            ParticipantUi("a", "a", "Richard Wilson", isLocal = false, speaking = true, micOn = true, camera = null, screen = null),
            ParticipantUi("b", "b", "Jenna Ortiz", isLocal = false, speaking = false, micOn = false, camera = null, screen = null),
            ParticipantUi("c", "c", "Cohan McKenzie", isLocal = false, speaking = false, micOn = true, camera = null, screen = null),
            ParticipantUi("me", "me", "Nahian", isLocal = true, speaking = false, micOn = false, camera = null, screen = null),
        )
        val state = CallUiState(
            phase = CallPhase.Connected, title = "Room 3", isGroup = true, micOn = false, participants = people,
            audioRoute = AudioRoute(AudioRouteKind.Speaker), connectedAt = 0,
        )
        ProvideGriipPalette(MeldiqPalettes.colors(MeldiqPalettes.DEFAULT, dark = true)) {
            Column(Modifier.fillMaxSize().background(Griip.colors.callStage).padding(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Room 3 · 4 in call", style = Griip.type.titleSmall, color = Griip.colors.textPrimary, modifier = Modifier.padding(start = 6.dp, top = 8.dp))
                for (row in people.chunked(2)) {
                    Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { ParticipantTile(it, Modifier.weight(1f).fillMaxSize()) }
                    }
                }
                CallControlBar(state, {}, {}, {}, {}, {}, Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }

    @Test
    fun sparkPage() = shot("05-meldiq-spark") {
        Column(Modifier.fillMaxSize().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SparkHero(total = 3, free = 1)
            for ((n, active) in listOf("GriipBuddy Studio" to 3, "Pixel Club" to 6, "Night Owls" to 9)) {
                SparkGoalCard(SparkGoalRules.goal(levels, active), {}, Modifier.padding(horizontal = 16.dp))
                Text(n, style = Griip.type.caption, color = Griip.colors.textTertiary, modifier = Modifier.padding(horizontal = 20.dp))
            }
        }
    }

    @Test
    fun lightModeAndMidnight() {
        shot("06-light-mode", dark = false) {
            Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                MeldiqInviteCardContent({})
                MojoPromoRow("You're on Mojo Plus", {})
                SparkGoalCard(SparkGoalRules.goal(levels, 5), {})
                PillButton("Join", {})
                PillButton("Cancel", {}, tone = ButtonTone.Glass)
            }
        }
    }

    @Test
    fun midnightPalette() = shot("07-midnight-palette", palette = "midnight") {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            MeldiqInviteCardContent({})
            SparkGoalCard(SparkGoalRules.goal(levels, 1), {})
            PillButton("Join", {})
            Spacer(Modifier.height(8.dp))
        }
    }
}
