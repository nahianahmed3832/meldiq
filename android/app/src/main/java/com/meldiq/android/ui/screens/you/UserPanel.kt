package com.meldiq.android.ui.screens.you

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.rounded.Headset
import androidx.compose.material.icons.rounded.HeadsetOff
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.api.UserDto
import com.meldiq.android.data.db.UserEntity
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.screens.profile.StatusRules
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/** What the user panel's microphone and headphones show, in a call or for the next one (unit-tested in `UserPanelRulesTest`). */
object UserPanelRules {
    data class Audio(val micOff: Boolean, val deafened: Boolean)

    /** In a call where you can speak they show that call; otherwise how the next call starts. */
    fun audio(inCall: Boolean, callMicOn: Boolean, callDeafened: Boolean, joinMuted: Boolean, joinDeafened: Boolean): Audio =
        if (inCall) Audio(micOff = !callMicOn, deafened = callDeafened)
        else Audio(micOff = joinMuted || joinDeafened, deafened = joinDeafened)

    /** Outside a call: the next call's microphone. Unmuting while deafened brings the sound back too, as in a call. */
    fun toggleJoinMic(joinMuted: Boolean, joinDeafened: Boolean): Pair<Boolean, Boolean> =
        if (joinDeafened) false to false else !joinMuted to false
}

/**
 * The user panel (as Meldiq Web's, 2026-10-28): you on your profile banner with your status, then your microphone,
 * your headphones and Settings. It is the one place for your profile and settings. In a call the microphone and
 * headphones mute and deafen that call; outside one they say how the next call starts. Tapping you opens [onStatus].
 */
@Composable
fun UserPanel(
    me: String?,
    name: String,
    handle: String?,
    meUser: UserEntity?,
    mine: UserDto?,
    now: Long,
    onStatus: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val container = LocalContainer.current
    val c = Griip.colors
    val call by container.calls.state.collectAsStateWithLifecycle()
    val settings by container.settings.state.collectAsStateWithLifecycle()
    val inCall = call.phase != CallPhase.Idle && call.phase != CallPhase.Incoming && !call.listenOnly
    val audio = UserPanelRules.audio(inCall, call.micOn, call.deafened, settings.joinMuted, settings.joinDeafened)
    val look = mine?.let { com.meldiq.android.data.model.PersonLook(it.avatarMedia, it.profileStyle, it.tag) }
        ?: com.meldiq.android.data.model.PersonLooks.of(meUser?.lookJson)
    val hasBanner = me != null && (mine?.profileBanner != null || mine?.profileStyle?.accent != null)
    val line = StatusRules.line(mine, now) ?: handle?.let { "@$it" }.orEmpty()

    Box(modifier.fillMaxWidth().clip(Shapes.card).background(c.surface).border(1.dp, c.border, Shapes.card)) {
        if (hasBanner && me != null) {
            com.meldiq.android.ui.components.ProfileBannerView(me, mine?.profileBanner, mine?.profileStyle, Modifier.matchParentSize())
            // The banner stays behind a scrim so the name, status and buttons read on any picture.
            Box(Modifier.matchParentSize().background(Brush.horizontalGradient(listOf(c.surface.copy(alpha = 0.92f), c.surface.copy(alpha = 0.55f)))))
        }
        Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).clip(Shapes.tile).pressable(onStatus, onClickLabel = stringResource(R.string.up_status_cd, name)).padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                com.meldiq.android.ui.components.LookAvatar(me, name.ifBlank { "?" }, meUser?.avatarColor ?: 0, meUser?.photoRev, look, size = 44.dp, online = true, presence = meUser?.presence)
                Spacer(Modifier.width(Space.md))
                Column(Modifier.weight(1f)) {
                    com.meldiq.android.ui.components.StyledName(name, look, Griip.type.titleSmall, c.textPrimary)
                    if (line.isNotEmpty()) Text(line, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            CircleIconButton(
                if (audio.micOff) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                stringResource(
                    when {
                        inCall -> if (audio.micOff) R.string.up_mic_unmute else R.string.up_mic_mute
                        else -> if (audio.micOff) R.string.up_next_mic_on else R.string.up_next_mic_off
                    },
                ),
                {
                    if (inCall) container.calls.toggleMic()
                    else container.settings.update { s -> UserPanelRules.toggleJoinMic(s.joinMuted, s.joinDeafened).let { (m, d) -> s.copy(joinMuted = m, joinDeafened = d) } }
                },
                tint = if (audio.micOff) c.danger else c.textPrimary, size = 40.dp,
            )
            CircleIconButton(
                if (audio.deafened) Icons.Rounded.HeadsetOff else Icons.Rounded.Headset,
                stringResource(
                    when {
                        inCall -> if (audio.deafened) R.string.b10_undeafen else R.string.b10_deafen
                        else -> if (audio.deafened) R.string.up_next_undeafen else R.string.up_next_deafen
                    },
                ),
                {
                    if (inCall) container.calls.toggleDeafen()
                    else container.settings.update { it.copy(joinDeafened = !it.joinDeafened) }
                },
                tint = if (audio.deafened) c.danger else c.textPrimary, size = 40.dp,
            )
            CircleIconButton(Icons.Outlined.Settings, stringResource(R.string.settings_title), onSettings, size = 40.dp)
        }
    }
    @Suppress("UNUSED_VARIABLE") val unused = Color.Transparent
}
