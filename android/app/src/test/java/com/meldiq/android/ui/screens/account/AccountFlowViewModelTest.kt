package com.meldiq.android.ui.screens.account

import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.data.account.AccountRepository
import com.meldiq.android.data.account.FakeAccountApi
import com.meldiq.android.data.account.FakeAccountApi.Companion.CODE
import com.meldiq.android.data.account.FakeAccountApi.Companion.PASSWORD
import com.meldiq.android.data.account.FakeAccountApi.Companion.RESET_CODE
import com.meldiq.android.data.account.FakeAccountApi.Companion.URL
import com.meldiq.android.data.account.FakeKeyBackupApi
import com.meldiq.android.data.account.FakeKeyBackupApi.Companion.FIXED_CODE
import com.meldiq.android.data.account.FakeMessagingSession
import com.meldiq.android.data.account.LegacyMigration
import com.meldiq.android.data.account.MemoryVault
import com.meldiq.android.data.account.UnlockDelivery
import com.meldiq.android.ui.screens.onboarding.AuthError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AccountFlowViewModelTest {
    private val dispatcher = UnconfinedTestDispatcher()
    private val api = FakeAccountApi()
    private val vault = MemoryVault()
    private val session = FakeMessagingSession()
    private lateinit var accounts: AccountRepository
    private lateinit var vm: AccountFlowViewModel

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        accounts = AccountRepository(api, vault, session, deviceName = { "Phone" })
        vm = AccountFlowViewModel(accounts, LegacyMigration(api, vault, session, accounts), { URL })
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `sign-up goes to the code, and the code signs in with the password typed at sign-up`() = runTest(dispatcher) {
        vm.goTo(AccountStep.SignUp)
        vm.edit { it.copy(name = "Ada", email = "ada@example.com", password = "short") }
        assertFalse("password too short", vm.form.value.canSignUp)
        vm.edit { it.copy(password = PASSWORD) }
        vm.signUp()
        assertEquals(AccountStep.Verify, vm.form.value.step)
        vm.edit { it.copy(code = CODE) }
        vm.verify()
        assertTrue(accounts.phase.value is AccountPhase.Ready)
        assertEquals("", vm.form.value.password)
        assertEquals(null, vm.form.value.error)
    }

    @Test
    fun `after a restart the code still verifies, then the person signs in`() = runTest(dispatcher) {
        vm.goTo(AccountStep.SignUp)
        vm.edit { it.copy(name = "Ada", email = "restart@example.com", password = PASSWORD) }
        vm.signUp()
        // A new view model: the app was stopped, and the password typed at sign-up is gone with it.
        val again = AccountFlowViewModel(accounts, LegacyMigration(api, vault, session, accounts), { URL })
        assertEquals(AccountStep.Verify, again.form.value.step)
        assertTrue("the code step asks for the password again", again.form.value.verifyNeedsPassword)
        again.edit { it.copy(code = CODE) }
        assertFalse(again.form.value.canVerify)
        again.edit { it.copy(password = PASSWORD) }
        again.verify()
        assertTrue(api.accounts.getValue("restart@example.com").verified)
        assertTrue(accounts.phase.value is AccountPhase.Ready)
    }

    @Test
    fun `a sign-in that failed after the code went through only signs in when tried again`() = runTest(dispatcher) {
        vm.goTo(AccountStep.SignUp)
        vm.edit { it.copy(name = "Ada", email = "retry@example.com", password = PASSWORD) }
        vm.signUp()
        api.failNextEnroll = true
        vm.edit { it.copy(code = CODE) }
        vm.verify()
        assertTrue(vm.form.value.error != null)
        api.calls.clear()
        vm.verify()
        assertFalse("the used code isn't sent again", "verify" in api.calls)
        assertTrue(accounts.phase.value is AccountPhase.Ready)
    }

    @Test
    fun `back from the code cancels it and returns to sign-in`() = runTest(dispatcher) {
        vm.goTo(AccountStep.SignUp)
        vm.edit { it.copy(name = "Ada", email = "back@example.com", password = PASSWORD) }
        vm.signUp()
        assertTrue(vm.back())
        assertEquals(AccountStep.LogIn, vm.form.value.step)
        assertEquals(AccountPhase.None, accounts.phase.value)
    }

    @Test
    fun `a wrong password is shown as the server worded it`() = runTest(dispatcher) {
        api.verifiedAccount("grace@example.com")
        vm.edit { it.copy(email = "grace@example.com", password = "not the password") }
        vm.logIn()
        assertEquals("invalid_credentials", (vm.form.value.error as AuthError.Server).code)
        assertEquals(AccountStep.LogIn, vm.form.value.step)
    }

    @Test
    fun `two-step sign-in asks for the code after the password and signs in with it`() = runTest(dispatcher) {
        api.verifiedAccount("twostep@example.com").totpCode = "123456"
        vm.edit { it.copy(email = "twostep@example.com", password = PASSWORD) }
        vm.logIn()
        assertEquals(AccountStep.TwoStep, vm.form.value.step)
        assertEquals(null, vm.form.value.error)
        vm.edit { it.copy(twoStepCode = "12345") }
        assertFalse("five digits isn't a code", vm.form.value.canTwoStep)
        vm.edit { it.copy(twoStepCode = "654 321") }
        vm.logInWithCode()
        assertEquals("totp_invalid", (vm.form.value.error as AuthError.Server).code)
        assertEquals(AccountStep.TwoStep, vm.form.value.step)
        vm.edit { it.copy(twoStepCode = "123 456") }
        vm.logInWithCode()
        assertTrue(accounts.phase.value !is AccountPhase.None)
        assertEquals("", vm.form.value.password)
        assertEquals(AccountStep.TwoStep.back, AccountStep.LogIn)
    }

    @Test
    fun `signing in before verifying sends a new code and signs in right after it`() = runTest(dispatcher) {
        api.verifiedAccount("late@example.com").verified = false
        vm.edit { it.copy(email = "late@example.com", password = PASSWORD) }
        vm.logIn()
        assertEquals(AccountStep.Verify, vm.form.value.step)
        assertTrue("resend" in api.calls)
        vm.edit { it.copy(code = CODE) }
        vm.verify()
        assertTrue(accounts.phase.value is AccountPhase.Ready)
    }

    @Test
    fun `a new phone of an existing account lands on device setup`() = runTest(dispatcher) {
        val other = AccountRepository(api, MemoryVault(), FakeMessagingSession(), deviceName = { "Other" })
        api.verifiedAccount("two@example.com")
        other.login(URL, "two@example.com", PASSWORD)
        vm.edit { it.copy(email = "two@example.com", password = PASSWORD) }
        vm.logIn()
        assertEquals(AccountStep.DeviceSetup, vm.form.value.step)
        vm.goTo(AccountStep.RestoreKey)
        assertTrue(vm.back())
        assertEquals(AccountStep.DeviceSetup, vm.form.value.step)
    }

    @Test
    fun `password reset returns to sign-in with a confirmation`() = runTest(dispatcher) {
        api.verifiedAccount("reset@example.com")
        vm.goTo(AccountStep.Forgot)
        vm.edit { it.copy(email = "reset@example.com") }
        vm.sendReset()
        assertEquals(AccountStep.Reset, vm.form.value.step)
        assertEquals(AccountNotice.ResetCodeSent, vm.form.value.notice)
        vm.edit { it.copy(code = "abcde-fghjk", newPassword = "a brand new password") }
        assertEquals("ABCDEFGHJK", vm.form.value.code.let { com.meldiq.android.data.account.AccountRules.cleanResetCode(it) })
        vm.edit { it.copy(code = RESET_CODE) }
        vm.resetPassword()
        assertEquals(AccountStep.LogIn, vm.form.value.step)
        assertEquals(AccountNotice.PasswordChanged, vm.form.value.notice)
        assertEquals("a brand new password", api.accounts.getValue("reset@example.com").password)
    }

    @Test
    fun `a session ended elsewhere brings back sign-in with the server's reason`() = runTest(dispatcher) {
        api.verifiedAccount("ended@example.com")
        accounts.login(URL, "ended@example.com", PASSWORD)
        api.refreshFailure = com.meldiq.android.data.api.ApiException(401, "session_revoked", "You were signed out on this device.")
        accounts.refreshTokens()
        assertEquals(AccountStep.LogIn, vm.form.value.step)
        assertEquals("ended@example.com", vm.form.value.email)
        assertEquals("You were signed out on this device.", vm.form.value.signedOutReason)
    }

    /**
     * A second phone of an account made in the admin console (API 0.63.0): signed in on a first phone that backed its keys
     * up, then signed in here through the screens, which open the unlock step on their own.
     */
    private suspend fun secondPhoneOfConsoleAccount(delivery: UnlockDelivery): Pair<AccountFlowViewModel, AccountRepository> {
        val backups = FakeKeyBackupApi(api)
        api.verifiedAccount("tester@example.com")
        AccountRepository(api, MemoryVault(), FakeMessagingSession(), deviceName = { "First" }, keyBackups = backups).login(URL, "tester@example.com", PASSWORD)
        backups.delivery = delivery
        val phone = AccountRepository(api, MemoryVault(), FakeMessagingSession(), deviceName = { "Phone" }, keyBackups = backups)
        val flow = AccountFlowViewModel(phone, LegacyMigration(api, MemoryVault(), FakeMessagingSession(), phone), { URL })
        flow.goTo(AccountStep.LogIn)
        flow.edit { it.copy(email = "tester@example.com", password = PASSWORD) }
        flow.logIn()
        // Signing in makes keys off the main thread: wait for the sign-in, not just for the call.
        flow.form.first { !it.submitting && it.step != AccountStep.LogIn }
        return flow to phone
    }

    @Test
    fun `a tester's second phone asks for the fixed code and unlocks with it`() = runTest(dispatcher) {
        val (flow, phone) = secondPhoneOfConsoleAccount(UnlockDelivery.FixedCode)
        flow.form.first { it.step == AccountStep.EmailUnlock && !it.submitting }
        assertEquals(UnlockDelivery.FixedCode, flow.form.value.unlockDelivery)
        assertFalse("the code is still needed", flow.form.value.canUnlock)
        flow.edit { it.copy(code = FIXED_CODE) }
        flow.unlockWithEmail()
        phone.phase.first { it is AccountPhase.Ready }
        assertEquals(null, flow.form.value.error)
    }

    @Test
    fun `a no-code account's second phone unlocks on its own after sign-in`() = runTest(dispatcher) {
        val (flow, phone) = secondPhoneOfConsoleAccount(UnlockDelivery.None)
        phone.phase.first { it is AccountPhase.Ready }
        assertEquals(null, flow.form.value.error)
    }
}
