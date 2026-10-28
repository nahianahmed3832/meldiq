package com.meldiq.android.ui.screens.calls

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.BluetoothAudio
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Headset
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.PhoneInTalk
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.SpeakerGroup
import androidx.compose.material.icons.rounded.StopScreenShare
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.meldiq.android.call.AudioRoute
import com.meldiq.android.call.AudioRouteKind
import com.meldiq.android.call.CallAudioPolicy
import com.meldiq.android.call.CallPhase
import com.meldiq.android.call.CallUiState
import com.meldiq.android.ui.components.CallColors
import com.meldiq.android.ui.components.CallControlButton
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space

/**
 * The call's controls (UI-003), the same five in every kind of call: microphone, camera, end/leave, screen share and
 * audio output. The output control used to be replaced by "Flip camera" whenever the camera was on, so video calls and
 * screen sharing lost it; flipping the camera now lives on your own preview ([FlipCameraButton]). The floating redesign
 * (2026-10-28, the owner's call reference): one rounded charcoal bar of round buttons with the red hang-up in the middle;
 * labels are read by TalkBack. Five 56 dp buttons fit a 360 dp phone; nothing is dropped as the call changes (rules in
 * [CallControlsRules], unit-tested).
 */
@Composable
fun CallControlBar(
    s: CallUiState,
    onMic: () -> Unit,
    onCamera: () -> Unit,
    onAudio: () -> Unit,
    onShare: () -> Unit,
    onEnd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        // Capped width: in landscape the controls stay a compact group instead of spreading across the screen.
        modifier.widthIn(max = 520.dp).fillMaxWidth().clip(Shapes.hero).background(CallColors.bar)
            .border(1.dp, CallColors.barBorder, Shapes.hero).padding(vertical = 12.dp, horizontal = 6.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A listener (voice channel without speaking rights) can't turn the microphone or camera on: the buttons say so.
        CallControlButton(
            if (s.micOn) Icons.Rounded.Mic else Icons.Rounded.MicOff, if (s.listenOnly) "Listening" else if (s.micOn) "Mute" else "Unmute", onMic,
            active = !s.micOn, enabled = !s.listenOnly, showLabel = false, size = 56.dp,
        )
        CallControlButton(
            if (s.cameraOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff, "Camera", onCamera,
            active = s.cameraOn, enabled = !s.listenOnly, showLabel = false, size = 56.dp,
        )
        CallControlButton(Icons.Rounded.CallEnd, CallControlsRules.endLabel(s), onEnd, danger = true, showLabel = false, size = 60.dp)
        CallControlButton(
            if (s.screenSharing) Icons.Rounded.StopScreenShare else Icons.Rounded.ScreenShare, if (s.screenSharing) "Stop share" else "Share", onShare,
            active = s.screenSharing, enabled = CallControlsRules.canShare(s), showLabel = false, size = 56.dp,
        )
        AudioRouteButton(s.audioRoute, s.audioRoutes, onAudio)
    }
}

/** The output button: it shows the route the phone actually uses, and is never disabled or removed. */
@Composable
fun AudioRouteButton(current: AudioRoute?, routes: List<AudioRoute>, onClick: () -> Unit, modifier: Modifier = Modifier) {
    CallControlButton(
        routeIcon(current?.kind), current?.label ?: "Audio", onClick, modifier,
        active = current?.kind == AudioRouteKind.Speaker, showLabel = false, size = 56.dp,
    )
}

fun routeIcon(kind: AudioRouteKind?): ImageVector = when (kind) {
    AudioRouteKind.Speaker -> Icons.AutoMirrored.Rounded.VolumeUp
    AudioRouteKind.Earpiece -> Icons.Rounded.PhoneInTalk
    AudioRouteKind.Bluetooth -> Icons.Rounded.BluetoothAudio
    AudioRouteKind.Wired -> Icons.Rounded.Headset
    AudioRouteKind.Other, null -> Icons.Rounded.SpeakerGroup
}

/**
 * Where the call's sound plays: every output the phone offers, the current one ticked, a route that didn't take, and
 * the call volume when it's low (a frequent reason for "too quiet"). Meldiq doesn't boost or override the phone's
 * volume; the volume buttons control it during the call.
 */
@Composable
fun AudioRouteSheet(s: CallUiState, onPick: (AudioRoute) -> Unit, onDismiss: () -> Unit) {
    val c = Griip.colors
    GlassSheet(onDismiss, title = "Audio output") {
        if (s.audioRoutes.isEmpty()) {
            Text("The phone hasn't listed its audio outputs yet. Try again in a moment.", style = Griip.type.bodySmall, color = c.textSecondary, modifier = Modifier.padding(4.dp))
        }
        s.audioRoutes.forEach { r ->
            val chosen = CallAudioPolicy.matches(r, s.audioRoute)
            Row(
                Modifier.fillMaxWidth().padding(vertical = 3.dp).clip(Shapes.card).background(if (chosen) c.primarySoft else Color.Transparent)
                    .pressable({ onPick(r) }, role = Role.RadioButton, onClickLabel = "Play sound on ${r.label}")
                    .semantics { selected = chosen }.padding(horizontal = 12.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(routeIcon(r.kind), null, tint = if (chosen) c.primary else c.textSecondary, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(14.dp))
                Text(r.label, style = Griip.type.body, color = c.textPrimary, modifier = Modifier.weight(1f))
                if (chosen) Icon(Icons.Rounded.Check, "Current output", tint = c.primary, modifier = Modifier.size(20.dp))
            }
        }
        s.routeError?.let { Text(it, style = Griip.type.bodySmall, color = c.danger, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) }
        val st = s.stats
        Column(Modifier.padding(top = 10.dp, start = 4.dp, end = 4.dp, bottom = Space.gutter)) {
            st?.callVolume?.let { Text("Call volume: $it", style = Griip.type.caption, color = if (st.volumeLow) c.warning else c.textTertiary) }
            if (st?.volumeLow == true) {
                Text("Sound may be quiet: press the volume-up button during the call.", style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 2.dp))
            }
            if (CallControlsRules.noSoundArriving(s)) {
                Text("No sound is arriving from the other side right now; check that they aren't muted.", style = Griip.type.caption, color = c.warning, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

/** Switches between the front and back camera; drawn on your own preview, where you see the result. */
@Composable
fun FlipCameraButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape).background(Color.Black.copy(alpha = 0.5f)).pressable(onClick, onClickLabel = "Switch camera"),
        contentAlignment = Alignment.Center,
    ) { Icon(Icons.Rounded.Cameraswitch, "Switch camera", tint = Color.White, modifier = Modifier.size(20.dp)) }
}

/** What the controls show in each state of a call (unit-tested in `CallControlsRulesTest`). */
object CallControlsRules {
    /** Group calls with others still in them are left, not ended for everyone; 1:1 calls are ended. */
    fun endLabel(s: CallUiState): String = if (s.isGroup && s.participants.count { !it.isLocal } > 0) "Leave" else "End"

    /** Sharing starts once the call is connected (and can always be stopped). */
    fun canShare(s: CallUiState): Boolean = s.screenSharing || (s.phase == CallPhase.Connected && !s.listenOnly)

    /** Someone else's microphone is on but no sound bytes arrive: worth saying when sound is "missing". */
    fun noSoundArriving(s: CallUiState): Boolean =
        s.phase == CallPhase.Connected && s.participants.any { !it.isLocal && it.micOn } && s.remoteAudio == com.meldiq.android.call.MediaFlow.Stalled

    /** The output button with only the speaker and the earpiece switches between them; with more it opens the list. */
    fun opensPicker(s: CallUiState): Boolean = CallAudioPolicy.needsPicker(s.audioRoutes) || s.audioRoutes.isEmpty() || s.routeError != null
}
