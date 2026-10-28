package com.meldiq.android.ui.screens.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.BuildConfig
import com.meldiq.android.GriipApp
import com.meldiq.android.R
import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.data.repo.ServerAddress
import com.meldiq.android.ui.screens.account.AccountOnboarding
import com.meldiq.android.ui.screens.account.AccountStep
import com.meldiq.android.ui.screens.account.accountFlowViewModel
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.screens.profile.ServerCheck
import com.meldiq.android.ui.screens.profile.checkServer
import com.meldiq.android.ui.screens.profile.hostOf
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The steps of signing up or in. [depth] orders them for the slide direction. */
internal enum class AuthStep(val depth: Int) {
    Welcome(0), SignUp(1), LogIn(1), Restore(2), Link(2);

    /** Where back goes (unit-tested in `AuthFlowTest`); null on the first screen, where back leaves the app. */
    val back: AuthStep?
        get() = when (this) {
            Welcome -> null
            SignUp, LogIn -> Welcome
            Restore, Link -> LogIn
        }
}

/** How many taps on the Meldiq lockup turn developer options on or off. */
private const val DEVELOPER_TAPS = 7

/**
 * Signed out: welcome, sign-up and the two ways to sign in, in the ivory palette whatever the app theme. The steps
 * share their state while the flow is shown, so going back and forth keeps what was typed. [gateway] stands in for
 * the account calls in tests; the app passes none and uses the session's own.
 */
@Composable
fun OnboardingFlow(pendingInvite: String?, gateway: AuthGateway? = null) {
    val container = LocalContainer.current
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val auth = remember(container, gateway) { gateway ?: SessionAuthGateway(container.session) }
    val signUp = containerViewModel("onboarding.signup") { SignUpViewModel(auth, it.settings.current.serverUrl) }
    val restore = containerViewModel("onboarding.restore") { RestoreViewModel(auth) }
    val link = containerViewModel("onboarding.link") { LinkDeviceViewModel(auth) }
    val signingUp by signUp.state.collectAsStateWithLifecycle()
    val restoring by restore.state.collectAsStateWithLifecycle()
    var step by rememberSaveable { mutableStateOf(AuthStep.Welcome) }
    var showServer by remember { mutableStateOf(false) }
    // Orbit 2.0: a server with email-and-password accounts gets the new sign-up and sign-in, which take over from the
    // welcome screen. A phone already part-way through (a code to enter, keys to set up, signed out) goes straight there.
    // Older servers keep the steps below until they are updated.
    val accountPhase by container.accounts.phase.collectAsStateWithLifecycle()
    val serverAccounts by produceState<ServerAccounts?>(null, settings.serverUrl) {
        value = runCatching { container.session.serverInfo(settings.serverUrl) }.getOrNull()?.let {
            ServerAccounts(v2 = it.features.orEmpty().contains("accounts-v2"), inviteOnly = it.registration == "invite")
        }
    }
    val accountsV2 = accountPhase !is AccountPhase.None || serverAccounts?.v2 == true
    var inAccountFlow by rememberSaveable { mutableStateOf(accountPhase !is AccountPhase.None) }
    val accountFlow = accountFlowViewModel()
    val flowScope = rememberCoroutineScope()
    // A tap before the server has answered asks it first, so nobody starts a legacy sign-up on an Orbit 2.0 server.
    val openFlow: (AccountStep, AuthStep) -> Unit = { v2Step, legacyStep ->
        flowScope.launch {
            val v2 = accountsV2 || runCatching { container.session.serverInfo(settings.serverUrl) }.getOrNull()?.features.orEmpty().contains("accounts-v2")
            if (v2) {
                accountFlow.goTo(v2Step)
                inAccountFlow = true
            } else step = legacyStep
        }
    }
    var brandTaps by remember { mutableIntStateOf(0) }
    // People join the Meldiq network without choosing a server. The server setup is for testing and self-hosting:
    // shown in test builds, with developer options on, or when this phone already uses another server.
    val serverSetup = OnboardingRules.showServerSetup(settings.developerMode, settings.serverUrl)
    val busy = signingUp.submitting || restoring.submitting

    // Back walks the steps; while keys are being made or an account is being restored it waits (leaving mid-way
    // could leave a half-registered account behind).
    BackHandler(enabled = step.back != null) { if (!busy) step.back?.let { step = it } }

    run {
        // First run: a few pages on what Meldiq does, once, before Welcome (round 6).
        if (!settings.introSeen && step == AuthStep.Welcome && !inAccountFlow) {
            IntroScreen(onDone = { container.settings.update { it.copy(introSeen = true) } })
            return@run
        }
        if (inAccountFlow && accountsV2) {
            Box(Modifier.fillMaxSize().background(Griip.colors.background)) {
                AccountOnboarding(serverSetup, serverAccounts?.inviteOnly == true, onExit = { inAccountFlow = false; step = AuthStep.Welcome }, onServer = { showServer = true })
            }
            if (showServer) ServerSheet { showServer = false }
            return@run
        }
        Box(Modifier.fillMaxSize().background(Griip.colors.background)) {
            AnimatedContent(step, transitionSpec = { stepTransition(initialState, targetState) }, label = "onboarding") { s ->
                val back = { s.back?.let { step = it } ?: Unit }
                when (s) {
                    AuthStep.Welcome -> WelcomeScreen(
                        showServer = serverSetup,
                        onBrandTap = {
                            if (++brandTaps >= DEVELOPER_TAPS) {
                                brandTaps = 0
                                container.settings.update { it.copy(developerMode = !it.developerMode) }
                            }
                        },
                        onSignUp = { openFlow(AccountStep.SignUp, AuthStep.SignUp) },
                        onLogIn = { openFlow(AccountStep.LogIn, AuthStep.LogIn) },
                        onServer = { showServer = true },
                    )
                    AuthStep.SignUp -> SignUpScreen(signUp, settings.serverUrl, serverSetup, onBack = back, onServer = { showServer = true }, onLogIn = { step = AuthStep.LogIn })
                    AuthStep.LogIn -> LogInScreen(
                        serverSetup, onBack = back, onServer = { showServer = true },
                        onLink = { step = AuthStep.Link }, onRestore = { step = AuthStep.Restore }, onSignUp = { step = AuthStep.SignUp },
                    )
                    AuthStep.Restore -> RestoreScreen(restore, settings.serverUrl, onBack = back)
                    AuthStep.Link -> LinkDeviceScreen(link, settings.serverUrl, onBack = back)
                }
            }
        }
        if (showServer) ServerSheet { showServer = false }
    }
}

/** What the chosen server says about Orbit 2.0 accounts (null while it hasn't answered). */
private data class ServerAccounts(val v2: Boolean, val inviteOnly: Boolean)

/** Deeper steps slide in from the end, going back slides the other way; both cross-fade. */
private fun stepTransition(from: AuthStep, to: AuthStep): ContentTransform {
    val forward = to.depth >= from.depth
    val shift = { full: Int -> (full / 8) * (if (forward) 1 else -1) }
    return (fadeIn(tween(Motion.STANDARD)) + slideInHorizontally(tween(Motion.STANDARD)) { shift(it) }) togetherWith
        (fadeOut(tween(Motion.QUICK)) + slideOutHorizontally(tween(Motion.STANDARD)) { -shift(it) })
}

@Composable
fun ServerSheet(onDismiss: () -> Unit) {
    val c = Griip.colors
    val container = LocalContainer.current
    val app = LocalContext.current.applicationContext as GriipApp
    val scope = rememberCoroutineScope()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    var url by remember { mutableStateOf(settings.serverUrl) }
    var status by remember { mutableStateOf<ServerCheck?>(null) }
    var busy by remember { mutableStateOf(false) }
    val parsed = ServerAddress.parse(url, allowCleartext = BuildConfig.DEBUG).getOrNull()
    var others by remember { mutableStateOf<List<GriipApp.ProfileSummary>>(emptyList()) }
    LaunchedEffect(Unit) { others = withContext(Dispatchers.IO) { app.profileSummaries().filterNot { it.active } } }
    GlassSheet(onDismiss, title = stringResource(R.string.server_title)) {
        Text(stringResource(R.string.server_body), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(16.dp))
        GriipTextField(url, { url = it.trim(); status = null }, stringResource(R.string.server_address), placeholder = "https://msg.example.com", leadingIcon = Icons.Outlined.Dns)
        status?.let {
            Spacer(Modifier.height(10.dp))
            StatusBanner(it.message, if (it.ok) BannerKind.Success else BannerKind.Error)
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            PillButton(stringResource(R.string.server_test), {
                busy = true
                scope.launch {
                    status = checkServer(container.session, url)
                    busy = false
                }
            }, Modifier.weight(1f), tone = ButtonTone.Glass, loading = busy, height = 50.dp)
            PillButton(stringResource(R.string.server_save), { parsed?.let { p -> container.settings.update { it.copy(serverUrl = p.url) } }; onDismiss() }, Modifier.weight(1f), showKnob = false, height = 50.dp,
                enabled = parsed != null)
        }
        if (others.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            Text(stringResource(R.string.server_others), style = Griip.type.label, color = c.textSecondary)
            Spacer(Modifier.height(4.dp))
            others.forEach { p ->
                MenuRow(
                    Icons.Outlined.Dns, hostOf(p.serverUrl),
                    subtitle = p.username?.let { stringResource(R.string.server_switch_back, it) } ?: stringResource(R.string.server_not_signed_in),
                    tint = c.textSecondary, tintBg = c.surfaceVariant, onClick = { onDismiss(); app.switchProfile(p.id) },
                )
            }
        }
    }
}

@Composable
fun RevokedScreen(reason: String) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), verticalArrangement = Arrangement.Center) {
        EmptyState(
            Icons.Outlined.Badge, "This device was signed out", "$reason. For your security, local data on this phone should be erased before you continue.",
            action = "Erase & start over", onAction = { (ctx.applicationContext as GriipApp).eraseEverything() }, tint = Griip.colors.danger,
            art = com.meldiq.android.R.drawable.meldling_confused,
        )
    }
}

/** Onboarding rules (unit-tested in `OnboardingRulesTest`). */
object OnboardingRules {
    /** The server choice is hidden from ordinary sign-up; test builds, developer options or another server show it. */
    fun showServerSetup(developerMode: Boolean, serverUrl: String, debugBuild: Boolean = com.meldiq.android.BuildConfig.DEBUG): Boolean =
        debugBuild || developerMode || !ServerAddress.same(serverUrl, com.meldiq.android.BuildConfig.DEFAULT_SERVER_URL)
}
