package com.meldiq.android.ui.screens.account

import androidx.compose.material.icons.outlined.Key
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.rounded.Email
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Pin
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.account.AccountRules
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.screens.onboarding.AuthErrorBanner
import com.meldiq.android.ui.screens.onboarding.AuthScaffold
import com.meldiq.android.ui.screens.onboarding.AuthSwitchLink
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** The main action of a step, pinned above the keyboard. */
@Composable
internal fun StepButton(label: String, busyLabel: String, state: AccountFormState, enabled: Boolean, onClick: () -> Unit) {
    PillButton(
        if (state.submitting) busyLabel else label, onClick = onClick, enabled = enabled || state.submitting, loading = state.submitting,
        modifier = Modifier.fillMaxWidth(), height = 56.dp,
    )
}

@Composable
internal fun EmailField(state: AccountFormState, vm: AccountFlowViewModel, imeAction: ImeAction = ImeAction.Next, enabled: Boolean = true) {
    GriipTextField(
        state.email, { v -> vm.edit { it.copy(email = v.trim().take(AccountRules.EMAIL_MAX)) } }, stringResource(R.string.acct_email),
        placeholder = stringResource(R.string.acct_email_hint), leadingIcon = Icons.Rounded.Email, shape = Shapes.field,
        enabled = enabled && !state.submitting,
        error = if (state.email.isNotEmpty() && !state.emailValid) stringResource(R.string.acct_email_invalid) else null,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Email, imeAction = imeAction),
    )
}

/** A password field with a show/hide button. [issue] is shown under it (new passwords only). */
@Composable
internal fun PasswordField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    issue: AccountRules.PasswordIssue? = null,
    helper: String? = null,
    imeAction: ImeAction = ImeAction.Done,
    onDone: () -> Unit = {},
) {
    var shown by rememberSaveable { mutableStateOf(false) }
    GriipTextField(
        value, { onChange(it.take(AccountRules.PASSWORD_MAX * 2)) }, label,
        leadingIcon = Icons.Rounded.Lock, shape = Shapes.field, enabled = enabled,
        helper = helper, error = issue?.let { passwordIssueText(it) },
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = imeAction),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        trailing = {
            CircleIconButton(
                if (shown) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                stringResource(if (shown) R.string.acct_password_hide else R.string.acct_password_show), { shown = !shown },
            )
        },
    )
}

@Composable
internal fun passwordIssueText(issue: AccountRules.PasswordIssue): String = when (issue) {
    AccountRules.PasswordIssue.TooShort -> stringResource(R.string.acct_password_short, AccountRules.PASSWORD_MIN)
    AccountRules.PasswordIssue.TooLong -> stringResource(R.string.acct_password_long, AccountRules.PASSWORD_MAX)
    AccountRules.PasswordIssue.SameAsEmail -> stringResource(R.string.acct_password_email)
}

@Composable
internal fun FormProblems(state: AccountFormState) {
    state.notice?.let {
        Spacer(Modifier.height(Space.md))
        StatusBanner(noticeText(it), BannerKind.Success)
    }
    state.error?.let {
        Spacer(Modifier.height(Space.md))
        AuthErrorBanner(it)
    }
}

@Composable
private fun noticeText(n: AccountNotice): String = when (n) {
    AccountNotice.CodeResent -> stringResource(R.string.acct_code_resent)
    AccountNotice.ResetCodeSent -> stringResource(R.string.acct_reset_sent)
    AccountNotice.PasswordChanged -> stringResource(R.string.acct_password_changed)
    AccountNotice.AccountRecovered -> stringResource(R.string.recover_done)
}

/** Name, email and password; an invitation code only when the server asks for one. */
@Composable
internal fun SignUpEmailScreen(vm: AccountFlowViewModel, state: AccountFormState, showServer: Boolean, inviteOnly: Boolean, onBack: () -> Unit, onServer: () -> Unit) {
    val focus = LocalFocusManager.current
    AuthScaffold(
        title = stringResource(R.string.acct_signup_title), subtitle = stringResource(R.string.acct_signup_subtitle),
        onBack = onBack, backEnabled = !state.submitting,
        actions = { if (showServer) CircleIconButton(Icons.Outlined.Dns, stringResource(R.string.auth_server_settings), onServer) },
        bottomBar = {
            StepButton(stringResource(R.string.acct_signup_submit), stringResource(R.string.acct_working), state, state.canSignUp) { focus.clearFocus(); vm.signUp() }
            AuthSwitchLink(stringResource(R.string.acct_have_account), stringResource(R.string.acct_login_submit), { vm.goTo(AccountStep.LogIn) })
        },
    ) {
        GriipTextField(
            state.name, { v -> vm.edit { it.copy(name = AccountRules.cleanName(v)) } }, stringResource(R.string.acct_name),
            placeholder = stringResource(R.string.acct_name_hint), leadingIcon = Icons.Rounded.Person, shape = Shapes.field, enabled = !state.submitting,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
        )
        Spacer(Modifier.height(Space.lg))
        EmailField(state, vm)
        Spacer(Modifier.height(Space.lg))
        PasswordField(
            state.password, { v -> vm.edit { it.copy(password = v) } }, stringResource(R.string.acct_password), !state.submitting,
            issue = state.passwordIssue, helper = stringResource(R.string.acct_password_rule, AccountRules.PASSWORD_MIN),
            imeAction = if (inviteOnly) ImeAction.Next else ImeAction.Done, onDone = { if (state.canSignUp) vm.signUp() },
        )
        if (inviteOnly) {
            Spacer(Modifier.height(Space.lg))
            GriipTextField(
                state.inviteCode, { v -> vm.edit { it.copy(inviteCode = v.uppercase().filter { c -> c.isLetterOrDigit() || c == '-' }.take(40)) } },
                stringResource(R.string.acct_invite), leadingIcon = Icons.Rounded.Key, shape = Shapes.field, enabled = !state.submitting,
                helper = stringResource(R.string.acct_invite_help),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            )
        }
        FormProblems(state)
    }
}

/**
 * Email and password, and one quiet "Having trouble signing in?" link. The ways back in (password reset, a recovery
 * code for a lost email, moving a legacy account) open only from that link, in a sheet (docs/product/MELDIQ_AUTH_FLOW_AUDIT.md).
 */
@Composable
internal fun LogInEmailScreen(
    vm: AccountFlowViewModel,
    state: AccountFormState,
    showServer: Boolean,
    onBack: () -> Unit,
    onServer: () -> Unit,
    onOtherAccount: (() -> Unit)?,
    allowLegacyEntry: Boolean = true,
    onStartOver: (() -> Unit)? = null,
    canGoBack: Boolean = true,
    /** "Lost access to your email?": not during a legacy move (that account has no recovery codes yet). */
    allowRecovery: Boolean = true,
) {
    val focus = LocalFocusManager.current
    var help by rememberSaveable { mutableStateOf(false) }
    AuthScaffold(
        title = stringResource(R.string.acct_login_title), subtitle = stringResource(R.string.acct_login_subtitle),
        onBack = onBack, backEnabled = canGoBack && !state.submitting,
        actions = { if (showServer) CircleIconButton(Icons.Outlined.Dns, stringResource(R.string.auth_server_settings), onServer) },
        bottomBar = {
            StepButton(stringResource(R.string.acct_login_submit), stringResource(R.string.acct_working), state, state.canLogIn) { focus.clearFocus(); vm.logIn() }
            AuthSwitchLink(stringResource(R.string.acct_new_here), stringResource(R.string.acct_signup_submit), { vm.goTo(AccountStep.SignUp) })
        },
    ) {
        state.signedOutReason?.let {
            StatusBanner(it, BannerKind.Info)
            Spacer(Modifier.height(Space.lg))
        }
        EmailField(state, vm)
        Spacer(Modifier.height(Space.lg))
        PasswordField(state.password, { v -> vm.edit { it.copy(password = v) } }, stringResource(R.string.acct_password), !state.submitting, onDone = { if (state.canLogIn) vm.logIn() })
        Spacer(Modifier.height(Space.sm))
        AuthHelpLink(stringResource(R.string.auth_help_signin_link), { help = true }, Modifier.align(Alignment.End))
        FormProblems(state)
        // 2026-10-23: passkeys sign in without the password (docs/PASSKEYS.md). Shown only when the server's info offers
        // them (API 0.30.0), as on Meldiq Web.
        if (passkeysOffered()) {
            val ctx = androidx.compose.ui.platform.LocalContext.current
            Spacer(Modifier.height(Space.md))
            com.meldiq.android.ui.components.PillButton(
                stringResource(R.string.ux_passkey_sign_in), { focus.clearFocus(); vm.logInWithPasskey { json -> PasskeyPrompt.get(ctx, json) } },
                Modifier.fillMaxWidth(), enabled = !state.submitting, tone = com.meldiq.android.ui.components.ButtonTone.Glass,
                leadingIcon = androidx.compose.material.icons.Icons.Outlined.Key, showKnob = false,
            )
        }
        if (onOtherAccount != null) {
            Spacer(Modifier.height(Space.md))
            AuthSwitchLink(stringResource(R.string.acct_other_q), stringResource(R.string.acct_other_action), onOtherAccount)
        }
        if (onStartOver != null) {
            Spacer(Modifier.height(Space.md))
            AuthSwitchLink(stringResource(R.string.acct_wrong_email_q), stringResource(R.string.acct_start_over), onStartOver)
        }
    }
    if (help) {
        AccountHelpSheet(
            title = stringResource(R.string.auth_help_signin_title), body = stringResource(R.string.auth_help_signin_body),
            options = signInHelpOptions(allowRecovery, allowLegacyEntry), backLabel = stringResource(R.string.auth_help_back_signin),
            onChoose = vm::goTo, onDismiss = { help = false },
        )
    }
}

/** The 6-digit code from the verification email. */
@Composable
internal fun VerifyEmailScreen(vm: AccountFlowViewModel, state: AccountFormState, onBack: () -> Unit, onUseAnotherEmail: (() -> Unit)? = onBack) {
    val focus = LocalFocusManager.current
    AuthScaffold(
        title = stringResource(R.string.acct_verify_title), subtitle = stringResource(R.string.acct_verify_subtitle, state.email),
        onBack = onBack, backEnabled = !state.submitting,
        bottomBar = {
            StepButton(stringResource(R.string.acct_verify_submit), stringResource(R.string.acct_working), state, state.canVerify) { focus.clearFocus(); vm.verify() }
            AuthSwitchLink(stringResource(R.string.acct_no_code), stringResource(R.string.acct_resend), vm::resendCode)
        },
    ) {
        GriipTextField(
            state.code, { v -> vm.edit { it.copy(code = AccountRules.cleanVerifyCode(v)) } }, stringResource(R.string.acct_code),
            placeholder = "123456", leadingIcon = Icons.Rounded.Pin, shape = Shapes.field, enabled = !state.submitting,
            textStyle = Griip.type.title.copy(fontFamily = FontFamily.Monospace),
            helper = stringResource(R.string.acct_code_help),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = if (state.verifyNeedsPassword) ImeAction.Next else ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (state.canVerify) vm.verify() }),
        )
        if (state.verifyNeedsPassword) {
            Spacer(Modifier.height(Space.lg))
            PasswordField(
                state.password, { v -> vm.edit { it.copy(password = v) } }, stringResource(R.string.acct_password), !state.submitting,
                helper = stringResource(R.string.acct_verify_password_help), onDone = { if (state.canVerify) vm.verify() },
            )
        }
        FormProblems(state)
        if (onUseAnotherEmail != null) {
            Spacer(Modifier.height(Space.md))
            AuthSwitchLink(stringResource(R.string.acct_wrong_email_q), stringResource(R.string.acct_wrong_email), onUseAnotherEmail)
        }
    }
}

@Composable
internal fun ForgotPasswordScreen(vm: AccountFlowViewModel, state: AccountFormState, onBack: () -> Unit) {
    AuthScaffold(
        title = stringResource(R.string.acct_forgot_title), subtitle = stringResource(R.string.acct_forgot_subtitle),
        onBack = onBack, backEnabled = !state.submitting,
        bottomBar = { StepButton(stringResource(R.string.acct_forgot_submit), stringResource(R.string.acct_working), state, state.canSendReset, vm::sendReset) },
    ) {
        EmailField(state, vm, imeAction = ImeAction.Done)
        FormProblems(state)
    }
}

/** Two-step sign-in (API 0.46.0): the password was right; the authenticator app's code or a backup code signs in. */
@Composable
internal fun TwoStepScreen(vm: AccountFlowViewModel, state: AccountFormState, onBack: () -> Unit) {
    val focus = LocalFocusManager.current
    AuthScaffold(
        title = stringResource(R.string.wp_2fa_title), subtitle = stringResource(R.string.wp_2fa_subtitle),
        onBack = onBack, backEnabled = !state.submitting,
        bottomBar = { StepButton(stringResource(R.string.wp_2fa_submit), stringResource(R.string.acct_working), state, state.canTwoStep) { focus.clearFocus(); vm.logInWithCode() } },
    ) {
        GriipTextField(
            state.twoStepCode, { v -> vm.edit { it.copy(twoStepCode = v.take(TWO_STEP_FIELD_MAX)) } }, stringResource(R.string.wp_2fa_code),
            placeholder = "123456", leadingIcon = Icons.Rounded.Pin, shape = Shapes.field, enabled = !state.submitting,
            textStyle = Griip.type.body.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (state.canTwoStep) vm.logInWithCode() }),
        )
        FormProblems(state)
    }
}

/** Long enough for a backup code typed with spaces. */
private const val TWO_STEP_FIELD_MAX = 16

@Composable
internal fun ResetPasswordScreen(vm: AccountFlowViewModel, state: AccountFormState, onBack: () -> Unit) {
    val focus = LocalFocusManager.current
    AuthScaffold(
        title = stringResource(R.string.acct_reset_title), subtitle = stringResource(R.string.acct_reset_subtitle, state.email),
        onBack = onBack, backEnabled = !state.submitting,
        bottomBar = { StepButton(stringResource(R.string.acct_reset_submit), stringResource(R.string.acct_working), state, state.canReset) { focus.clearFocus(); vm.resetPassword() } },
    ) {
        GriipTextField(
            state.code, { v -> vm.edit { it.copy(code = AccountRules.cleanResetCode(v)) } }, stringResource(R.string.acct_reset_code),
            placeholder = "ABCDE-FGHJK", leadingIcon = Icons.Rounded.Pin, shape = Shapes.field, enabled = !state.submitting,
            textStyle = Griip.type.body.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
        )
        Spacer(Modifier.height(Space.lg))
        PasswordField(
            state.newPassword, { v -> vm.edit { it.copy(newPassword = v) } }, stringResource(R.string.acct_new_password), !state.submitting,
            issue = state.newPasswordIssue, helper = stringResource(R.string.acct_password_rule, AccountRules.PASSWORD_MIN),
            onDone = { if (state.canReset) vm.resetPassword() },
        )
        FormProblems(state)
    }
}
