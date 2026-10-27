package com.meldiq.android.ui.screens.account

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.GriipApp
import com.meldiq.android.R
import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.screens.onboarding.LinkDeviceScreen
import com.meldiq.android.ui.screens.onboarding.LinkDeviceViewModel
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion
import kotlinx.coroutines.launch

/** The account flow's view model for this container (shared by the welcome screen, which picks the first step). */
@Composable
internal fun accountFlowViewModel(): AccountFlowViewModel =
    containerViewModel("account.flow") { c -> AccountFlowViewModel(c.accounts, c.legacyMigration, { c.settings.current.serverUrl }, recovery = c.recoveryCodes) }

/**
 * Orbit 2.0 sign-up and sign-in (docs/ORBIT_2_ARCHITECTURE §2–5), inside the onboarding's ivory palette. [onExit] goes
 * back to the welcome screen. Steps the account's phase decides (the code, setting up encryption) can't be left with Back
 * except by cancelling them.
 */
@Composable
internal fun AccountOnboarding(showServer: Boolean, inviteOnly: Boolean, onExit: () -> Unit, onServer: () -> Unit) {
    val container = LocalContainer.current
    val app = LocalContext.current.applicationContext as GriipApp
    val scope = rememberCoroutineScope()
    val vm = accountFlowViewModel()
    val link = containerViewModel("account.link") { c -> LinkDeviceViewModel(AccountLinkGateway(c.session, c.accounts)) }
    val state by vm.form.collectAsStateWithLifecycle()
    val phase by container.accounts.phase.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    var confirmErase by remember { mutableStateOf(false) }
    val back = { if (!vm.back()) onExit() }
    BackHandler { back() }
    // Signing out of a half-set-up phone keeps nothing to set up: the next sign-in starts again.
    val signOut: () -> Unit = { scope.launch { container.accounts.logout() } }
    // A phone holding another account's messages offers to erase them before another account can sign in.
    val otherAccount = (phase as? AccountPhase.SignedOut)?.let { { confirmErase = true } }

    AnimatedContent(state.step, transitionSpec = { fadeIn(tween(Motion.STANDARD)) togetherWith fadeOut(tween(Motion.QUICK)) }, label = "account") { step ->
        when (step) {
            AccountStep.SignUp -> SignUpEmailScreen(vm, state, showServer, inviteOnly, onBack = back, onServer = onServer)
            AccountStep.LogIn -> LogInEmailScreen(vm, state, showServer, onBack = back, onServer = onServer, onOtherAccount = otherAccount)
            AccountStep.Verify -> VerifyEmailScreen(vm, state, onBack = back)
            AccountStep.Forgot -> ForgotPasswordScreen(vm, state, onBack = back)
            AccountStep.Reset -> ResetPasswordScreen(vm, state, onBack = back)
            AccountStep.DeviceSetup -> DeviceSetupScreen(vm, state, onSignOut = signOut)
            AccountStep.RestoreKey -> RestoreKeyScreen(vm, state, onBack = back)
            AccountStep.Link -> LinkDeviceScreen(link, settings.serverUrl, onBack = back)
            AccountStep.StartFresh -> StartFreshScreen(vm, state, onBack = back)
            AccountStep.LegacyCredentials -> LegacyCredentialsScreen(vm, state, recognizedUsername = null, onBack = back, onLater = null)
            AccountStep.LegacyDetails -> LegacyDetailsScreen(vm, state, onBack = back)
            AccountStep.Recover -> RecoverAccountScreen(vm, state, onBack = back)
            AccountStep.RecoverConfirm -> RecoverConfirmScreen(vm, state, onBack = back)
            AccountStep.EmailUnlock -> EmailUnlockScreen(vm, state, onBack = signOut)
            AccountStep.TwoStep -> TwoStepScreen(vm, state, onBack = back)
        }
    }
    if (confirmErase) {
        AlertDialog(
            onDismissRequest = { confirmErase = false },
            title = { Text(stringResource(R.string.acct_erase_title)) },
            text = { Text(stringResource(R.string.acct_erase_body)) },
            confirmButton = { TextButton(onClick = { confirmErase = false; app.eraseEverything() }) { Text(stringResource(R.string.acct_erase_confirm), color = Griip.colors.danger) } },
            dismissButton = { TextButton(onClick = { confirmErase = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    // A finished device setup hands over to the signed-in app; nothing to do here but make sure the code isn't kept.
    LaunchedEffect(phase) { if (phase is AccountPhase.Ready) vm.edit { it.copy(password = "", recoveryKey = "", code = "") } }
}
