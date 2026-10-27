package com.meldiq.android.ui.screens.account

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.data.account.AccountRepository
import com.meldiq.android.data.account.AccountRules
import com.meldiq.android.data.account.LegacyMigration
import com.meldiq.android.data.account.LegacyTicket
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.ui.screens.onboarding.AuthError
import com.meldiq.android.ui.screens.onboarding.AuthErrors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The steps of Orbit 2.0 sign-up and sign-in. [back] is where Back goes (null: back to the welcome screen). */
enum class AccountStep {
    SignUp, LogIn, Verify, Forgot, Reset, DeviceSetup, RestoreKey, Link, StartFresh, LegacyCredentials, LegacyDetails,
    /** Lost the account's email: its address, a recovery code and the new address. */
    Recover,
    /** The code sent to the new address, and a new password. */
    RecoverConfirm,
    /** A new phone unlocks the key backup with an emailed code and the password (docs/KEY_BACKUP.md). */
    EmailUnlock,
    /** Two-step sign-in (API 0.46.0): the password was right; the authenticator app's code or a backup code. */
    TwoStep;

    val back: AccountStep?
        get() = when (this) {
            SignUp, LogIn -> null
            Verify -> null
            Forgot -> LogIn
            Reset -> Forgot
            DeviceSetup, EmailUnlock -> null
            RestoreKey, Link, StartFresh -> DeviceSetup
            LegacyCredentials -> LogIn
            LegacyDetails -> LegacyCredentials
            Recover -> LogIn
            RecoverConfirm -> Recover
            TwoStep -> LogIn
        }

    /** Steps the account's phase decides; the person can't wander off them with Back. */
    val pinned: Boolean get() = this == Verify || this == DeviceSetup || this == EmailUnlock
}

/** The server's answer to a right password when the account has two-step sign-in on (docs/ACCOUNT_SAFETY.md). */
private const val TWO_STEP_REQUIRED = "totp_required"

/** A confirmation shown above a form. */
enum class AccountNotice { CodeResent, ResetCodeSent, PasswordChanged, AccountRecovered }

data class AccountFormState(
    val step: AccountStep = AccountStep.LogIn,
    val name: String = "",
    val email: String = "",
    val password: String = "",
    val inviteCode: String = "",
    val code: String = "",
    val newPassword: String = "",
    val legacyUsername: String = "",
    val recoveryKey: String = "",
    /** Account recovery: one of the account's recovery codes, and the address to move it to. */
    val recoveryCode: String = "",
    val newEmail: String = "",
    val submitting: Boolean = false,
    val error: AuthError? = null,
    val notice: AccountNotice? = null,
    /** Why the last session ended (shown on the sign-in step), from the server. */
    val signedOutReason: String? = null,
    /** The code step needs the password again (the app was restarted since it was typed). */
    val verifyNeedsPassword: Boolean = false,
    /** Device setup: whether the account has a key backup for its current password (null: not known yet). */
    val keyBackup: Boolean? = null,
    /** Device setup: the server is being asked about the key backup (null [keyBackup] after it: couldn't say). */
    val keyBackupChecking: Boolean = false,
    /** Where the unlock code went (masked), and whether the unlock step needs the password typed again. */
    val unlockSentTo: String? = null,
    val unlockNeedsPassword: Boolean = false,
    /** Two-step sign-in: the code typed on the [AccountStep.TwoStep] step. */
    val twoStepCode: String = "",
) {
    val passwordIssue: AccountRules.PasswordIssue? get() = if (password.isEmpty()) null else AccountRules.passwordIssue(password, email)
    val newPasswordIssue: AccountRules.PasswordIssue? get() = if (newPassword.isEmpty()) null else AccountRules.passwordIssue(newPassword, email)
    val emailValid: Boolean get() = AccountRules.isEmail(email)

    val canSignUp get() = !submitting && name.isNotBlank() && emailValid && password.isNotEmpty() && passwordIssue == null
    val canLogIn get() = !submitting && emailValid && password.isNotEmpty()
    val canVerify get() = !submitting && AccountRules.isVerifyCode(code) && (!verifyNeedsPassword || password.isNotEmpty())
    val canSendReset get() = !submitting && emailValid
    val canReset get() = !submitting && AccountRules.isResetCode(code) && newPassword.isNotEmpty() && newPasswordIssue == null
    val canRestore get() = !submitting && recoveryKey.length >= MIN_RECOVERY_KEY
    val canStartFresh get() = !submitting && password.isNotEmpty()
    val canUnlock get() = !submitting && AccountRules.isVerifyCode(code) && (!unlockNeedsPassword || password.isNotEmpty())
    val canLegacyVerify get() = !submitting && legacyUsername.length >= MIN_USERNAME && recoveryKey.length >= MIN_RECOVERY_KEY
    val canLegacyComplete get() = canSignUp
    val newEmailValid: Boolean get() = AccountRules.isEmail(newEmail) && AccountRules.normalizeEmail(newEmail) != AccountRules.normalizeEmail(email)
    val recoverPasswordIssue: AccountRules.PasswordIssue? get() = if (newPassword.isEmpty()) null else AccountRules.passwordIssue(newPassword, newEmail)
    val canRecover get() = !submitting && emailValid && com.meldiq.android.data.account.RecoveryRules.isCode(recoveryCode) && newEmailValid
    val canTwoStep get() = !submitting && password.isNotEmpty() && com.meldiq.android.data.account.TwoStepRules.isCode(twoStepCode)
    val canRecoverConfirm get() = !submitting && AccountRules.isVerifyCode(code) && newPassword.isNotEmpty() && recoverPasswordIssue == null

    companion object {
        const val MIN_USERNAME = 3
        /** Shorter than any recovery key; the key itself is checked when decoded. */
        const val MIN_RECOVERY_KEY = 20
    }
}

/**
 * Orbit 2.0 sign-up and sign-in, as one flow so the steps share what was typed (docs/ORBIT_2_ARCHITECTURE §2–5). The
 * account's phase moves it on its own: after sign-up to the code, after sign-in to setting up encryption when needed,
 * and back to sign-in when a session ended. The password is kept in memory only, to sign in right after the code.
 * Unit-tested in `AccountFlowViewModelTest`.
 */
class AccountFlowViewModel(
    private val accounts: AccountRepository,
    private val migration: LegacyMigration,
    private val serverUrl: () -> String,
    start: AccountStep = AccountStep.LogIn,
    private val recovery: com.meldiq.android.data.account.RecoveryCodesApi? = null,
) : ViewModel() {
    private val _form = MutableStateFlow(AccountFormState(step = start, email = accounts.record?.email.orEmpty()))
    val form: StateFlow<AccountFormState> = _form.asStateFlow()

    private var pendingPassword: String? = null
    private var legacyTicket: LegacyTicket? = null
    /** The recovery in progress (from step one); kept in memory only. */
    private var recoveryTicket: String? = null

    init {
        viewModelScope.launch { accounts.phase.collect(::follow) }
    }

    private fun follow(phase: AccountPhase) {
        when (phase) {
            is AccountPhase.AwaitingVerification -> _form.update { it.copy(step = AccountStep.Verify, email = phase.email, verifyNeedsPassword = pendingPassword == null) }
            is AccountPhase.NeedsDeviceSetup -> {
                _form.update {
                    if (it.step in setOf(AccountStep.RestoreKey, AccountStep.Link, AccountStep.StartFresh, AccountStep.EmailUnlock)) it else it.copy(step = AccountStep.DeviceSetup)
                }
                if (_form.value.keyBackup == null) checkKeyBackup()
            }
            is AccountPhase.SignedOut -> {
                unlockCodeRequested = false
                _form.update { it.copy(step = AccountStep.LogIn, email = phase.email, signedOutReason = phase.reason, keyBackup = null, unlockSentTo = null) }
            }
            AccountPhase.None, is AccountPhase.Ready -> Unit
        }
    }

    /** Asks whether this account has a key backup to unlock with an emailed code; also "Try again" after a failure. */
    fun checkKeyBackup() {
        if (_form.value.keyBackupChecking) return
        _form.update { it.copy(keyBackupChecking = true) }
        viewModelScope.launch {
            val available = accounts.devices.backupAvailable()
            _form.update { it.copy(keyBackup = available, keyBackupChecking = false) }
            if (available == true) sendUnlockCodeOnce()
        }
    }

    private var unlockCodeRequested = false

    /**
     * With a key backup the emailed code is the way in, so it's sent without asking (the owner, 2026-10-23: no "Email me a
     * code" button). Once per sign-in: Back from the help steps returns to the code, and "Send a new one" asks again. The
     * server sends at most one code per minute and keeps the last one valid, so a quick repeat costs nothing.
     */
    private suspend fun sendUnlockCodeOnce() {
        if (unlockCodeRequested) return
        _form.first { !it.submitting }
        if (unlockCodeRequested || _form.value.step != AccountStep.DeviceSetup) return
        unlockCodeRequested = true
        startEmailUnlock()
    }

    fun goTo(step: AccountStep) = _form.update { it.copy(step = step, error = null, notice = null) }

    /** Back within the flow; false when Back should leave it (to the welcome screen). */
    fun back(): Boolean {
        val s = _form.value
        if (s.submitting) return true
        if (s.step == AccountStep.Verify) {
            if (legacyTicket != null) accounts.abandonPending() else accounts.cancelVerification()
            pendingPassword = null
            legacyTicket = null
            goTo(AccountStep.LogIn)
            return true
        }
        val to = s.step.back ?: return false
        // The help steps return to the emailed code once it was sent, not to the screen that sent it.
        goTo(if (to == AccountStep.DeviceSetup && s.unlockSentTo != null && s.keyBackup == true) AccountStep.EmailUnlock else to)
        return true
    }

    fun edit(change: (AccountFormState) -> AccountFormState) = _form.update { change(it).copy(error = null) }

    private fun run(block: suspend () -> Unit) {
        if (_form.value.submitting) return
        _form.update { it.copy(submitting = true, error = null, notice = null) }
        viewModelScope.launch {
            val error = AuthErrors.attempt(block)
            _form.update { it.copy(submitting = false, error = error) }
        }
    }

    /** Remembers [password] for the code step before [block] moves the flow there; forgets it if [block] fails. */
    private suspend fun withPendingPassword(password: String, block: suspend () -> Unit) {
        pendingPassword = password
        try {
            block()
        } catch (e: Exception) {
            if (accounts.phase.value !is AccountPhase.AwaitingVerification) pendingPassword = null
            throw e
        }
    }

    fun signUp() {
        val s = _form.value
        if (!s.canSignUp) return
        run { withPendingPassword(s.password) { accounts.register(serverUrl(), s.name, s.email, s.password, s.inviteCode) } }
    }

    fun logIn() {
        val s = _form.value
        if (!s.canLogIn) return
        run {
            try {
                accounts.login(serverUrl(), s.email, s.password)
                _form.update { it.copy(password = "", signedOutReason = null) }
            } catch (e: ApiException) {
                if (e.code == TWO_STEP_REQUIRED) {
                    _form.update { it.copy(step = AccountStep.TwoStep, twoStepCode = "") }
                    return@run
                }
                if (e.code != "email_unverified") throw e
                // Signed up earlier but never entered the code: send a fresh one and sign in right after it.
                withPendingPassword(s.password) { accounts.awaitVerification(serverUrl(), AccountRules.normalizeEmail(s.email), accounts.record?.deviceId) }
                runCatching { accounts.resendVerification() }
            }
        }
    }

    /** The second step of a sign-in with two-step on: the same email and password with the code. */
    fun logInWithCode() {
        val s = _form.value
        if (!s.canTwoStep) return
        run {
            accounts.login(serverUrl(), s.email, s.password, com.meldiq.android.data.account.TwoStepRules.clean(s.twoStepCode))
            _form.update { it.copy(password = "", twoStepCode = "", step = AccountStep.LogIn, signedOutReason = null) }
        }
    }

    /**
     * 2026-10-23: signs in with a passkey; [prompt] shows the platform's passkey prompt (docs/PASSKEYS.md). Closing the
     * prompt is not an error.
     */
    fun logInWithPasskey(prompt: suspend (String) -> String) {
        run {
            try {
                accounts.loginWithPasskey(serverUrl(), prompt)
                _form.update { it.copy(password = "", signedOutReason = null) }
            } catch (_: PasskeyPrompt.Cancelled) {
            }
        }
    }

    /**
     * The code (with the password, which the server checks too), then signing in. If the sign-in failed after the code
     * went through, trying again only signs in: the code is used up by then.
     */
    fun verify() {
        val s = _form.value
        if (!s.canVerify) return
        val password = pendingPassword ?: s.password
        run {
            if (!accounts.verified) accounts.verifyEmail(s.code, password)
            val ticket = legacyTicket
            if (ticket != null) migration.finish(serverUrl(), ticket, s.email, password) else accounts.login(serverUrl(), s.email, password)
            pendingPassword = null
            legacyTicket = null
            _form.update { it.copy(code = "", password = "", verifyNeedsPassword = false) }
        }
    }

    fun resendCode() = run {
        accounts.resendVerification()
        _form.update { it.copy(notice = AccountNotice.CodeResent) }
    }

    fun sendReset() {
        val s = _form.value
        if (!s.canSendReset) return
        run {
            accounts.forgotPassword(serverUrl(), s.email)
            _form.update { it.copy(step = AccountStep.Reset, code = "", notice = AccountNotice.ResetCodeSent) }
        }
    }

    fun resetPassword() {
        val s = _form.value
        if (!s.canReset) return
        run {
            accounts.resetPassword(serverUrl(), s.email, s.code, s.newPassword)
            _form.update { it.copy(step = AccountStep.LogIn, code = "", newPassword = "", password = "", notice = AccountNotice.PasswordChanged) }
        }
    }

    /** Recovery step one: the code is used up here and a code goes to the new address. */
    fun recover() {
        val s = _form.value
        val api = recovery ?: return
        if (!s.canRecover) return
        run {
            val res = api.start(serverUrl(), AccountRules.normalizeEmail(s.email), s.recoveryCode, AccountRules.normalizeEmail(s.newEmail))
            recoveryTicket = res.ticket
            _form.update { it.copy(step = AccountStep.RecoverConfirm, recoveryCode = "", code = "", newPassword = "") }
        }
    }

    /** Recovery step two: the account moves to the new address with the new password; then sign in with them. */
    fun recoverConfirm() {
        val s = _form.value
        val api = recovery ?: return
        val ticket = recoveryTicket ?: return goTo(AccountStep.Recover)
        if (!s.canRecoverConfirm) return
        run {
            val res = api.complete(serverUrl(), ticket, s.code, s.newPassword)
            recoveryTicket = null
            // This phone's own account: its profile now belongs to the new address (phone test: sign-in was refused).
            accounts.addressRecovered(s.email, res.email)
            _form.update {
                it.copy(step = AccountStep.LogIn, email = res.email, newEmail = "", code = "", newPassword = "", password = "", notice = AccountNotice.AccountRecovered)
            }
        }
    }

    /** Emails a code for unlocking the key backup on this phone (also "send a new one"). */
    fun startEmailUnlock() = run {
        val sent = accounts.devices.startEmailUnlock()
        val again = _form.value.step == AccountStep.EmailUnlock
        _form.update {
            it.copy(
                step = AccountStep.EmailUnlock, unlockSentTo = sent.email, unlockNeedsPassword = !accounts.devices.hasPassword,
                code = if (again) it.code else "", notice = if (again) AccountNotice.CodeResent else null,
            )
        }
    }

    /** The emailed code and the password open the key backup; this phone is then set up with the keys. */
    fun unlockWithEmail() {
        val s = _form.value
        if (!s.canUnlock) return
        run {
            accounts.devices.withEmailCode(s.code, s.password.takeIf { s.unlockNeedsPassword })
            _form.update { it.copy(code = "", password = "") }
        }
    }

    fun restoreWithKey() {
        val s = _form.value
        if (!s.canRestore) return
        run { accounts.devices.withRecoveryKey(s.recoveryKey) }
    }

    fun startFresh() {
        val s = _form.value
        if (!s.canStartFresh) return
        run {
            accounts.devices.startFresh(s.password)
            _form.update { it.copy(password = "") }
        }
    }

    fun legacyVerify() {
        val s = _form.value
        if (!s.canLegacyVerify) return
        run {
            val ticket = migration.verify(serverUrl(), s.legacyUsername, s.recoveryKey)
            legacyTicket = ticket
            _form.update { it.copy(step = AccountStep.LegacyDetails, name = it.name.ifBlank { ticket.displayName }, recoveryKey = "") }
        }
    }

    fun legacyComplete() {
        val s = _form.value
        val ticket = legacyTicket ?: return goTo(AccountStep.LegacyCredentials)
        if (!s.canLegacyComplete) return
        run { withPendingPassword(s.password) { migration.complete(serverUrl(), ticket, s.name, s.email, s.password) } }
    }
}
