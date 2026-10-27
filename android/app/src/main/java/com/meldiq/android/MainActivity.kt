package com.meldiq.android

import androidx.compose.foundation.layout.fillMaxSize
import com.meldiq.android.ui.theme.vibeTint
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.repo.SessionState
import com.meldiq.android.ui.AppRoot
import com.meldiq.android.ui.scan.InviteCodes
import com.meldiq.android.ui.theme.GriipTheme
import com.meldiq.android.ui.theme.LocalSystemBarRequests
import com.meldiq.android.ui.theme.SystemBarRequests
import com.meldiq.android.ui.theme.ThemeMode
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.launch

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MainActivity : ComponentActivity() {
    // Picture-in-picture during a call (CallPip): entered when leaving Meldiq; Android 12+ enters it automatically.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        val s = (application as GriipApp).container?.calls?.state?.value ?: return
        if (Build.VERSION.SDK_INT in 26..30 && com.meldiq.android.call.CallPip.eligible(s) && com.meldiq.android.call.CallPip.supported(this)) {
            com.meldiq.android.call.CallPip.params(this, s)?.let { runCatching { enterPictureInPictureMode(it) } }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        com.meldiq.android.call.CallPip.active.value = isInPictureInPictureMode
        // Back from the small window: the full call screen, not the in-app call panel.
        if (!isInPictureInPictureMode) (application as GriipApp).container?.calls?.expand()
    }

    // The app's own language on Android 12 and older (Android 13+ handles it itself). docs/LANGUAGES.md
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(com.meldiq.android.ui.AppLanguage.wrap(newBase))
    }

    private var pendingConversation by mutableStateOf<String?>(null)
    private var pendingInvite by mutableStateOf<String?>(null)
    private var pendingMessageLink by mutableStateOf<com.meldiq.android.data.model.MessageLinks.Target?>(null)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen() // Meldiq launch screen until the first frame (Android 12+ system splash, same look on 8–11)
        super.onCreate(savedInstanceState)
        val app = application as GriipApp
        // Dates and times in the app's language and the phone's 12/24-hour choice (batch B12); again after a language change.
        com.meldiq.android.ui.TimeFmt.init(com.meldiq.android.ui.AppLanguage.wrap(applicationContext))
        handleIntent(intent)
        setContent {
            val gen by app.generation.collectAsStateWithLifecycle()
            // Read here, keyed on the generation, so this whole scope recomposes with the new container after
            // an erase or a profile switch (a read only inside a nested lambda kept the old one).
            val container = androidx.compose.runtime.remember(gen) { app.container!! }
            val settings by container.settings.state.collectAsStateWithLifecycle()
            com.meldiq.android.ui.TimeFmt.hourFormat = settings.hourFormat
            val dark = when (settings.theme) {
                ThemeMode.DARK -> true
                ThemeMode.LIGHT -> false
                ThemeMode.SYSTEM -> (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
            }
            // Status and navigation icons follow the theme; a screen drawn dark in either theme (the call screen) asks
            // for light icons while it shows.
            val barRequests = androidx.compose.runtime.remember { SystemBarRequests() }
            val darkBars = dark || barRequests.darkSurfaces > 0
            androidx.compose.runtime.LaunchedEffect(darkBars) {
                enableEdgeToEdge(
                    statusBarStyle = if (darkBars) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
                    navigationBarStyle = if (darkBars) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT) else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
                )
            }
            androidx.compose.runtime.CompositionLocalProvider(LocalSystemBarRequests provides barRequests) {
            GriipTheme(settings.theme, settings.palette) {
                // A new container (erase, or a switch to another server profile) gets a fresh UI tree:
                // navigation, view models and remembered state never carry over between profiles.
                // The colour theme (Settings › Appearance) tints everything the app draws.
                androidx.compose.foundation.layout.Box(
                    androidx.compose.ui.Modifier.fillMaxSize().vibeTint(settings.vibe, settings.vibeCustom, settings.vibeStrength, com.meldiq.android.ui.theme.Griip.colors.isDark),
                ) {
                androidx.compose.runtime.key(gen, container) {
                    AppRoot(container, pendingConversation, pendingInvite, pendingMessageLink = pendingMessageLink, onPendingHandled = {
                        pendingConversation = null
                        pendingInvite = null
                        pendingMessageLink = null
                    })
                }
                }
            }
            }
        }
        // Keep the picture-in-picture settings in step with the call (auto-enter only while one is on).
        lifecycleScope.launch {
            app.generation.flatMapLatest { app.container!!.calls.state }.collect { s ->
                if (com.meldiq.android.call.CallPip.supported(this@MainActivity)) {
                    com.meldiq.android.call.CallPip.params(this@MainActivity, s)?.let { runCatching { setPictureInPictureParams(it) } }
                }
            }
        }
        lifecycleScope.launch {
            app.generation.flatMapLatest { app.container!!.session.state }.collect { s ->
                if (s is SessionState.SignedIn && Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        lifecycleScope.launch {
            app.generation.flatMapLatest { app.container!!.calls.state }.collect { c ->
                // Let an incoming call show over the lock screen; revert afterwards.
                val ringing = c.phase == CallPhase.Incoming || c.phase == CallPhase.Connected || c.phase == CallPhase.Connecting
                if (Build.VERSION.SDK_INT >= 27) {
                    setShowWhenLocked(ringing)
                    setTurnScreenOn(c.phase == CallPhase.Incoming)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(EXTRA_CONVERSATION)?.let { pendingConversation = it }
        // The ongoing-call notification (UI-003): straight back to the full call screen.
        if (intent.getBooleanExtra(EXTRA_OPEN_CALL, false)) (application as GriipApp).container?.calls?.expand()
        val data = intent.data
        if (data != null && InviteCodes.isInviteLink(data.scheme, data.host, data.path)) {
            pendingInvite = InviteCodes.fromScan(data.toString()) // same rule as the in-app scanner
        }
        // Batch B5: a message link opens the message when this phone is in its conversation.
        if (data != null) com.meldiq.android.data.model.MessageLinks.parse(data.toString())?.let { pendingMessageLink = it }
    }

    companion object {
        const val EXTRA_CONVERSATION = "conversation"
        /** [EXTRA_CONVERSATION]'s value that opens the Reminders screen instead of a conversation. */
        const val TARGET_REMINDERS = "@reminders"
        const val EXTRA_OPEN_CALL = "open_call"
    }
}
