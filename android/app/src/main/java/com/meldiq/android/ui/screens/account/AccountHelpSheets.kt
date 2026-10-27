package com.meldiq.android.ui.screens.account

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.LockReset
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.PhonelinkSetup
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.ui.components.ChoiceCard
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** One way back into an account, offered only after the person asks for help (docs/product/MELDIQ_AUTH_FLOW_AUDIT.md). */
internal data class HelpOption(val icon: ImageVector, val title: Int, val subtitle: Int, val step: AccountStep)

/** What "Having trouble signing in?" offers: the password reset always, the others when this sign-in allows them. */
internal fun signInHelpOptions(allowRecovery: Boolean, @Suppress("UNUSED_PARAMETER") allowLegacy: Boolean): List<HelpOption> = listOfNotNull(
    HelpOption(Icons.Outlined.LockReset, R.string.auth_help_forgot, R.string.auth_help_forgot_sub, AccountStep.Forgot),
    HelpOption(Icons.Outlined.MarkEmailUnread, R.string.auth_help_lost_email, R.string.auth_help_lost_email_sub, AccountStep.Recover)
        .takeIf { allowRecovery },
    // "Move an account from before email" was retired on 2026-10-28 (as Meldiq Web v4); a phone that still holds such an
    // account is taken through the move by AccountGate, so nobody is stranded.
)

/** The ways to get this account's keys onto a new phone without the emailed code. */
internal val deviceUnlockOptions: List<HelpOption> = listOf(
    HelpOption(Icons.Outlined.PhonelinkSetup, R.string.acct_setup_link, R.string.acct_setup_link_sub, AccountStep.Link),
    HelpOption(Icons.Outlined.Key, R.string.acct_setup_key, R.string.acct_setup_key_sub, AccountStep.RestoreKey),
    HelpOption(Icons.Outlined.RestartAlt, R.string.acct_setup_fresh, R.string.acct_setup_fresh_sub, AccountStep.StartFresh),
)

/** A short list of [options] as cards; tapping one goes to its step. */
@Composable
internal fun HelpOptionList(options: List<HelpOption>, onChoose: (AccountStep) -> Unit) {
    options.forEachIndexed { i, option ->
        if (i > 0) Spacer(Modifier.height(Space.md))
        ChoiceCard(option.icon, stringResource(option.title), stringResource(option.subtitle), { onChoose(option.step) })
    }
}

/** A quiet text link for help that isn't part of the normal way through ("Having trouble signing in?"). */
@Composable
internal fun AuthHelpLink(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Text(
        label, style = Griip.type.bodySmall.copy(fontWeight = FontWeight.SemiBold),
        color = Griip.colors.primary, textAlign = TextAlign.Center,
        modifier = modifier
            .heightIn(min = 48.dp)
            .clip(Shapes.pill)
            .pressable(onClick, onClickLabel = label)
            .padding(horizontal = 12.dp, vertical = 14.dp),
    )
}

/** The sheet behind a help link: what it is for, the [options], and the way back to where the person was. */
@Composable
internal fun AccountHelpSheet(title: String, body: String, options: List<HelpOption>, backLabel: String, onChoose: (AccountStep) -> Unit, onDismiss: () -> Unit) {
    GlassSheet(onDismiss = onDismiss, title = title) {
        Text(body, style = Griip.type.bodySmall, color = Griip.colors.textSecondary)
        Spacer(Modifier.height(Space.lg))
        HelpOptionList(options) { step -> onDismiss(); onChoose(step) }
        Spacer(Modifier.height(Space.sm))
        AuthHelpLink(backLabel, onDismiss, Modifier.fillMaxWidth())
    }
}
