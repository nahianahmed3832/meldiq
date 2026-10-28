package com.meldiq.android.ui.screens.calls

import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.material.icons.rounded.SignalCellularConnectedNoInternet0Bar
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material.icons.rounded.HeadsetOff
import androidx.compose.material.icons.rounded.Headset
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.Layout
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.BoxWithConstraints
import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.util.Log
import android.widget.Toast
import com.meldiq.android.R
import com.meldiq.android.call.CallMediaPolicy
import com.meldiq.android.call.ShareMode
import com.meldiq.android.BuildConfig
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.material.icons.rounded.NetworkCheck
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Cameraswitch
import androidx.compose.material.icons.rounded.CloseFullscreen
import androidx.compose.material.icons.rounded.Close
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.rounded.GppGood
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.PhoneInTalk
import androidx.compose.material.icons.rounded.ScreenShare
import androidx.compose.material.icons.rounded.StopScreenShare
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.call.CallPhase
import com.meldiq.android.call.MediaFlow
import com.meldiq.android.call.CallUiState
import com.meldiq.android.call.MediaSecurity
import com.meldiq.android.call.ParticipantUi
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.Avatar
import com.meldiq.android.ui.components.CallControlButton
import com.meldiq.android.ui.components.ConfirmDialog
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Asks for microphone (and camera for video) before any call action. */
@Composable
fun rememberCallPermission(): (video: Boolean, onGranted: () -> Unit) -> Unit {
    val ctx = LocalContext.current
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        // Only what was asked is in [res]: a microphone allowed earlier isn't, and declining "nearby devices" (Bluetooth
        // headsets) or the camera mustn't stop the call (batch B10 fix).
        if (CallPermissionRules.canCall(res[Manifest.permission.RECORD_AUDIO], ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)) pending?.invoke()
        else Toast.makeText(ctx, "Microphone permission is required for calls", Toast.LENGTH_LONG).show()
        pending = null
    }
    return { video, onGranted ->
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (video) add(Manifest.permission.CAMERA)
            if (android.os.Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT)
        }.filter { ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) onGranted() else {
            pending = onGranted
            launcher.launch(needed.toTypedArray())
        }
    }
}

/** Whether a call can start after the permission dialog (unit-tested). */
object CallPermissionRules {
    /** [answered]: the microphone's answer if it was asked now (null if it wasn't asked); [granted]: allowed now. */
    fun canCall(answered: Boolean?, granted: Boolean): Boolean = answered == true || granted
}

@Composable
fun CallOverlay() {
    val container = LocalContainer.current
    val calls = container.calls
    val s by calls.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val permission = rememberCallPermission()
    val minimized by calls.minimized.collectAsStateWithLifecycle()
    var explainShare by remember { mutableStateOf(false) }
    var routeSheet by remember { mutableStateOf(false) }
    val settingsStore = container.settings
    val projection = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val pick = settingsStore.current
        if (r.resultCode == Activity.RESULT_OK && r.data != null) calls.startScreenShare(r.data!!, ShareMode.of(pick.shareMode), pick.shareAppSound)
        else Toast.makeText(ctx, "Screen sharing cancelled", Toast.LENGTH_SHORT).show()
    }
    BackHandler(enabled = s.phase != CallPhase.Idle && !minimized && s.phase != CallPhase.Incoming) { calls.minimize() }
    // A keyboard left open in a chat would sit over the call's buttons: the call screen takes the whole screen.
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(s.phase == CallPhase.Idle, minimized) {
        if (s.phase != CallPhase.Idle && !minimized) {
            focus.clearFocus(force = true)
            keyboard?.hide()
        }
    }
    var details by remember { mutableStateOf(false) }
    var people by remember { mutableStateOf(false) }
    var verify by remember { mutableStateOf(false) }
    // UI-003: the controls stay. Over video a tap on the picture hides them for a clear view and the next tap brings them
    // back; nothing hides them on a timer (the speaker "disappearing" was the old 4-second auto-hide).
    var chromeVisible by remember { mutableStateOf(true) }
    var previewCorner by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(PreviewCorner.TopEnd) }
    var stage by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    val onAudio = { if (CallControlsRules.opensPicker(s)) routeSheet = true else calls.toggleSpeaker() }

    // The in-app call panel (AppRoot) stands in while minimised; the call itself carries on.
    if (minimized && s.phase != CallPhase.Incoming) return

    val remote = s.participants.filter { !it.isLocal }
    val local = s.participants.firstOrNull { it.isLocal }
    // Several shares (2026-10-24): the one this phone watches ([CallTiles.watchedShare]), chosen in the share tray.
    val sharers = s.participants.filter { it.screen != null && !it.isLocal }
    val screen = sharers.firstOrNull { it.identity == s.watchingShare } ?: sharers.firstOrNull()
    val mode = CallTiles.mode(s.isGroup, s.phase, remote.size, remote.any { it.camera != null }, screen != null)
    // Full-screen media (one-to-one video, a shared screen) gets scrims, and a tap can hide the controls for a clear
    // view; the grid keeps its tiles clear of the controls instead.
    val hasVideo = mode == CallTiles.Mode.OneToOne || mode == CallTiles.Mode.ScreenWithStrip
    // Your preview in a top corner: the status chips keep clear of it (on the phone a "Weak connection" chip ran under it).
    val showsPreview = local?.camera != null && (mode == CallTiles.Mode.OneToOne || mode == CallTiles.Mode.Hero)
    val chipPad = Modifier.padding(
        start = if (showsPreview && previewCorner == PreviewCorner.TopStart) 132.dp else 0.dp,
        end = if (showsPreview && previewCorner == PreviewCorner.TopEnd) 132.dp else 0.dp,
    )
    val canHide = CallChrome.canHide(hasVideo, s.phase, menuOpen = details || people || verify || explainShare || routeSheet || s.error != null || s.routeError != null)
    val showChrome = chromeVisible || !canHide
    Box(
        Modifier.fillMaxSize().background(Griip.colors.callStage).onSizeChanged { stage = it }
            .clickable(interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }, indication = null, onClickLabel = if (showChrome) "Hide call controls" else "Show call controls") {
                chromeVisible = if (canHide) !showChrome else true
            },
    ) {
        when (mode) {
            CallTiles.Mode.OneToOne -> if (screen != null) {
                // A shared screen keeps clear of the status lines and the controls, so nothing it shows is covered.
                Box(
                    Modifier.fillMaxSize().windowInsetsPadding(CallInsets)
                        .padding(top = if (showChrome) 92.dp else 8.dp, bottom = if (showChrome) 128.dp else 8.dp),
                ) {
                    VideoTile(screen.screen, Modifier.fillMaxSize(), fit = true)
                    if (showChrome) ScreenLabel(screen.name, Modifier.align(Alignment.TopCenter))
                }
            } else {
                VideoTile(remote.first().camera, Modifier.fillMaxSize())
            }
            CallTiles.Mode.ScreenWithStrip -> ScreenStage(screen!!, sharers, s.participants, showChrome, onWatch = calls::watchShare, onFlip = calls::flipCamera)
            CallTiles.Mode.Grid -> ParticipantGrid(
                s.participants,
                // Room for the status lines above and the controls below, which never cover a tile.
                Modifier.fillMaxSize().windowInsetsPadding(CallInsets).padding(top = 92.dp, bottom = 128.dp, start = 8.dp, end = 8.dp),
                onFlip = calls::flipCamera,
            )
            CallTiles.Mode.Hero -> CallerHero(s, Modifier.align(Alignment.Center))
        }
        // Your camera floats only where you have no tile of your own (one-to-one and before anyone joins).
        if (local?.camera != null && (mode == CallTiles.Mode.OneToOne || mode == CallTiles.Mode.Hero)) {
            // In a bottom corner it sits above the sharing banner or an error as well as the controls.
            val banners = s.screenSharing || s.error != null || s.routeError != null
            MovablePreview(previewCorner, stage, showChrome, bottomExtra = if (banners) 64.dp else 0.dp, onCorner = { previewCorner = it }) {
                VideoTile(local.camera, Modifier.fillMaxSize().clip(Shapes.tile).border(2.dp, Color.White.copy(alpha = 0.7f), Shapes.tile), mirror = local.mirrored)
                // Flipping the camera lives on your own picture, so the output button never has to give way to it.
                FlipCameraButton(calls::flipCamera, Modifier.align(Alignment.BottomEnd).padding(6.dp))
            }
        }

        // Scrims keep the status line and controls readable over video.
        if (hasVideo && showChrome) {
            Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(140.dp).background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent))))
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(240.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f)))))
        }
        // Top status
        if (showChrome) Column(Modifier.fillMaxWidth().windowInsetsPadding(SafeTop).padding(horizontal = 14.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (s.phase != CallPhase.Incoming) {
                    Box(Modifier.size(48.dp).clip(CircleShape).background(com.meldiq.android.ui.components.CallColors.control).pressable({ calls.minimize() }, onClickLabel = "Minimize call"), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.CloseFullscreen, "Minimize call", tint = Color.White, modifier = Modifier.size(20.dp))
                    }
                    if (s.phase == CallPhase.Connected || s.phase == CallPhase.Reconnecting) {
                        Spacer(Modifier.width(8.dp))
                        Box(Modifier.size(48.dp).clip(CircleShape).background(com.meldiq.android.ui.components.CallColors.control).pressable({ details = !details; people = false }, onClickLabel = "Connection details"), contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.NetworkCheck, "Connection details", tint = Color.White, modifier = Modifier.size(20.dp))
                        }
                        if (s.isGroup) {
                            Spacer(Modifier.width(8.dp))
                            Box(Modifier.size(48.dp).clip(CircleShape).background(com.meldiq.android.ui.components.CallColors.control).pressable({ people = !people; details = false }, onClickLabel = "People in this call"), contentAlignment = Alignment.Center) {
                                Icon(Icons.Rounded.Groups, "People in this call", tint = Color.White, modifier = Modifier.size(20.dp))
                            }
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                Box(Modifier.clip(Shapes.pill).pressable({ verify = !verify; details = false; people = false }, onClickLabel = "Encryption and verification code")) { SecurityPill(s) }
            }
            // Who, the call's state and time, and how many: in every layout except the caller screen, which says it large.
            if (mode != CallTiles.Mode.Hero) CallStatusLine(s, Modifier.padding(top = 8.dp, start = 2.dp))
            if (s.phase == CallPhase.Reconnecting) {
                Text(
                    "Reconnecting… the call continues when the connection is back", style = Griip.type.caption, color = Color.White,
                    modifier = chipPad.padding(top = 8.dp).clip(Shapes.pill).background(Griip.colors.warning.copy(alpha = 0.85f)).padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
            if (CallControlsRules.noSoundArriving(s)) {
                Text(
                    "No sound is arriving right now", style = Griip.type.caption, color = Color.White,
                    modifier = chipPad.padding(top = 8.dp).clip(Shapes.pill).background(Griip.colors.warning.copy(alpha = 0.85f)).pressable({ routeSheet = true }).padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
            if (s.peerReconnecting && !s.isGroup) {
                Text(
                    "${s.title}'s connection dropped. Waiting for them to reconnect…", style = Griip.type.caption, color = Color.White,
                    modifier = chipPad.padding(top = 8.dp).clip(Shapes.pill).background(Griip.colors.warning.copy(alpha = 0.85f)).padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
            if (s.connectionWeak && s.phase == CallPhase.Connected) {
                Text(
                    "Weak connection: video quality is reduced", style = Griip.type.caption, color = Color.White,
                    modifier = chipPad.padding(top = 8.dp).clip(Shapes.pill).background(Griip.colors.warning.copy(alpha = 0.85f)).padding(horizontal = 12.dp, vertical = 5.dp),
                )
            }
            if (details) ConnectionDetails(s, Modifier.padding(top = 10.dp)) { details = false }
            if (verify) VerificationPanel(s, Modifier.padding(top = 10.dp)) { verify = false }
            if (people) PeoplePanel(s, Modifier.padding(top = 10.dp), onModerate = { id, action -> calls.moderate(id, action) }) { people = false }
        }

        // Bottom: share indicator + controls, kept clear of the navigation bar, gesture area and cutouts.
        AnimatedVisibility(
            showChrome, enter = fadeIn(tween(160)), exit = fadeOut(tween(220)),
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(SafeBottom),
        ) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            s.error?.let {
                Text(it, style = Griip.type.label, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 10.dp).clip(Shapes.tile).background(Griip.colors.danger.copy(alpha = 0.85f)).pressable({ calls.clearError() }).padding(horizontal = 14.dp, vertical = 8.dp))
            }
            // A route the phone didn't apply: recoverable from here (opens the output list).
            if (s.routeError != null && !routeSheet) {
                Text(s.routeError!!, style = Griip.type.label, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 10.dp).clip(Shapes.tile).background(Griip.colors.warning.copy(alpha = 0.9f)).pressable({ routeSheet = true }, onClickLabel = "Choose the audio output").padding(horizontal = 14.dp, vertical = 8.dp))
            }
            if (s.screenSharing) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 12.dp).clip(Shapes.tile).background(Griip.colors.danger.copy(alpha = 0.92f)).padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(Color.White))
                    Spacer(Modifier.width(10.dp))
                    val what = stringResource(
                        when (s.shareMode) {
                            ShareMode.GAME -> R.string.b11_sharing_game
                            ShareMode.HIGH -> R.string.vid_sharing_high
                            ShareMode.TEXT -> R.string.b11_sharing
                        },
                    )
                    // High, measured: say so when the phone or the network sends clearly less than 1080p at 60 fps.
                    val sent = s.stats?.sendingScreen
                    val less = s.shareMode == ShareMode.HIGH && CallMediaPolicy.sendingLessThanHigh(sent)
                    val parts = listOfNotNull(
                        what,
                        stringResource(R.string.b11_with_sound).takeIf { s.shareAppSound },
                        sent?.takeIf { less }?.let { stringResource(R.string.vid_sending_less, minOf(it.width, it.height), (it.fps ?: 0.0).toInt()) },
                    )
                    Text(parts.joinToString(" · "), style = Griip.type.bodyMedium, color = Color.White, modifier = Modifier.weight(1f))
                    Text(stringResource(R.string.b11_stop), style = Griip.type.button, color = Color.White, modifier = Modifier.clip(Shapes.pill).background(Color.White.copy(alpha = 0.22f)).pressable({ calls.stopScreenShare() }).padding(horizontal = 14.dp, vertical = 6.dp))
                }
            }
            if (s.phase == CallPhase.Incoming) {
                Row(Modifier.fillMaxWidth().padding(bottom = 24.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    CallControlButton(Icons.Rounded.CallEnd, "Decline", { calls.decline() }, danger = true)
                    CallControlButton(if (s.video) Icons.Rounded.Videocam else Icons.Rounded.Call, "Accept", { permission(s.video) { scope.launch { calls.accept() } } }, positive = true)
                }
            } else if (s.phase != CallPhase.Ended) {
                // Batch B10: deafen (hear nobody, be heard by nobody), beside Raise hand in voice rooms.
                if (s.phase == CallPhase.Connected || s.phase == CallPhase.Reconnecting) {
                    Row(
                        Modifier.padding(bottom = 10.dp).clip(Shapes.pill).background(if (s.deafened) com.meldiq.android.ui.components.CallColors.end else com.meldiq.android.ui.components.CallColors.control)
                            .pressable({ calls.toggleDeafen() }, onClickLabel = stringResource(if (s.deafened) R.string.b10_undeafen else R.string.b10_deafen))
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(if (s.deafened) Icons.Rounded.HeadsetOff else Icons.Rounded.Headset, null, tint = Color.White, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(if (s.deafened) R.string.b10_deafened else R.string.b10_deafen), style = Griip.type.button, color = Color.White)
                    }
                }
                // Voice rooms (round 6): ask to speak; everyone sees the hands in order in the People list.
                if (s.voiceRoom && s.phase == CallPhase.Connected) {
                    val me = container.session.session?.userId
                    val raised = me != null && me in s.hands
                    Row(
                        Modifier.padding(bottom = 10.dp).clip(Shapes.pill).background(if (raised) Griip.colors.warning.copy(alpha = 0.9f) else com.meldiq.android.ui.components.CallColors.control)
                            .pressable({ calls.raiseHand(!raised) }, onClickLabel = if (raised) "Lower your hand" else "Raise your hand").padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Rounded.PanTool, null, tint = Color.White, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(if (raised) "Lower hand" else "Raise hand", style = Griip.type.button, color = Color.White)
                        if (s.hands.isNotEmpty()) Text("  ·  ${s.hands.size}", style = Griip.type.button, color = Color.White.copy(alpha = 0.8f))
                    }
                }
                CallControlBar(
                    s,
                    onMic = { calls.toggleMic() },
                    onCamera = { if (s.cameraOn) calls.toggleCamera() else permission(true) { calls.toggleCamera() } },
                    onAudio = onAudio,
                    onShare = {
                        when {
                            s.screenSharing -> calls.stopScreenShare()
                            // A fourth screen waits for one to stop (as on Meldiq Web), before Android's consent is asked.
                            !CallTiles.canStartShare(sharers.size) -> Toast.makeText(ctx, ctx.getString(R.string.vid_share_full, CallTiles.MAX_SHARES), Toast.LENGTH_LONG).show()
                            else -> explainShare = true
                        }
                    },
                    onEnd = { calls.hangup() },
                )
            }
        }
        }
    }
    if (routeSheet) AudioRouteSheet(s, onPick = { calls.selectAudioRoute(it); routeSheet = false }, onDismiss = { routeSheet = false; calls.clearRouteError() })
    // Batch B11: what the share is for and whether app sound goes with it, remembered for next time.
    if (explainShare) ShareSheet(
        ShareMode.of(settingsStore.current.shareMode), settingsStore.current.shareAppSound,
        onContinue = { mode, sound ->
            explainShare = false
            settingsStore.update { it.copy(shareMode = mode.name, shareAppSound = sound) }
            val mpm = ctx.getSystemService(MediaProjectionManager::class.java)
            projection.launch(mpm.createScreenCaptureIntent())
        },
        onDismiss = { explainShare = false },
    )
}

@Composable
private fun SecurityPill(s: CallUiState) {
    val c = Griip.colors
    val (icon, text, tint) = when (s.security) {
        MediaSecurity.E2eeActive -> Triple(Icons.Rounded.GppGood, "Encrypted call", c.primaryBright)
        MediaSecurity.E2eeProblem -> Triple(Icons.Rounded.GppMaybe, "Encryption problem", c.warning)
        MediaSecurity.TransportOnly -> Triple(Icons.Rounded.GppMaybe, "Encrypted in transit", c.warning)
        // Not verified: no decrypted media proves the key yet. A peer with the wrong key stays here, because
        // WebRTC doesn't report those failures (MediaSecurityTracker), so this must not look like success.
        MediaSecurity.Unknown -> Triple(Icons.Rounded.Shield, if (s.waitingForKey) "Getting encryption key…" else "Verifying encryption…", Color.White.copy(alpha = 0.8f))
    }
    Row(Modifier.clip(Shapes.pill).background(Color.White.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(text, style = Griip.type.caption, color = Color.White)
    }
}

@Composable
private fun CallerHero(s: CallUiState, modifier: Modifier) {
    val t = rememberInfiniteTransition(label = "pulse")
    val pulse by t.animateFloat(1f, 1.18f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "p")
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(s.connectedAt) { while (s.connectedAt != null) { now = System.currentTimeMillis(); delay(1000) } }
    Column(modifier.padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center) {
            val ringing = s.phase == CallPhase.Incoming || s.phase == CallPhase.Outgoing || s.phase == CallPhase.Connecting
            Box(Modifier.size(170.dp).scale(if (ringing) pulse else 1f).clip(CircleShape).background(Griip.colors.primaryBright.copy(alpha = 0.16f)))
            Box(Modifier.size(140.dp).clip(CircleShape).background(Griip.colors.primaryBright.copy(alpha = 0.18f)))
            Avatar(s.title, s.colorIndex, size = 112.dp)
        }
        Spacer(Modifier.height(24.dp))
        Text(s.title, style = Griip.type.display, color = Color.White, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(8.dp))
        // Each stage says what is actually true: an invite sent is not a ringing phone, and a joined room is
        // not flowing media (the timer starts only once remote audio/video bytes arrive).
        val status = when (s.phase) {
            CallPhase.Incoming -> s.subtitle ?: if (s.video) "Incoming video call" else "Incoming voice call"
            CallPhase.Outgoing -> when {
                s.isGroup -> "Waiting for others to join…"
                s.alerted -> "Ringing…"
                else -> "Calling…"
            }
            CallPhase.Connecting -> "Connecting…"
            CallPhase.Reconnecting -> "Reconnecting… the call continues when the connection is back"
            // Everyone else left (or nobody has joined yet): say so, rather than "connecting media".
            CallPhase.Connected -> if (s.participants.none { !it.isLocal }) {
                if (s.isGroup) "Waiting for others to join…" else "Waiting for the other person…"
            } else when (s.media) {
                MediaFlow.Flowing -> s.connectedAt?.let { TimeFmt.duration((now - it) / 1000) } ?: "Connected"
                MediaFlow.Stalled -> "Reconnecting media…"
                else -> "Connecting media…"
            }
            CallPhase.Ended -> when (s.endReason) {
                "declined" -> "Call declined"; "busy" -> "Busy"; "missed" -> "No answer"; "error" -> "Call failed"
                "lost" -> "Call ended: the connection was lost"
                // API 0.33.0: the same account joined the call on another device, which keeps it (newest wins).
                "joined_elsewhere" -> stringResource(R.string.vid_joined_elsewhere)
                else -> "Call ended"
            }
            else -> ""
        }
        Text(status, style = Griip.type.body, color = Color.White.copy(alpha = 0.8f), textAlign = TextAlign.Center)
        if (s.phase == CallPhase.Connected && s.participants.size > 1) {
            Spacer(Modifier.height(6.dp))
            Text("${s.participants.size} in call", style = Griip.type.caption, color = Color.White.copy(alpha = 0.6f))
        }
        val path = s.path
        if (s.phase == CallPhase.Connected && path != null && !path.startsWith("udp")) {
            Spacer(Modifier.height(6.dp))
            Text(
                if (path.startsWith("relay")) "Connected through a relay" else "Connected over TCP: this network may block UDP, so quality can suffer",
                style = Griip.type.caption, color = Color.White.copy(alpha = 0.6f), textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * One person in a group call: their video (camera, or a remote screen share when [preferScreen]), otherwise their
 * avatar and name. Shows mute, speaking (LiveKit's own signal), a weak connection, and an encryption problem.
 */
@Composable
internal fun ParticipantTile(p: ParticipantUi, modifier: Modifier, preferScreen: Boolean = true, compact: Boolean = false, onFlip: (() -> Unit)? = null) {
    val c = Griip.colors
    BoxWithConstraints(
        // The floating redesign (2026-10-28, the owner's call reference): rounded tiles, a lime ring on whoever speaks.
        modifier.clip(Shapes.card).background(com.meldiq.android.ui.components.CallColors.tile)
            .border(if (p.speaking) 3.dp else 1.dp, if (p.speaking) c.accentStart else Color.White.copy(alpha = 0.08f), Shapes.card)
            .semantics(mergeDescendants = true) {
                contentDescription = buildString {
                    append(if (p.isLocal) "You" else p.name)
                    if (!p.micOn) append(", muted")
                    if (p.speaking) append(", speaking")
                    if (!p.cameraOn) append(", camera off")
                    if (p.connectionWeak) append(", weak connection")
                    if (p.e2eeProblem) append(", encryption problem")
                }
            },
    ) {
        // Your own tile shows your camera: drawing your own screen share into the screen being shared recurses.
        val screen = p.screen.takeIf { !p.isLocal && preferScreen }
        val track = screen ?: p.camera
        if (track != null) {
            VideoTile(track, Modifier.fillMaxSize(), mirror = p.mirrored && screen == null, fit = screen != null)
        } else {
            val avatar = (minOf(maxWidth, maxHeight) * 0.42f).coerceIn(36.dp, 96.dp)
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(p.name, p.userId.hashCode(), size = avatar)
                // The camera is on but its video hasn't arrived yet (subscribing, or still decrypting the first frame).
                if (p.cameraOn && !compact) {
                    Spacer(Modifier.height(6.dp))
                    Text("Connecting video…", style = Griip.type.caption, color = Color.White.copy(alpha = 0.7f))
                }
            }
        }
        // Name at the bottom left on a soft shade; muted or speaking in a round badge at the bottom right.
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(44.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.55f)))))
        Text(
            if (p.isLocal) stringResource(R.string.call_you) else p.name, style = Griip.type.label.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
            color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.BottomStart).padding(start = 10.dp, end = 40.dp, bottom = 8.dp),
        )
        when {
            !p.micOn -> Box(Modifier.align(Alignment.BottomEnd).padding(6.dp).size(26.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MicOff, null, tint = Color.White, modifier = Modifier.size(15.dp))
            }
            p.speaking -> Box(Modifier.align(Alignment.BottomEnd).padding(6.dp).size(26.dp).clip(CircleShape).background(c.accentStart), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.GraphicEq, null, tint = c.onAccent, modifier = Modifier.size(15.dp))
            }
        }
        Row(Modifier.align(Alignment.TopEnd).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (p.connectionWeak) TileBadge(Icons.Rounded.SignalCellularConnectedNoInternet0Bar, Griip.colors.warning)
            if (p.e2eeProblem) TileBadge(Icons.Rounded.GppMaybe, Griip.colors.warning)
        }
        // Your own camera tile carries the camera switch (the control bar keeps the audio output instead).
        if (p.isLocal && p.camera != null && onFlip != null && !compact) FlipCameraButton(onFlip, Modifier.align(Alignment.TopStart).padding(6.dp))
    }
}

@Composable
private fun TileBadge(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color) {
    Box(Modifier.size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(14.dp))
    }
}

/**
 * Everyone in a group call at once, in [CallTiles.grid] columns and rows filling the space (portrait and landscape).
 * Tiles are keyed by identity in one layout, so a tile keeps its video renderer when others join, leave or move.
 */
@Composable
private fun ParticipantGrid(participants: List<ParticipantUi>, modifier: Modifier, onFlip: () -> Unit) {
    BoxWithConstraints(modifier) {
        val g = CallTiles.grid(participants.size, landscape = maxWidth > maxHeight)
        Layout(
            content = { participants.forEach { p -> key(p.identity) { ParticipantTile(p, Modifier, onFlip = onFlip) } } },
            modifier = Modifier.fillMaxSize(),
        ) { measurables, constraints ->
            val gap = 8.dp.roundToPx()
            val w = ((constraints.maxWidth - gap * (g.columns - 1)) / g.columns).coerceAtLeast(1)
            val h = ((constraints.maxHeight - gap * (g.rows - 1)) / g.rows).coerceAtLeast(1)
            val placeables = measurables.map { it.measure(Constraints.fixed(w, h)) }
            layout(constraints.maxWidth, constraints.maxHeight) {
                placeables.forEachIndexed { i, pl ->
                    val row = i / g.columns
                    val col = i % g.columns
                    val inRow = if (row == g.rows - 1) placeables.size - row * g.columns else g.columns
                    val x0 = (constraints.maxWidth - (inRow * w + (inRow - 1) * gap)) / 2 // a short last row is centred
                    pl.place(x0 + col * (w + gap), row * (h + gap))
                }
            }
        }
    }
}

/** A shared screen, as large as it fits with its aspect kept, above a strip with everyone's tile. */
@Composable
private fun ScreenStage(
    sharer: ParticipantUi, sharers: List<ParticipantUi>, participants: List<ParticipantUi>, showChrome: Boolean,
    onWatch: (String) -> Unit, onFlip: () -> Unit,
) {
    Column(Modifier.fillMaxSize().windowInsetsPadding(CallInsets).padding(top = if (showChrome) 92.dp else 8.dp, bottom = if (showChrome) 128.dp else 8.dp)) {
        if (sharers.size > 1) ShareTray(sharers, sharer.identity, onWatch)
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            // Keyed by whose screen it is, so switching shares binds the new track instead of reusing the old renderer.
            key(sharer.identity) { VideoTile(sharer.screen, Modifier.fillMaxSize().padding(horizontal = 8.dp).clip(Shapes.panel).background(com.meldiq.android.ui.components.CallColors.tile), fit = true) }
            if (showChrome) ScreenLabel(sharer.name, Modifier.align(Alignment.TopCenter))
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // In the strip the sharer shows their camera (or avatar): their screen is already above.
            participants.forEach { p ->
                key(p.identity) {
                    Box {
                        ParticipantTile(p, Modifier.size(148.dp, 104.dp), preferScreen = false, compact = true)
                        if (p.isLocal && p.camera != null) FlipCameraButton(onFlip, Modifier.align(Alignment.TopEnd).padding(4.dp))
                    }
                }
            }
        }
    }
}

/**
 * Every screen shared in the call (2026-10-24, as on Meldiq Web): Watching on the one shown, Watch on the others. The
 * choice is this phone's only; the others' screens aren't drawn, so the media server stops sending them (adaptive stream).
 */
@Composable
private fun ShareTray(sharers: List<ParticipantUi>, watching: String, onWatch: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        sharers.forEach { p ->
            val on = p.identity == watching
            val label = stringResource(if (on) R.string.vid_share_watching else R.string.vid_share_watch)
            Row(
                Modifier.clip(Shapes.pill).background(if (on) Color.White.copy(alpha = 0.28f) else Color.White.copy(alpha = 0.12f))
                    .pressable({ if (!on) onWatch(p.identity) }, onClickLabel = stringResource(R.string.vid_share_of, p.name))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.ScreenShare, null, tint = Color.White, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.vid_share_of, p.name), style = Griip.type.label, color = Color.White, maxLines = 1)
                Spacer(Modifier.width(8.dp))
                Text(label, style = Griip.type.caption, color = Color.White.copy(alpha = if (on) 1f else 0.75f))
            }
        }
    }
}

@Composable
private fun ScreenLabel(name: String, modifier: Modifier) {
    Text(
        "$name is sharing their screen", style = Griip.type.label, color = Color.White,
        modifier = modifier.padding(top = 8.dp).clip(Shapes.pill).background(Color.Black.copy(alpha = 0.45f)).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

/**
 * Who is in the call and their state, readable without relying on the tiles (also for screen readers). In a voice
 * room, raised hands come first and the room's managers get Mute, Lower hand and Remove for each person.
 */
@Composable
private fun PeoplePanel(s: CallUiState, modifier: Modifier, onModerate: (String, String) -> Unit, onClose: () -> Unit) {
    val participants = if (s.voiceRoom) s.participants.sortedBy { p -> s.hands.indexOf(p.userId).let { if (it < 0) Int.MAX_VALUE else it } } else s.participants
    Column(
        modifier.fillMaxWidth().widthIn(max = 520.dp).clip(Shapes.tile).background(Color.Black.copy(alpha = 0.75f))
            .pressable(onClose, onClickLabel = "Close the list of people").padding(14.dp),
    ) {
        Text("${participants.size} in this call", style = Griip.type.label, color = Color.White)
        participants.forEach { p ->
            var menu by remember { mutableStateOf(false) }
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(p.name, p.userId.hashCode(), size = 28.dp, ring = false)
                Spacer(Modifier.width(10.dp))
                Text(if (p.isLocal) "You" else p.name, style = Griip.type.bodySmall, color = Color.White, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (p.userId in s.hands) Icon(Icons.Rounded.PanTool, "Hand raised", tint = Griip.colors.warning, modifier = Modifier.padding(end = 6.dp).size(16.dp))
                if (s.voiceRoom && s.canModerate && !p.isLocal) {
                    Box {
                        Icon(
                            Icons.Rounded.MoreVert, "Moderate ${p.name}", tint = Color.White,
                            modifier = Modifier.size(28.dp).clip(CircleShape).pressable({ menu = true }, onClickLabel = "Moderate ${p.name}").padding(4.dp),
                        )
                        androidx.compose.material3.DropdownMenu(menu, { menu = false }) {
                            androidx.compose.material3.DropdownMenuItem({ Text("Mute microphone") }, { menu = false; onModerate(p.userId, "mute") })
                            if (p.userId in s.hands) androidx.compose.material3.DropdownMenuItem({ Text("Lower hand") }, { menu = false; onModerate(p.userId, "lower_hand") })
                            androidx.compose.material3.DropdownMenuItem({ Text("Remove from call") }, { menu = false; onModerate(p.userId, "remove") })
                        }
                    }
                }
                val status = listOfNotNull(
                    if (p.speaking) "speaking" else null,
                    if (p.micOn) null else "muted",
                    if (p.cameraOn) "camera" else null,
                    if (p.screen != null) "sharing" else null,
                    if (p.connectionWeak) "weak connection" else null,
                    if (p.e2eeProblem) "encryption problem" else null,
                ).joinToString(" · ")
                Text(status, style = Griip.type.caption, color = Color.White.copy(alpha = 0.7f))
            }
        }
    }
}

/**
 * LiveKit video sink rendered through a TextureView so it composes with rounded clipping.
 * [VideoSinkBinding] owns the renderer: the sink is attached only while the screen is started (frames pushed into a
 * destroyed surface, e.g. under the screen-share consent dialog, crashed WebRTC natively), and the renderer is
 * released only when the view itself is removed.
 */
@Composable
fun VideoTile(track: VideoTrack?, modifier: Modifier, mirror: Boolean = false, fit: Boolean = false) {
    val container = LocalContainer.current
    val room by container.calls.roomFlow.collectAsStateWithLifecycle()
    val r0 = room
    if (track == null || r0 == null) {
        Box(modifier.background(Color.Black.copy(alpha = 0.3f)))
        return
    }
    key(r0) {
        val binding = remember {
            VideoSinkBinding<VideoTrack, TextureViewRenderer>(
                addSink = { t, r ->
                    runCatching { t.addRenderer(r) }
                    if (BuildConfig.DEBUG) Log.i("CallDiag", "renderer attach ${t.javaClass.simpleName} sid=${t.sid?.takeLast(6)} view=${r.width}x${r.height} shown=${r.isShown}")
                },
                removeSink = { t, r ->
                    runCatching { t.removeRenderer(r) }
                    if (BuildConfig.DEBUG) Log.i("CallDiag", "renderer detach sid=${t.sid?.takeLast(6)}")
                },
                releaseRenderer = { r ->
                    runCatching { r.release() }
                    if (BuildConfig.DEBUG) Log.i("CallDiag", "renderer released")
                },
            )
        }
        // The renderer letterboxes (FIT) only when measured with loose constraints, so a fitted tile is centred in a
        // Box instead of being forced to the tile's exact size, which crops the frame.
        Box(modifier, contentAlignment = Alignment.Center) {
            AndroidView(
                factory = { ctx -> TextureViewRenderer(ctx).also { r -> r0.initVideoRenderer(r); binding.setRenderer(r) } },
                update = { r ->
                    r.setMirror(mirror)
                    r.setScalingType(if (fit) livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FIT else livekit.org.webrtc.RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                },
                onRelease = { binding.release() },
                modifier = if (fit) Modifier else Modifier.fillMaxSize(),
            )
        }
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        DisposableEffect(track, lifecycle) {
            binding.bind(track)
            val observer = androidx.lifecycle.LifecycleEventObserver { _, e ->
                binding.setStarted(e.targetState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED))
            }
            lifecycle.addObserver(observer)
            onDispose {
                lifecycle.removeObserver(observer)
                binding.bind(null)
            }
        }
    }
}

/**
 * The call screen keeps clear of the system bars and cutouts but not of the keyboard (UI-003): a chat's keyboard left open
 * when a call came in pushed Accept and Decline up over the caller's name. The call screen also closes the keyboard.
 */
internal val CallInsets: WindowInsets @Composable get() = WindowInsets.systemBars.union(WindowInsets.displayCutout)
private val SafeTop: WindowInsets @Composable get() = CallInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
private val SafeBottom: WindowInsets @Composable get() = CallInsets.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)

/** When the call controls can be hidden (unit-tested in `CallMediaPolicyTest`). */
object CallChrome {
    /**
     * UI-003: only by the person, with a tap on the video, in a connected call with video and no menu, prompt or error
     * open. Never on a timer: the old 4-second auto-hide made the speaker and the other controls "disappear".
     */
    fun canHide(hasVideo: Boolean, phase: CallPhase, menuOpen: Boolean): Boolean = hasVideo && phase == CallPhase.Connected && !menuOpen
}

/** The call's name, state and time, and how many are in it (under the top buttons; also read by screen readers). */
@Composable
private fun CallStatusLine(s: CallUiState, modifier: Modifier) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(s.connectedAt) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(s.title, style = Griip.type.titleSmall, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("  ·  " + MiniCallText.status(s, now), style = Griip.type.caption, color = Color.White.copy(alpha = 0.8f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Measured numbers for the call, to check quality on real phones (both sides can open it and compare). */
@Composable
private fun ConnectionDetails(s: CallUiState, modifier: Modifier, onClose: () -> Unit) {
    val st = s.stats
    Column(
        modifier.fillMaxWidth().widthIn(max = 520.dp).clip(Shapes.tile).background(Color.Black.copy(alpha = 0.72f)).pressable(onClose, onClickLabel = "Close connection details").padding(14.dp),
    ) {
        Text("Connection details", style = Griip.type.label, color = Color.White)
        Spacer(Modifier.height(6.dp))
        @Composable fun line(label: String, value: String?) {
            Row(Modifier.padding(vertical = 2.dp)) {
                Text(label, style = Griip.type.caption, color = Color.White.copy(alpha = 0.65f), modifier = Modifier.width(118.dp))
                Text(value ?: "—", style = Griip.type.caption, color = Color.White)
            }
        }
        line("Network path", s.path)
        line("Audio route", st?.audioRoute)
        // UI-003 loudness diagnostics: measured, so "too quiet" can be told apart (volume, sender level, network).
        line("Call volume", st?.callVolume)
        line("Receiving audio", st?.receivingAudio?.describe())
        line("Your microphone", st?.sendingAudioDb?.let { if (it <= com.meldiq.android.call.AudioStats.SILENT_DB) "silent" else "level $it dBFS" })
        line("Echo cancelling", st?.echoCanceller)
        line("Sending camera", st?.sendingCamera?.describe())
        if (st?.sendingScreen != null) line("Sending screen", st.sendingScreen.describe())
        line("Receiving video", st?.receivingVideo?.describe())
        if (st?.receivingScreen != null) line("Receiving screen", st.receivingScreen.describe())
    }
}

/**
 * The call's verification code (CallVerification): the same on every phone that holds this call's encryption key.
 * Compared aloud or side by side, it shows that nobody substituted the key; it isn't decoration, and a call that isn't
 * end-to-end encrypted has none.
 */
@Composable
private fun VerificationPanel(s: CallUiState, modifier: Modifier, onClose: () -> Unit) {
    val code = s.verification
    Column(modifier.fillMaxWidth().clip(Shapes.tile).background(Color.Black.copy(alpha = 0.55f)).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Verify this call", style = Griip.type.titleSmall, color = Color.White, modifier = Modifier.weight(1f))
            Box(Modifier.size(32.dp).clip(CircleShape).pressable(onClose, onClickLabel = "Close"), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Close, "Close", tint = Color.White, modifier = Modifier.size(18.dp))
            }
        }
        Spacer(Modifier.height(8.dp))
        if (code == null) {
            Text(
                "This call has no media key, so there is no code to compare. Turn on encrypted calls in Settings › Calls.",
                style = Griip.type.bodySmall, color = Color.White.copy(alpha = 0.85f),
            )
            return@Column
        }
        Text(code.emoji.joinToString("  "), fontSize = 34.sp, modifier = Modifier.align(Alignment.CenterHorizontally).semantics { contentDescription = "Verification emoji ${code.emoji.joinToString(" ")}" })
        Text(code.digits, style = Griip.type.title.copy(letterSpacing = 3.sp), color = Color.White, modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp))
        Spacer(Modifier.height(8.dp))
        Text(
            if (s.isGroup) "Everyone in this call should see the same emoji and digits." else "${s.title} should see the same emoji and digits.",
            style = Griip.type.bodySmall, color = Color.White,
        )
        Text(
            "Derived from this call's encryption key, which the caller sent through your chat. If they match, " +
                "your media is encrypted with the same key on both ends and no one replaced it. To be sure who you're talking to, " +
                "compare safety numbers in the person's profile. A new call has a new code.",
            style = Griip.type.caption, color = Color.White.copy(alpha = 0.8f), modifier = Modifier.padding(top = 6.dp),
        )
    }
}

/**
 * The call in picture-in-picture: the other person's video (or shared screen), else their avatar and the call's state.
 * Controls are the window's own Mute and Hang up buttons; tapping the window opens the full call screen.
 */
@Composable
fun CallPipView(s: CallUiState) {
    val remote = s.participants.firstOrNull { !it.isLocal && it.screen != null && it.identity == s.watchingShare }
        ?: s.participants.firstOrNull { !it.isLocal && it.screen != null } ?: s.participants.firstOrNull { !it.isLocal }
    val track = remote?.screen ?: remote?.camera
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        if (track != null) VideoTile(track, Modifier.fillMaxSize(), fit = remote?.screen != null)
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Avatar(s.title, s.colorIndex, size = 56.dp)
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    s.phase == CallPhase.Reconnecting || s.peerReconnecting -> "Reconnecting…"
                    !s.micOn -> "Muted"
                    else -> s.title
                },
                style = Griip.type.caption, color = Color.White, maxLines = 1,
            )
        }
        if (!s.micOn) {
            Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MicOff, "Muted", tint = Color.White, modifier = Modifier.size(14.dp))
            }
        }
    }
}
