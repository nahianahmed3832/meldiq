package com.meldiq.android.ui.screens.account

import androidx.compose.material.icons.outlined.Phone
import com.meldiq.android.ui.components.ValueChevron
import androidx.compose.material.icons.outlined.Badge
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Password
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.data.account.AccountPhase
import com.meldiq.android.data.account.AccountRules
import com.meldiq.android.data.account.SessionListItem
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.GlassCard
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * The Orbit 2.0 account in Settings › Security: its email, changing the password, the apps signed in to it (any can be
 * signed out), and signing out here. Signing out keeps this phone's keys and messages; "Sign out & erase" below removes
 * them. Shown only on profiles with an Orbit 2.0 account.
 */
@Composable
private fun AccountSection(id: Int) {
    Text(stringResource(id), style = Griip.type.label, color = Griip.colors.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter + 4.dp, vertical = 8.dp))
}

@Composable
fun AccountSecurityCard(modifier: Modifier = Modifier, onEditProfile: (() -> Unit)? = null) {
    val container = LocalContainer.current
    val c = Griip.colors
    val phase by container.accounts.phase.collectAsStateWithLifecycle()
    val account = (phase as? AccountPhase.Ready)?.account ?: return
    val scope = rememberCoroutineScope()
    var sessions by remember { mutableStateOf<List<SessionListItem>?>(null) }
    var message by remember { mutableStateOf<Pair<String, BannerKind>?>(null) }
    var changing by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val load: () -> Unit = { scope.launch { runCatching { container.accounts.sessions() }.onSuccess { sessions = it }.onFailure { message = it.friendly() to BannerKind.Error } } }
    LaunchedEffect(account.id) { load() }

    // 2026-10-23 (the reference's Account page): who you are, how you sign in, then leaving or deleting, each a group.
    val me by container.db.users().observe(container.session.session?.userId ?: "").collectAsStateWithLifecycle(null)
    AccountSection(R.string.ux_account_info)
    GlassCard(modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) {
        me?.let { u ->
            MenuRow(Icons.Outlined.AlternateEmail, stringResource(R.string.ux_username), onClick = onEditProfile, trailing = { ValueChevron("@" + u.username) })
            MenuRow(Icons.Outlined.Badge, stringResource(R.string.ux_display_name), onClick = onEditProfile, trailing = { ValueChevron(u.displayName) })
        }
        MenuRow(Icons.Outlined.Email, stringResource(R.string.acct_settings_email), trailing = { Text(account.email, style = Griip.type.caption, color = c.textSecondary, maxLines = 1) })
        // The optional phone number lives on the profile (who may see it is a privacy setting); edited in Edit profile.
        var phone by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(account.id) { phone = runCatching { container.profiles.me().phone }.getOrNull()?.ifEmpty { null } }
        MenuRow(Icons.Outlined.Phone, stringResource(R.string.ux_phone), onClick = onEditProfile, trailing = { ValueChevron(phone ?: stringResource(R.string.ux_add)) })
    }
    AccountSection(R.string.ux_how_you_sign_in)
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) {
        MenuRow(Icons.Outlined.Password, stringResource(R.string.acct_settings_password), subtitle = stringResource(R.string.acct_settings_password_sub), onClick = { changing = true })
        RecoveryCodesRow()
    }
    PasskeysSection()
    AccountSection(R.string.ux_account_management)
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) {
        MenuRow(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.acct_settings_logout), subtitle = stringResource(R.string.acct_settings_logout_sub), onClick = { confirmLogout = true })
        MenuRow(
            Icons.Outlined.DeleteForever, stringResource(R.string.acct_delete), subtitle = stringResource(R.string.acct_delete_sub),
            tint = c.danger, tintBg = c.dangerSoft, onClick = { deleting = true },
        )
    }
    message?.let { (text, kind) -> StatusBanner(text, kind, Modifier.padding(horizontal = Space.gutter, vertical = 4.dp)) }
    Text(stringResource(R.string.acct_settings_sessions), style = Griip.type.label, color = c.textSecondary, modifier = Modifier.padding(horizontal = Space.gutter + 4.dp, vertical = 8.dp))
    GlassCard(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), contentPadding = PaddingValues(6.dp)) {
        val list = sessions
        if (list == null) Text(stringResource(R.string.acct_settings_loading), style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(12.dp))
        list?.forEach { s ->
            MenuRow(
                Icons.Outlined.Devices, s.label + if (s.current) " · " + stringResource(R.string.acct_settings_this_phone) else "",
                subtitle = stringResource(R.string.acct_settings_last_used, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(s.lastUsedAt))),
                trailing = if (s.current) null else { { Text(stringResource(R.string.acct_settings_sign_out_one), style = Griip.type.label, color = c.danger) } },
                onClick = if (s.current) null else {
                    {
                        scope.launch {
                            runCatching { container.accounts.revokeSession(s.id) }
                                .onSuccess { message = null; load() }
                                .onFailure { message = it.friendly() to BannerKind.Error }
                        }
                    }
                },
            )
        }
    }
    if (deleting) DeleteAccountSheet(account.email, onDismiss = { deleting = false })
    if (changing) ChangePasswordDialog(account.email, onDone = { ok -> changing = false; if (ok) { message = null; load() } })
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text(stringResource(R.string.acct_settings_logout)) },
            text = { Text(stringResource(R.string.acct_settings_logout_body)) },
            confirmButton = { TextButton(onClick = { confirmLogout = false; scope.launch { container.accounts.logout() } }) { Text(stringResource(R.string.acct_settings_logout)) } },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

@Composable
private fun ChangePasswordDialog(email: String, onDone: (Boolean) -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val issue = if (next.isEmpty()) null else AccountRules.passwordIssue(next, email)
    AlertDialog(
        onDismissRequest = { if (!busy) onDone(false) },
        title = { Text(stringResource(R.string.acct_settings_password)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.md)) {
                PasswordField(current, { current = it }, stringResource(R.string.acct_current_password), !busy, imeAction = androidx.compose.ui.text.input.ImeAction.Next)
                PasswordField(next, { next = it }, stringResource(R.string.acct_new_password), !busy, issue = issue, helper = stringResource(R.string.acct_settings_password_effect))
                error?.let { StatusBanner(it, BannerKind.Error) }
                Spacer(Modifier.height(2.dp))
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && current.isNotEmpty() && next.isNotEmpty() && issue == null,
                onClick = {
                    busy = true
                    scope.launch {
                        runCatching { container.accounts.changePassword(current, next) }
                            .onSuccess { onDone(true) }
                            .onFailure { error = it.friendly(); busy = false }
                    }
                },
            ) { Text(stringResource(R.string.acct_settings_password_save)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = { onDone(false) }) { Text(stringResource(R.string.common_cancel)) } },
    )
}
