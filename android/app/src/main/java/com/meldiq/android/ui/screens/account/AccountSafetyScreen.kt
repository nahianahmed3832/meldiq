package com.meldiq.android.ui.screens.account

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.meldiq.android.BuildConfig
import com.meldiq.android.R
import com.meldiq.android.data.account.AccountRules
import com.meldiq.android.data.account.BugReportDto
import com.meldiq.android.data.account.Standing
import com.meldiq.android.data.account.StandingRules
import com.meldiq.android.data.account.TotpSetupRes
import com.meldiq.android.data.account.TotpStatus
import com.meldiq.android.data.account.TwoStepRules
import com.meldiq.android.data.repo.ServerFeatures
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.GriipTextField
import com.meldiq.android.ui.components.GriipTopBar
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/**
 * Settings › Account safety (API 0.46.0, docs/ACCOUNT_SAFETY.md, as Meldiq Web's My Account): two-step sign-in, changing
 * the email with a code sent to the new address, account standing and bug reports. Each part shows only where the
 * server has it.
 */
@Composable
fun AccountSafetyScreen(nav: NavHostController) {
    val container = LocalContainer.current
    var has by remember { mutableStateOf<Set<String>>(emptySet()) }
    LaunchedEffect(Unit) {
        has = listOf(ServerFeatures.TWO_STEP, ServerFeatures.EMAIL_CHANGE, ServerFeatures.ACCOUNT_STANDING, ServerFeatures.BUG_REPORTS)
            .filter { container.features.has(it) == true }.toSet()
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 40.dp)) {
        item { GriipTopBar(stringResource(R.string.wp_safety_title), subtitle = stringResource(R.string.wp_safety_sub), onBack = { nav.popBackStack() }) }
        if (ServerFeatures.TWO_STEP in has) item(key = "2fa") { TwoStepCard() }
        if (ServerFeatures.EMAIL_CHANGE in has) item(key = "email") { EmailCard() }
        if (ServerFeatures.ACCOUNT_STANDING in has) item(key = "standing") { StandingCard() }
        if (ServerFeatures.BUG_REPORTS in has) item(key = "bugs") { BugCard() }
    }
}

@Composable
private fun SafetyCard(title: String, content: @Composable () -> Unit) {
    val c = Griip.colors
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(title, style = Griip.type.titleSmall.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Spacer(Modifier.height(6.dp))
            content()
        }
    }
}

@Composable
private fun Secret(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier) =
    GriipTextField(value, onChange, label, modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))

@Composable
private fun TwoStepCard() {
    val container = LocalContainer.current
    val c = Griip.colors
    val ctx = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<TotpStatus?>(null) }
    var setup by remember { mutableStateOf<TotpSetupRes?>(null) }
    var backup by remember { mutableStateOf<List<String>?>(null) }
    var turningOff by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val noApp = stringResource(R.string.wp_2fa_no_app)
    fun reload() = scope.launch { status = runCatching { container.accountSafety.totpStatus() }.getOrNull() }
    LaunchedEffect(Unit) { reload() }
    fun run(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    val s = status
    SafetyCard(stringResource(R.string.wp_2fa_title) + (s?.let { " · " + stringResource(if (it.enabled) R.string.wp_2fa_on else R.string.wp_2fa_off) } ?: "")) {
        Text(stringResource(R.string.wp_2fa_explain), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(8.dp))
        val codes = backup
        val started = setup
        when {
            s == null -> Unit
            codes != null -> {
                Text(stringResource(R.string.wp_2fa_backup_title), style = Griip.type.label.copy(fontWeight = FontWeight.Bold), color = c.textPrimary)
                Text(stringResource(R.string.wp_2fa_backup_body), style = Griip.type.caption, color = c.warning)
                Spacer(Modifier.height(6.dp))
                Text(codes.joinToString("\n"), style = Griip.type.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, modifier = Modifier.fillMaxWidth().clip(Shapes.small).background(c.surfaceVariant).padding(12.dp))
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton(stringResource(R.string.wp_2fa_copy_codes), { scope.launch { clipboard.setClipEntry(ClipData.newPlainText("codes", codes.joinToString("\n")).toClipEntry()) } }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
                    PillButton(stringResource(R.string.wp_2fa_done), { backup = null; reload() }, Modifier.weight(1f), height = 44.dp)
                }
            }
            started != null -> {
                Text(stringResource(R.string.wp_2fa_step_app), style = Griip.type.bodySmall, color = c.textPrimary)
                Spacer(Modifier.height(6.dp))
                Text(StandingRules.grouped(started.secret), style = Griip.type.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = c.textPrimary, modifier = Modifier.fillMaxWidth().clip(Shapes.small).background(c.surfaceVariant).padding(12.dp))
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton(stringResource(R.string.wp_2fa_open_app), {
                        // Authenticator apps register for otpauth:// addresses; with none installed, the key is typed by hand.
                        val ok = runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(started.uri))) }.isSuccess
                        if (!ok) error = noApp
                    }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
                    PillButton(stringResource(R.string.wp_2fa_copy_secret), { scope.launch { clipboard.setClipEntry(ClipData.newPlainText("key", started.secret).toClipEntry()) } }, Modifier.weight(1f), tone = ButtonTone.Glass, height = 44.dp)
                }
                Spacer(Modifier.height(8.dp))
                GriipTextField(code, { code = it.take(8) }, stringResource(R.string.wp_2fa_code), Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_2fa_turn_on), {
                    run { backup = container.accountSafety.totpEnable(code).backupCodes; setup = null; code = ""; password = "" }
                }, Modifier.fillMaxWidth(), enabled = !busy && TwoStepRules.isCode(code), loading = busy, height = 44.dp)
            }
            !s.available && !s.enabled -> StatusBanner(stringResource(R.string.wp_2fa_unavailable), BannerKind.Info)
            s.enabled && !turningOff -> {
                Text(stringResource(R.string.wp_2fa_backup_left, s.backupCodesLeft), style = Griip.type.caption, color = c.textSecondary)
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_2fa_turn_off), { turningOff = true }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, height = 44.dp)
            }
            s.enabled -> {
                Secret(password, { password = it }, stringResource(R.string.wp_password))
                Spacer(Modifier.height(6.dp))
                GriipTextField(code, { code = it.take(16) }, stringResource(R.string.wp_2fa_code), Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_2fa_turn_off), {
                    run { container.accountSafety.totpDisable(password, code); turningOff = false; password = ""; code = ""; status = container.accountSafety.totpStatus() }
                }, Modifier.fillMaxWidth(), tone = ButtonTone.Danger, enabled = !busy && password.isNotEmpty() && TwoStepRules.isCode(code), loading = busy, height = 44.dp)
            }
            else -> {
                Secret(password, { password = it }, stringResource(R.string.wp_password))
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_2fa_turn_on), { run { setup = container.accountSafety.totpSetup(password) } }, Modifier.fillMaxWidth(), enabled = !busy && password.isNotEmpty(), loading = busy, height = 44.dp)
            }
        }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
    }
}

@Composable
private fun EmailCard() {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var newEmail by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var sentTo by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun run(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.friendly() }
            busy = false
        }
    }
    SafetyCard(stringResource(R.string.wp_email_title)) {
        val to = sentTo
        when {
            done != null -> Text(stringResource(R.string.wp_email_changed, done.orEmpty()), style = Griip.type.bodySmall, color = c.success)
            to != null -> {
                Text(stringResource(R.string.wp_email_code_sent, to), style = Griip.type.bodySmall, color = c.textSecondary)
                Spacer(Modifier.height(6.dp))
                GriipTextField(code, { code = it.filter(Char::isDigit).take(6) }, stringResource(R.string.wp_2fa_code), Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_email_confirm), {
                    run { done = container.accountSafety.emailChangeConfirm(code).email; sentTo = null; code = "" }
                }, Modifier.fillMaxWidth(), enabled = !busy && AccountRules.isVerifyCode(code), loading = busy, height = 44.dp)
            }
            else -> {
                GriipTextField(newEmail, { newEmail = it.take(254) }, stringResource(R.string.wp_email_new), Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                Spacer(Modifier.height(6.dp))
                Secret(password, { password = it }, stringResource(R.string.wp_password))
                Spacer(Modifier.height(8.dp))
                PillButton(stringResource(R.string.wp_email_send), {
                    run { sentTo = container.accountSafety.emailChangeStart(password, newEmail).email; password = "" }
                }, Modifier.fillMaxWidth(), enabled = !busy && password.isNotEmpty() && AccountRules.isEmail(newEmail), loading = busy, height = 44.dp)
            }
        }
        error?.let { Text(it, style = Griip.type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
    }
}

@Composable
private fun StandingCard() {
    val container = LocalContainer.current
    val c = Griip.colors
    var standing by remember { mutableStateOf<Standing?>(null) }
    LaunchedEffect(Unit) { standing = runCatching { container.accountSafety.standing() }.getOrNull() }
    val s = standing ?: return
    SafetyCard(stringResource(R.string.wp_standing_title)) {
        val (text, color) = when (s.level) {
            StandingRules.SUSPENDED -> stringResource(R.string.wp_standing_suspended) to c.danger
            StandingRules.VERY_LIMITED -> stringResource(R.string.wp_standing_very_limited) to c.danger
            StandingRules.LIMITED -> stringResource(R.string.wp_standing_limited) to c.warning
            else -> stringResource(R.string.wp_standing_good) to c.success
        }
        Text(text, style = Griip.type.bodyMedium, color = color)
        s.warnings.forEach { w ->
            Spacer(Modifier.height(6.dp))
            Text(w.reason, style = Griip.type.bodySmall, color = c.textPrimary)
            Text(stringResource(R.string.wp_standing_until, TimeFmt.dayHeader(w.expiresAt)), style = Griip.type.caption, color = c.textTertiary)
        }
    }
}

@Composable
private fun BugCard() {
    val container = LocalContainer.current
    val c = Griip.colors
    val scope = rememberCoroutineScope()
    var summary by remember { mutableStateOf("") }
    var details by remember { mutableStateOf("") }
    var reports by remember { mutableStateOf<List<BugReportDto>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val sent = stringResource(R.string.wp_bug_sent)
    LaunchedEffect(Unit) { reports = runCatching { container.accountSafety.bugReports().reports }.getOrDefault(emptyList()) }
    SafetyCard(stringResource(R.string.wp_bug_title)) {
        Text(stringResource(R.string.wp_bug_sub), style = Griip.type.bodySmall, color = c.textSecondary)
        Spacer(Modifier.height(8.dp))
        GriipTextField(summary, { summary = it.take(StandingRules.SUMMARY_MAX) }, stringResource(R.string.wp_bug_summary), Modifier.fillMaxWidth())
        Spacer(Modifier.height(6.dp))
        GriipTextField(details, { details = it.take(StandingRules.DETAILS_MAX) }, stringResource(R.string.wp_bug_details), Modifier.fillMaxWidth(), singleLine = false, minLines = 4)
        Spacer(Modifier.height(8.dp))
        PillButton(stringResource(R.string.wp_bug_send), {
            busy = true
            note = null
            scope.launch {
                runCatching { container.accountSafety.reportBug(summary, details, "android", "Meldiq Android ${BuildConfig.VERSION_NAME}") }
                    .onSuccess { r -> reports = listOf(r) + reports; summary = ""; details = ""; note = sent }
                    .onFailure { note = it.friendly() }
                busy = false
            }
        }, Modifier.fillMaxWidth(), enabled = !busy && StandingRules.canReport(summary, details), loading = busy, height = 44.dp)
        note?.let { Text(it, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 6.dp)) }
        if (reports.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(stringResource(R.string.wp_bug_yours), style = Griip.type.label.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary)
            reports.take(MAX_REPORTS_SHOWN).forEach { r ->
                Spacer(Modifier.height(6.dp))
                Text(r.summary, style = Griip.type.bodySmall, color = c.textPrimary)
                Text(listOfNotNull(r.status.replace('_', ' '), r.staffNote).joinToString(" · "), style = Griip.type.caption, color = c.textTertiary)
            }
        }
    }
}

private const val MAX_REPORTS_SHOWN = 10
