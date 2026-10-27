package com.meldiq.android.ui.screens.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material.icons.outlined.Widgets
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.data.model.ConversationSecurity
import com.meldiq.android.data.model.ConversationSecurity.Point
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes

/** What protects this conversation, and what doesn't: only facts that apply to it ([ConversationSecurity.points]). */
@Composable
fun ConversationSecuritySheet(
    facts: ConversationSecurity.Facts,
    peerName: String?,
    onVerify: (() -> Unit)?,
    onDismiss: () -> Unit,
) {
    GlassSheet(onDismiss, title = stringResource(R.string.sec_title)) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            ConversationSecurity.points(facts).forEach { point -> SecurityRow(point, peerName) }
            if (onVerify != null && facts.type == "DM" && facts.peerVerified != true) {
                PillButton(stringResource(R.string.sec_verify_action), onVerify, Modifier.fillMaxWidth().padding(top = 12.dp), tone = ButtonTone.Glass, height = 48.dp)
            }
        }
    }
}

@Composable
private fun SecurityRow(point: Point, peerName: String?) {
    val c = Griip.colors
    val who = peerName?.takeIf { it.isNotBlank() } ?: stringResource(R.string.sec_this_person)
    val (icon, tint, title, body) = when (point) {
        Point.MESSAGES -> Row4(Icons.Outlined.ChatBubbleOutline, c.success, stringResource(R.string.sec_messages), stringResource(R.string.sec_messages_body))
        Point.FILES -> Row4(Icons.Outlined.AttachFile, c.success, stringResource(R.string.sec_files), stringResource(R.string.sec_files_body))
        Point.CALLS_E2EE -> Row4(Icons.Outlined.Call, c.success, stringResource(R.string.sec_calls_e2ee), stringResource(R.string.sec_calls_e2ee_body))
        Point.CALLS_TRANSPORT -> Row4(Icons.Outlined.Call, c.warning, stringResource(R.string.sec_calls_transport), stringResource(R.string.sec_calls_transport_body))
        Point.KEYS_CHANGED -> Row4(Icons.Outlined.GppMaybe, c.warning, stringResource(R.string.sec_keys_changed), stringResource(R.string.sec_keys_changed_body))
        Point.OTHER_SERVERS -> Row4(Icons.Outlined.Dns, c.textSecondary, stringResource(R.string.sec_other_servers), stringResource(R.string.sec_other_servers_body))
        Point.APP_UPDATES -> Row4(Icons.Outlined.Widgets, c.warning, stringResource(R.string.sec_app_updates), stringResource(R.string.sec_app_updates_body))
        Point.METADATA -> Row4(Icons.Outlined.Info, c.textSecondary, stringResource(R.string.sec_metadata), stringResource(R.string.sec_metadata_body))
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(32.dp).clip(Shapes.small).background(c.surfaceVariant), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Griip.type.body.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary)
            Text(body, style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

private data class Row4(val icon: ImageVector, val tint: Color, val title: String, val body: String)
