package com.meldiq.android.ui.screens.account

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.data.account.MigrationWindow
import com.meldiq.android.di.AppContainer
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion

/** What the signed-in app shows before its main screens. */
internal enum class GateScreen { RecoveryKey, LegacyMove, WorkspaceStart, App }

/**
 * Between signing in and the main screens (docs/ORBIT_2_ARCHITECTURE §3–5):
 * - a new encryption identity's recovery key, shown once;
 * - on a new account, the choice of how to start (personal, create an organisation, join one);
 * - on a recognised legacy installation, the move to an email-and-password account (it can wait while the server still
 *   accepts the old sign-in and doesn't require it: [MigrationWindow]).
 * [content] is the app; it gets "" as an invitation to open when the person chose to join an organisation.
 */
@Composable
fun AccountGate(container: AppContainer, content: @Composable (joinRequested: String?) -> Unit) {
    val recoveryKey by container.accounts.newRecoveryKey.collectAsStateWithLifecycle()
    val chooseWorkspace by container.accounts.startChoice.collectAsStateWithLifecycle()
    val phase by container.accounts.phase.collectAsStateWithLifecycle()
    var joinRequested by rememberSaveable { mutableStateOf<String?>(null) }
    var legacyLater by rememberSaveable { mutableStateOf(false) }
    // The server's migration window: whether moving is offered, and whether it can wait.
    val window by produceState<MigrationWindow?>(null, container) {
        value = runCatching { container.session.serverInfo(container.session.serverUrl) }.getOrNull()?.let {
            MigrationWindow.of(it.features, it.accounts)
        }
    }
    // A moved account whose phone still runs on its legacy session (the app stopped between the code and signing in):
    // it signs in once more with its own device key to finish.
    val finishing = phase is AccountPhase.SignedOut && container.accounts.record?.deviceId == container.session.current?.deviceId
    // "Later" holds while the server still accepts the old sign-in, whatever step the move had reached.
    val waiting = legacyLater && window?.canWait == true
    val moving = !waiting && (phase is AccountPhase.AwaitingVerification || finishing || (container.legacyMigration.recognizedInstall && window?.open == true))

    val screen = when {
        recoveryKey != null -> GateScreen.RecoveryKey
        moving -> GateScreen.LegacyMove
        chooseWorkspace -> GateScreen.WorkspaceStart
        else -> GateScreen.App
    }
    // System Back on these steps must not close the app: the recovery key waits for "I've saved it", the start choice
    // falls back to the personal workspace, and the move waits ("Later") or starts again (LegacyMoveFlow).
    BackHandler(enabled = screen == GateScreen.RecoveryKey) { }
    AnimatedContent(screen, transitionSpec = { fadeIn(tween(Motion.STANDARD)) togetherWith fadeOut(tween(Motion.QUICK)) }, label = "gate") { s ->
        when (s) {
            GateScreen.App -> content(joinRequested)
            GateScreen.RecoveryKey -> GateFrame { RecoveryKeySaveScreen(recoveryKey.orEmpty(), onSaved = container.accounts::recoveryKeyShown) }
            GateScreen.WorkspaceStart -> WorkspaceStartScreen(onDone = { join -> joinRequested = join; container.accounts.startChoiceMade() })
            GateScreen.LegacyMove -> GateFrame { LegacyMoveFlow(container, canWait = window?.canWait == true, onLater = { legacyLater = true }) }
        }
    }
}

/** The account steps come after sign-in; like every screen they follow the app's theme and colour preset. */
@Composable
private fun GateFrame(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Griip.colors.background)) { content() }
}

/** A recognised installation moving its account: the shared account flow, started at the legacy step with this phone's username. */
@Composable
private fun LegacyMoveFlow(container: AppContainer, canWait: Boolean, onLater: () -> Unit) {
    val vm = accountFlowViewModel()
    val state by vm.form.collectAsStateWithLifecycle()
    val username = container.legacyMigration.recognizedUsername
    LaunchedEffect(username) {
        if (username != null && vm.form.value.step !in setOf(AccountStep.LegacyDetails, AccountStep.Verify)) {
            vm.edit { it.copy(legacyUsername = username) }
            vm.goTo(AccountStep.LegacyCredentials)
        }
    }
    val later = if (canWait) onLater else null
    // A mistyped address (or mail that never comes) mustn't trap anyone: start the move again; the server lets it be redone.
    val startOver = {
        container.accounts.abandonPending()
        vm.edit { it.copy(legacyUsername = container.legacyMigration.recognizedUsername.orEmpty()) }
        vm.goTo(AccountStep.LegacyCredentials)
    }
    BackHandler {
        when (state.step) {
            AccountStep.LegacyDetails -> vm.goTo(AccountStep.LegacyCredentials)
            AccountStep.Forgot -> vm.goTo(AccountStep.LogIn)
            AccountStep.Reset -> vm.goTo(AccountStep.Forgot)
            AccountStep.TwoStep -> vm.goTo(AccountStep.LogIn)
            else -> later?.invoke()
        }
    }
    when (state.step) {
        AccountStep.LegacyDetails -> LegacyDetailsScreen(vm, state, onBack = { vm.goTo(AccountStep.LegacyCredentials) })
        AccountStep.Verify -> VerifyEmailScreen(vm, state, onBack = { later?.invoke() ?: startOver() }, onUseAnotherEmail = startOver)
        AccountStep.LogIn, AccountStep.Forgot, AccountStep.Reset, AccountStep.TwoStep -> FinishMoveSignIn(vm, state, onLater = later, onStartOver = startOver)
        // A required move (no "Later") has nowhere to go back to: the arrow is shown disabled.
        else -> LegacyCredentialsScreen(vm, state, recognizedUsername = username, onBack = { later?.invoke() }, onLater = later, canGoBack = later != null)
    }
}

/** The move's last step after an interruption: sign in with the new email and password (this phone's device key goes along). */
@Composable
private fun FinishMoveSignIn(vm: AccountFlowViewModel, state: AccountFormState, onLater: (() -> Unit)?, onStartOver: () -> Unit) {
    when (state.step) {
        AccountStep.Forgot -> ForgotPasswordScreen(vm, state, onBack = { vm.goTo(AccountStep.LogIn) })
        AccountStep.Reset -> ResetPasswordScreen(vm, state, onBack = { vm.goTo(AccountStep.Forgot) })
        AccountStep.TwoStep -> TwoStepScreen(vm, state, onBack = { vm.goTo(AccountStep.LogIn) })
        else -> LogInEmailScreen(
            vm, state, showServer = false, onBack = { onLater?.invoke() }, onServer = {}, onOtherAccount = null,
            allowLegacyEntry = false, onStartOver = onStartOver, canGoBack = onLater != null, allowRecovery = false,
        )
    }
}
