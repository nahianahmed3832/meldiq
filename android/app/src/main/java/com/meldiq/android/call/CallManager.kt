package com.meldiq.android.call

import com.meldiq.android.R

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.meldiq.android.crypto.b64
import com.meldiq.android.crypto.randomBytes
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ApiException
import com.meldiq.android.data.api.CallDto
import com.meldiq.android.data.api.CallEvents
import com.meldiq.android.data.api.CallRes
import com.meldiq.android.data.api.CallsRes
import com.meldiq.android.data.api.DeclineCallReq
import com.meldiq.android.data.api.MediaGrant
import com.meldiq.android.data.api.StartCallReq
import com.meldiq.android.data.api.GriipJson
import com.meldiq.android.data.api.HandReq
import com.meldiq.android.data.api.ModerateReq
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import com.meldiq.android.data.db.CallLogEntity
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.data.repo.MessageRepository
import com.meldiq.android.data.repo.SessionRepository
import com.meldiq.android.data.repo.SettingsStore
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.LiveKit
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKitOverrides
import io.livekit.android.room.participant.ConnectionQuality
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.VideoPreset169
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.livekit.android.audio.ScreenAudioCapturer
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

enum class CallPhase { Idle, Incoming, Outgoing, Connecting, Connected, Reconnecting, Ended }

enum class MediaSecurity { Unknown, E2eeActive, E2eeProblem, TransportOnly }

data class ParticipantUi(
    val identity: String,
    val userId: String,
    val name: String,
    val isLocal: Boolean,
    val speaking: Boolean,
    val micOn: Boolean,
    val camera: VideoTrack?,
    val screen: VideoTrack?,
    /** The camera is published and on, even if its video hasn't arrived yet ("connecting video"). */
    val cameraOn: Boolean = camera != null,
    /** LiveKit rates this person's connection poor or lost. */
    val connectionWeak: Boolean = false,
    /** This person's media reports an encryption failure (never hidden to make video show). */
    val e2eeProblem: Boolean = false,
    /** Draw this camera mirrored: only your own front camera (round 7, [CallMediaPolicy.mirrorPreview]). */
    val mirrored: Boolean = false,
)

data class CallUiState(
    val phase: CallPhase = CallPhase.Idle,
    val callId: String? = null,
    val conversationId: String? = null,
    val title: String = "",
    val subtitle: String? = null,
    val colorIndex: Int = 0,
    val video: Boolean = false,
    val isGroup: Boolean = false,
    val micOn: Boolean = true,
    /** Batch B10: you hear nobody and nobody hears you (the microphone comes back as it was when you undeafen). */
    val deafened: Boolean = false,
    val cameraOn: Boolean = false,
    val screenSharing: Boolean = false,
    /** Batch B11: what this share is tuned for, and whether app sound goes with it (both only while sharing). */
    val shareMode: ShareMode = ShareMode.TEXT,
    val shareAppSound: Boolean = false,
    /** Whose shared screen this phone shows when several are shared ([CallTiles.watchedShare]); null: nobody shares. */
    val watchingShare: String? = null,
    /** The call's sound is on the speaker now (from [audioRoute]; kept for the picture-in-picture and older callers). */
    val speakerOn: Boolean = false,
    val participants: List<ParticipantUi> = emptyList(),
    val connectedAt: Long? = null,
    val security: MediaSecurity = MediaSecurity.Unknown,
    val error: String? = null,
    val endReason: String? = null,
    val waitingForKey: Boolean = false,
    /** Outgoing: a recipient device confirmed it is ringing ("Ringing…" instead of "Calling…"). */
    val alerted: Boolean = false,
    /** Whether remote media actually arrives (inbound bytes), separate from the room being connected. */
    val media: MediaFlow = MediaFlow.None,
    /** Redacted network path of the media, e.g. "udp · direct" or "tcp · direct"; null until known. */
    val path: String? = null,
    /** Measured frame sizes, frame rates and bitrates, sent and received (the call's "Connection details"). */
    val stats: CallMediaStats? = null,
    /** LiveKit rates this phone's or the other person's connection poor or lost: video quality is reduced. */
    val connectionWeak: Boolean = false,
    /** The call's verification code, from its end-to-end encryption key (null: the call isn't end-to-end encrypted). */
    val verification: CallVerification.Code? = null,
    /** 1:1: the other person's connection dropped; the call waits [CallRecovery.PEER_WINDOW_MS] for them. */
    val peerReconnecting: Boolean = false,
    /** The output the phone reports for the call's sound now (UI-003); null until LiveKit has started its audio. */
    val audioRoute: AudioRoute? = null,
    /** The outputs this call can use (speaker, earpiece, a headset…). */
    val audioRoutes: List<AudioRoute> = emptyList(),
    /** A route change the phone didn't apply; shown with the route picker until the next change. */
    val routeError: String? = null,
    /** Whether sound actually arrives (inbound audio bytes) from the people whose microphone is on. */
    val remoteAudio: MediaFlow = MediaFlow.None,
    /** A short notice for the call screen ("Screen sharing stopped"); cleared when shown. */
    val notice: String? = null,
    /** A voice room's call (round 6): people raise hands, and the room's managers can moderate. */
    val voiceRoom: Boolean = false,
    /**
     * A voice channel where you may only listen (no `voice.speak`): the server's media token can't publish, so the
     * microphone, camera and screen sharing stay off and their buttons say why.
     */
    val listenOnly: Boolean = false,
    /** Voice rooms: who raised a hand, in order. */
    val hands: List<String> = emptyList(),
    /** Voice rooms: whether you manage this room (mute, lower hands, remove from the call). */
    val canModerate: Boolean = false,
)

/**
 * Owns the single active LiveKit room. Media E2EE keys are generated by the caller and distributed
 * to member devices through the end-to-end encrypted message channel (MessageRepository.sendCallKey),
 * never through the server's call API. If E2EE is on and no key is available, we refuse to join
 * rather than silently downgrade (docs/SECURITY.md §7).
 */
class CallManager(
    private val context: Context,
    private val api: ApiClient,
    private val db: GriipDatabase,
    private val session: SessionRepository,
    private val messages: MessageRepository,
    private val conversations: ConversationRepository,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(CallUiState())
    val state: StateFlow<CallUiState> = _state
    private val _live = MutableStateFlow<Map<String, LiveCall>>(emptyMap())
    /** Live calls by conversation, from the server's call events: what rows show without joining (API 0.42.0). */
    val live: StateFlow<Map<String, LiveCall>> = _live
    private val _ringChecks = MutableStateFlow(0)
    /** Ring-recovery checks finished (each drained backlog runs one): a push wake-up waits for its check. */
    val ringChecks: StateFlow<Int> = _ringChecks
    private val _room = MutableStateFlow<Room?>(null)
    /** Observed by the call UI; set to null first on teardown so video sinks detach before native release. */
    val roomFlow: StateFlow<Room?> = _room
    var room: Room?
        get() = _room.value
        private set(value) { _room.value = value }
    private var eventsJob: Job? = null
    private var cryptorGuard: FrameCryptorGuard? = null
    /** This call's badge evidence (null without E2EE). Fed from room events and, through [cryptorGuard], WebRTC's signaling thread. */
    @Volatile private var securityTracker: MediaSecurityTracker? = null
    /** Publishing the badge and swapping [securityTracker] happen under this lock, so an ended call's callbacks can't touch the next call. */
    private val securityLock = Any()
    private val diag = CallDiagnostics(scope)
    /** Calls this device already rang, answered, declined or ended: ring recovery never re-rings them. Bounded. */
    private val handled = LinkedHashSet<String>()
    private var mediaJob: Job? = null
    /** The previous call's native teardown; a new call waits for it, so two rooms never hold the microphone and speaker at once. */
    private var releaseJob: Job? = null
    private var audioListener: ((List<AudioDevice>, AudioDevice?) -> Unit)? = null
    private val sampler = VideoStatsSampler()
    private val audioSampler = AudioStatsSampler()
    private val audioManager by lazy { context.getSystemService(AudioManager::class.java) }
    /** The output the person picked in this call (re-applied after a rejoin); null: automatic (CallAudioPolicy). */
    @Volatile private var userRoute: AudioRoute? = null
    /** The room whose first device list has been handled (the person's choice re-applied once per room). */
    @Volatile private var routedRoom: Room? = null
    private var routeCheck: Job? = null
    /** Our own Stop (vs. Android or the status bar stopping the capture): only the latter gets a notice. */
    @Volatile private var stoppingShare = false
    /** Follows display rotation during a screen share (round 7, bug 4). */
    private val shareRotation = ScreenShareRotation(context, diag::log)
    /** A camera switch in progress: further taps wait for it (round 7, bug 3). */
    @Volatile private var cameraSwitching = false
    /** Batch B10: whether the microphone was on when you deafened, so undeafening puts it back. */
    private var micBeforeDeafen = false
    /** Call-setup timings, stage names and milliseconds only (round 7, bug 7). */
    private val timeline = CallTimeline()

    private fun stage(name: String) {
        timeline.mark(name)?.let { diag.log("call stage: $name at $it ms") }
    }
    /** One teardown per call even when a hang-up, an "ended" event and a disconnect arrive on different threads at once. */
    private val finishLock = Any()
    private val _minimized = MutableStateFlow(false)
    /**
     * The call shrunk to the in-app call panel (UI-003) while the person uses the rest of Meldiq. It lives here, not in the
     * call screen, so navigation, rotation, picture-in-picture and the notification's "return to call" all agree on it.
     */
    val minimized: StateFlow<Boolean> = _minimized
    /** When each participant identity was first seen in this call: tiles keep their places as people come and go. */
    private val firstSeen = HashMap<String, Long>()
    private var seenCounter = 0L

    /**
     * WebRTC's native library must be loaded before any LiveKit native object exists — including the
     * E2EE key provider, which is created before the Room. LiveKit.init does that (once).
     */
    private val webrtcReady by lazy { LiveKit.init(context.applicationContext) }

    fun start() {
        scope.launch {
            messages.callFrames.collect { f ->
                val call = f.call
                // Call history: the conversation's entry for this call follows the server's record of it.
                // A voice room's comings and goings aren't calls in the conversation's history.
                if (!call.voiceRoom && (f.event == CallEvents.RING || f.event == CallEvents.STARTED || f.event == CallEvents.ENDED)) scope.launch { runCatching { messages.recordCall(call) } }
                if (call.id == _state.value.callId && call.voiceRoom) _state.update { it.copy(voiceRoom = true, hands = call.hands) }
                // The conversation's "call in progress · Join" banner follows the call's own events. It used to change only
                // when the conversation list was reloaded, so it stayed after the call had ended (seen on the phone, UI-003).
                scope.launch { runCatching { syncActiveCall(call, f.event) } }
                when (f.event) {
                    CallEvents.RING -> onRing(call)
                    CallEvents.ENDED -> if (call.id == _state.value.callId) finish(remoteReason = call.endReason ?: "ended", notifyServer = false)
                    CallEvents.DISMISSED -> if (call.id == _state.value.callId && _state.value.phase == CallPhase.Incoming) finish("answered elsewhere", false)
                    CallEvents.DECLINED -> if (call.id == _state.value.callId && !_state.value.isGroup) finish("declined", false)
                    CallEvents.UPDATED -> if (call.id == _state.value.callId && call.state == "ACTIVE" && _state.value.phase == CallPhase.Incoming && call.conversationType != "DM") {
                        // Group call already running: keep the banner but stop ringing UI.
                        IncomingCallNotifier.cancel(context)
                    }
                    CallEvents.ALERTED -> if (call.id == _state.value.callId && _state.value.phase == CallPhase.Outgoing) _state.update { it.copy(alerted = true) }
                    // A voice room's manager muted this phone's microphone: show it off here too (only you can turn it on).
                    CallEvents.MODERATED -> if (call.id == _state.value.callId && f.action == "mute") {
                        scope.launch { runCatching { room?.localParticipant?.setMicrophoneEnabled(false) }; refreshParticipants() }
                        _state.update { it.copy(notice = "A room manager muted your microphone") }
                    }
                }
            }
        }
        scope.launch { messages.callInvites.collect { /* key arrival is read from DB when joining */ } }
        // The ongoing-call notification follows the call (mute, sharing, connected time) with its own actions (UI-003).
        scope.launch {
            state.map { CallService.Info.of(it) }.distinctUntilChanged().collect { info -> if (info != null && room != null) CallService.update(context, info) }
        }
        // Ring recovery: the server rings only live sockets, so after every reconnect (once the backlog,
        // and with it any call key, has drained) look for calls that started ringing while we were away.
        scope.launch { messages.backlogDrained.collect { drained -> if (drained) recoverRinging() } }
    }

    private suspend fun syncActiveCall(call: CallDto, event: String) {
        when {
            event == "ended" || call.state == "ENDED" -> {
                db.conversations().clearActiveCall(call.conversationId, call.id)
                _live.update { all -> if (all[call.conversationId]?.callId == call.id) all - call.conversationId else all }
            }
            event == "ring" || event == "started" || event == "updated" -> {
                db.conversations().setActiveCall(call.conversationId, call.id, call.video)
                _live.update { it + (call.conversationId to LiveCall.of(call)) }
                if (call.voiceRoom) {
                    val people = call.participants.map { it.userId }.distinct()
                    db.conversations().setRoomPeople(call.conversationId, GriipJson.encodeToString(ListSerializer(String.serializer()), people))
                }
            }
        }
    }

    /** Voice rooms: raise or lower your hand (everyone in the room sees the queue). */
    fun raiseHand(raised: Boolean) = scope.launch {
        val id = _state.value.callId ?: return@launch
        runCatching { api.post<HandReq, CallRes>("/v1/calls/$id/hand", HandReq(raised)) }
            .onSuccess { r -> _state.update { it.copy(hands = r.call.hands) } }
            .onFailure { e -> _state.update { it.copy(notice = (e as? ApiException)?.message ?: "Couldn't change your hand") } }
    }

    /** Voice rooms, for the room's managers: "mute", "lower_hand" or "remove" someone. */
    fun moderate(userId: String, action: String) = scope.launch {
        val id = _state.value.callId ?: return@launch
        runCatching { api.post<ModerateReq, CallRes>("/v1/calls/$id/moderate", ModerateReq(userId, action)) }
            .onSuccess { r -> _state.update { it.copy(hands = r.call.hands) } }
            .onFailure { e -> _state.update { it.copy(notice = (e as? ApiException)?.message ?: "That didn't work. Try again.") } }
    }

    private suspend fun recoverRinging() {
        try {
            val calls = runCatching { api.get<CallsRes>("/v1/calls/active").calls }.getOrNull() ?: return
            val me = session.session?.userId
            val now = System.currentTimeMillis()
            for (c in calls) {
                if (RingRecovery.shouldRing(c, me, now, synchronized(handled) { handled.toSet() }, idle = _state.value.phase == CallPhase.Idle)) {
                    Log.i(TAG, "ring recovered after reconnect")
                    onRing(c)
                }
            }
        } finally {
            _ringChecks.update { it + 1 }
        }
    }

    private fun markHandled(id: String?) {
        id ?: return
        synchronized(handled) {
            handled += id
            if (handled.size > 64) handled.remove(handled.first())
        }
    }

    private suspend fun onRing(call: CallDto) {
        if (synchronized(handled) { call.id in handled }) return // a repeated or recovered ring for a call already dealt with
        if (_state.value.phase != CallPhase.Idle) {
            // Busy: tell a 1:1 caller at once instead of leaving them ringing; group calls can be joined later.
            if (call.id != _state.value.callId && call.conversationType == "DM") {
                markHandled(call.id)
                scope.launch { runCatching { api.post<DeclineCallReq, CallRes>("/v1/calls/${call.id}/decline", DeclineCallReq("busy")) } }
            }
            return
        }
        markHandled(call.id)
        timeline.begin("callee")
        _minimized.value = false
        val conv = db.conversations().get(call.conversationId) ?: conversations.refreshOne(call.conversationId)
        val me = session.session?.userId
        val title = conv?.let { ConversationRepository.title(it, me) } ?: "Incoming call"
        val caller = db.users().get(call.createdBy)
        _state.value = CallUiState(
            phase = CallPhase.Incoming, callId = call.id, conversationId = call.conversationId,
            title = if (conv?.type == "DM") caller?.displayName ?: title else title,
            subtitle = if (conv?.type == "DM") null else "${caller?.displayName ?: "Someone"} is calling",
            colorIndex = caller?.avatarColor ?: 0, video = call.video, isGroup = conv?.type != "DM",
        )
        db.calls().upsertLog(CallLogEntity(call.id, call.conversationId, call.video, false, call.createdAt, peerName = _state.value.title))
        IncomingCallNotifier.show(context, call.id, _state.value.title, call.video)
        // Tell the caller this device is actually ringing ("Ringing…" rather than "Calling…").
        scope.launch { runCatching { api.post<CallRes>("/v1/calls/${call.id}/alerted") } }
    }

    suspend fun startCall(conversationId: String, video: Boolean) {
        if (_state.value.phase != CallPhase.Idle) return
        val conv = db.conversations().get(conversationId)
        val me = session.session?.userId
        _state.value = CallUiState(
            // A voice room doesn't ring anyone: straight to connecting.
            phase = if (conv?.voice == true) CallPhase.Connecting else CallPhase.Outgoing,
            conversationId = conversationId, title = conv?.let { ConversationRepository.title(it, me) } ?: "Call",
            colorIndex = conv?.let { ConversationRepository.peer(it, me)?.avatarColor } ?: 0, video = video, cameraOn = video,
            isGroup = conv?.type != "DM", voiceRoom = conv?.voice == true, canModerate = conv?.voice == true && conv.canManage,
        )
        timeline.begin("caller")
        try {
            val res = try {
                api.post<StartCallReq, CallRes>("/v1/calls", StartCallReq(conversationId, video))
            } catch (e: ApiException) {
                scope.launch { runCatching { messages.recordFailedCall(conversationId, video) } }
                throw e
            }
            markHandled(res.call.id)
            stage("call created")
            _state.update { it.copy(callId = res.call.id, alerted = res.call.alertedAt != null, hands = res.call.hands) }
            // Round 7 (bug 7): the encrypted key message goes out while this phone connects to the media room. This
            // phone already has the key; only the callee needs the message, before it joins (it waits for it).
            val key = if (res.joinedExisting) waitForKey(res.call.id) else newKey().also { k -> sendKeyInBackground(conversationId, res.call.id, video, k) }
            db.calls().upsertLog(CallLogEntity(res.call.id, conversationId, video, !res.joinedExisting, System.currentTimeMillis(), peerName = _state.value.title))
            connect(res.call.id, res.media!!, key, video)
        } catch (e: ApiException) {
            fail(e.message)
        }
    }

    suspend fun accept() {
        val s = _state.value
        val callId = s.callId ?: return
        IncomingCallNotifier.cancel(context)
        stage("accepted")
        _state.update { it.copy(phase = CallPhase.Connecting, cameraOn = it.video) }
        try {
            // Round 7 (bug 7): asking to join and waiting for the key (usually already here) run side by side.
            coroutineScope {
                val join = async { api.post<CallRes>("/v1/calls/$callId/join").also { stage("join granted") } }
                val key = async { waitForKey(callId).also { stage("key ready") } }
                connect(callId, join.await().media!!, key.await(), s.video)
            }
        } catch (e: ApiException) {
            fail(CallFailure.forApi(e))
        }
    }

    /** Join an already running group call from a conversation banner. */
    suspend fun join(conversationId: String, callId: String, video: Boolean) {
        if (_state.value.phase != CallPhase.Idle) return
        val conv = db.conversations().get(conversationId)
        _state.value = CallUiState(phase = CallPhase.Connecting, callId = callId, conversationId = conversationId, title = conv?.let { ConversationRepository.title(it, session.session?.userId) } ?: "Call", video = video, cameraOn = video, isGroup = conv?.type != "DM")
        try {
            val res = api.post<CallRes>("/v1/calls/$callId/join")
            connect(callId, res.media!!, waitForKey(callId), video)
        } catch (e: ApiException) {
            fail(e.message)
        }
    }

    fun decline() {
        val id = _state.value.callId ?: return
        markHandled(id)
        IncomingCallNotifier.cancel(context)
        scope.launch {
            db.calls().getLog(id)?.let { db.calls().upsertLog(it.copy(endedAt = System.currentTimeMillis(), endReason = "declined")) }
            runCatching { api.post<CallRes>("/v1/calls/$id/decline") }.onSuccess { runCatching { messages.recordCall(it.call) } }
        }
        reset()
    }

    private fun newKey(): String = randomBytes(32).b64()

    /** The key arrives as an E2EE control message; it may land a moment after the ring event. */
    private suspend fun waitForKey(callId: String): String? {
        if (!settings.current.mediaE2ee) return null
        _state.update { it.copy(waitingForKey = true) }
        repeat(KEY_WAIT_STEPS) {
            messages.callKey(callId)?.let { k -> _state.update { it.copy(waitingForKey = false) }; return k }
            delay(KEY_WAIT_STEP_MS)
        }
        _state.update { it.copy(waitingForKey = false) }
        throw ApiException(0, "no_key", "Couldn't get this call's encryption key, so the call wasn't joined. Ask the caller to try again.")
    }

    private suspend fun connect(callId: String, media: MediaGrant, key: String?, video: Boolean) {
        _state.update {
            it.copy(
                phase = if (it.phase == CallPhase.Outgoing) CallPhase.Outgoing else CallPhase.Connecting, callId = callId,
                listenOnly = !media.canSpeak, micOn = media.canSpeak && it.micOn,
            )
        }
        // A call right after another: let the previous room finish releasing its audio device first.
        releaseJob?.let { if (it.isActive) diag.log("waiting for the previous call's media to release") ; it.join() }
        val r = try {
            webrtcReady
            _state.update { it.copy(verification = key?.let { k -> CallVerification.code(k, callId) }) }
            val e2ee = key?.let { k ->
                val provider = BaseKeyProvider()
                provider.setSharedKey(k, null)
                E2EEOptions(keyProvider = provider)
            }
            val hwAec = CallMediaPolicy.useHardwareEchoCanceller(settings.current.hardwareEchoCanceller)
            diag.log(CallMediaPolicy.describeAudio(android.os.Build.MODEL, android.os.Build.VERSION.SDK_INT, JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported(), hwAec))
            _state.update { it.copy(stats = CallMediaStats(echoCanceller = if (hwAec && JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported()) "phone (hardware)" else "Meldiq (WebRTC AEC3)")) }
            LiveKit.create(
                context.applicationContext,
                roomOptions(e2ee),
                LiveKitOverrides(
                    audioOptions = AudioOptions(
                        javaAudioDeviceModuleCustomizer = { b ->
                            b.setUseHardwareAcousticEchoCanceler(hwAec)
                            // Round 7 (bugs 1 and 5): only WebRTC's noise suppressor; two in a row muffle speech.
                            b.setUseHardwareNoiseSuppressor(CallMediaPolicy.USE_HARDWARE_NOISE_SUPPRESSOR)
                        },
                    ),
                ),
            )
        } catch (t: Throwable) {
            // UnsatisfiedLinkError etc. are Errors, not Exceptions: never let media setup crash the app.
            Log.e(TAG, "media engine init failed: ${t.javaClass.simpleName}")
            fail("Couldn't start the call engine on this device.")
            return
        }
        room = r
        stage("engine ready")
        diag.start(r)
        val tracker = if (key != null) MediaSecurityTracker() else null
        synchronized(securityLock) { securityTracker = tracker }
        cryptorGuard = tracker?.let { t -> FrameCryptorGuard(onState = { k, st -> if (room === r) onE2eeState(t, k, st) }, log = diag::log) }
        _state.update { it.copy(security = if (key != null) MediaSecurity.Unknown else MediaSecurity.TransportOnly) }
        eventsJob = scope.launch { r.events.events.collect { ev -> onRoomEvent(ev) } }
        // Set before connecting, when LiveKit starts the phone's call audio: a headset first, then the speaker for video
        // and group calls, the earpiece for 1:1 voice calls. LiveKit's own default put the speaker first for every call.
        r.audioSwitchHandler?.preferredDeviceList = CallAudioPolicy.preferred(video, _state.value.isGroup).mapNotNull(::deviceClass)
        CallService.start(context, CallService.Info.of(_state.value) ?: CallService.Info(_state.value.title, video, _state.value.isGroup))
        val t0 = System.currentTimeMillis()
        try {
            r.connect(media.url, media.token)
        } catch (e: Throwable) {
            Log.w(TAG, "connect failed after ${System.currentTimeMillis() - t0} ms: ${e.javaClass.simpleName}")
            fail(CallFailure.forConnect(e))
            return
        }
        diag.log("media room joined in ${System.currentTimeMillis() - t0} ms")
        stage("media joined")
        startMediaMonitor(r)
        // Microphone and camera publish side by side (LiveKit locks each source on its own; round 7, bug 7). A listener
        // publishes nothing: the token would refuse it anyway.
        if (!media.canSpeak) _state.update { it.copy(notice = CallFailure.LISTEN_ONLY) }
        // The user panel's microphone and headphones (Settings.joinMuted / joinDeafened): the call starts as they say.
        val joinMuted = settings.current.joinMuted || settings.current.joinDeafened
        if (settings.current.joinDeafened) {
            micBeforeDeafen = !settings.current.joinMuted
            _state.update { it.copy(deafened = true) }
            applyDeafen(r)
        }
        if (media.canSpeak) coroutineScope {
            if (!joinMuted) launch {
                try {
                    r.localParticipant.setMicrophoneEnabled(true)
                    stage("mic on")
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    _state.update { it.copy(error = CallFailure.MICROPHONE) }
                }
            }
            if (video) launch {
                try {
                    r.localParticipant.setCameraEnabled(true)
                    stage("camera on")
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    _state.update { it.copy(error = CallFailure.CAMERA) }
                }
            }
        }
        watchAudioRoute(r)
        runCatching { api.post<CallRes>("/v1/calls/$callId/connected") }
        _state.update {
            it.copy(
                phase = if (r.remoteParticipants.isEmpty() && !it.isGroup) CallPhase.Outgoing else CallPhase.Connected,
                connectedAt = if (r.remoteParticipants.isNotEmpty() || it.isGroup) System.currentTimeMillis() else null,
            )
        }
        // Joining people already in the room (an answered incoming call, a running group call) is answering it too: the
        // log used to record that only when someone joined after us, so every answered incoming call showed as missed.
        if (r.remoteParticipants.isNotEmpty()) scope.launch {
            db.calls().getLog(callId)?.takeIf { it.answeredAt == null }?.let { db.calls().upsertLog(it.copy(answeredAt = System.currentTimeMillis())) }
        }
        refreshParticipants()
    }

    /**
     * Samples WebRTC inbound byte counters every 2 s (all builds): the UI says media is flowing only when
     * bytes actually arrive, and the redacted network path (udp/tcp/relay) is recorded for diagnosis.
     */
    private fun startMediaMonitor(r: Room) {
        volumeHintShown = false
        mediaJob?.cancel()
        val monitor = MediaFlowMonitor()
        // Sound on its own (UI-003): video can flow while a person's audio doesn't, which reads as "too quiet".
        val audioMonitor = MediaFlowMonitor()
        mediaJob = scope.launch {
            while (isActive && room === r) {
                delay(2000)
                var total: Long? = null
                var audio: Long? = null
                var path: String? = null
                for (rp in r.remoteParticipants.values) {
                    for ((pub, t) in rp.audioTrackPublications + rp.videoTrackPublications) {
                        val report = runCatching { t?.getRTCStats() }.getOrNull() ?: continue
                        val stats = report.statsMap.values
                        val bytes = stats.filter { it.type == "inbound-rtp" }.sumOf { (it.members["bytesReceived"] as? Number)?.toLong() ?: 0L }
                        total = (total ?: 0L) + bytes
                        if (pub.kind == Track.Kind.AUDIO && !pub.muted) audio = (audio ?: 0L) + bytes
                        if (path == null) path = MediaPath.describe(stats)
                    }
                }
                if (room !== r) break
                val before = _state.value
                val flow = monitor.sample(total)
                val audioFlow = audioMonitor.sample(audio)
                if (flow != before.media || (path != null && path != before.path)) diag.log("media $flow via ${path ?: before.path ?: "unknown path"}")
                if (audioFlow != before.remoteAudio) diag.log("remote audio $audioFlow")
                _state.update {
                    if (it.media == flow && it.remoteAudio == audioFlow && (path == null || it.path == path)) it
                    else it.copy(media = flow, remoteAudio = audioFlow, path = path ?: it.path)
                }
                val stats = runCatching { sampleStats(r) }.getOrNull()
                if (room !== r) break
                if (stats != null) {
                    if (++ticks % 3 == 0) {
                        diag.log("stats send cam=${stats.sendingCamera?.describe()} screen=${stats.sendingScreen?.describe()} | recv video=${stats.receivingVideo?.describe()} screen=${stats.receivingScreen?.describe()} | route=${stats.audioRoute}")
                        diag.log("audio recv=${stats.receivingAudio?.describe()} mic=${stats.sendingAudioDb} dBFS volume=${stats.callVolume}")
                    }
                    _state.update { it.copy(stats = stats.copy(echoCanceller = it.stats?.echoCanceller)) }
                    // Round 7 (bug 5): a low call volume is the commonest "too quiet". Said once per call, on the call
                    // screen; Meldiq never changes the person's volume itself.
                    if (stats.volumeLow && !volumeHintShown) {
                        volumeHintShown = true
                        _state.update { it.copy(notice = "Call volume is low on this phone. Press the volume-up button to hear more.") }
                    }
                }
            }
        }
    }

    /**
     * The first remote audio bytes (round 7, bug 7): "connected" means sound arrives, not that signalling finished.
     * Polls that track's statistics every 100 ms for up to 5 s, then logs the whole timeline once.
     */
    private fun watchFirstAudio(r: Room, track: Track) = scope.launch {
        val t0 = System.currentTimeMillis()
        while (room === r && System.currentTimeMillis() - t0 < FIRST_AUDIO_WATCH_MS) {
            val bytes = runCatching { track.getRTCStats() }.getOrNull()?.statsMap?.values
                ?.filter { it.type == "inbound-rtp" }?.sumOf { (it.members["bytesReceived"] as? Number)?.toLong() ?: 0L } ?: 0L
            if (bytes > 0) {
                stage("first remote audio")
                break
            }
            delay(100)
        }
        if (room === r) diag.log(timeline.summary())
    }

    /** Sends the call's key message without holding up this phone's own connection; a failure ends the call clearly. */
    private fun sendKeyInBackground(conversationId: String, callId: String, video: Boolean, key: String) = scope.launch {
        runCatching { messages.sendCallKey(conversationId, callId, video, key) }
            .onSuccess { stage("key sent") }
            .onFailure { e ->
                Log.w(TAG, "call key send failed: ${e.javaClass.simpleName}")
                if (_state.value.callId == callId) fail("Couldn't send the call's encryption key, so the other person can't join. Try calling again.")
            }
    }

    private var ticks = 0
    private var micStatsLogged = false
    private var volumeHintShown = false

    /** Sender and receiver video numbers for the largest camera and screen streams, plus the current audio route. */
    private suspend fun sampleStats(r: Room): CallMediaStats {
        val now = System.currentTimeMillis()
        val keys = HashSet<String>()
        suspend fun video(t: Track?, key: String, outbound: Boolean): VideoStats? {
            val report = t?.let { runCatching { it.getRTCStats() }.getOrNull() } ?: return null
            keys += key
            return sampler.sample(key, report.statsMap.values.map { it.type to it.members }, outbound, now)
        }
        var sendCam: VideoStats? = null
        var sendScreen: VideoStats? = null
        for ((pub, t) in r.localParticipant.videoTrackPublications) {
            if (pub.muted) continue
            when (pub.source) {
                Track.Source.CAMERA -> sendCam = video(t, "out:" + pub.sid, true)
                Track.Source.SCREEN_SHARE -> sendScreen = video(t, "out:" + pub.sid, true)
                else -> {}
            }
        }
        var recvVideo: VideoStats? = null
        var recvScreen: VideoStats? = null
        for (rp in r.remoteParticipants.values) for ((pub, t) in rp.videoTrackPublications) {
            if (pub.muted || t == null) continue
            val v = video(t, "in:" + pub.sid, false) ?: continue
            if (pub.source == Track.Source.SCREEN_SHARE) { if (recvScreen == null) recvScreen = v } else if (recvVideo == null) recvVideo = v
        }
        sampler.forget(keys)
        // Sound: the loudest remote stream (a group's current speaker), the microphone's level as sent, and the call volume.
        val audioKeys = HashSet<String>()
        var recvAudio: AudioStats? = null
        for (rp in r.remoteParticipants.values) for ((pub, t) in rp.audioTrackPublications) {
            if (pub.muted || t == null) continue
            val report = runCatching { t.getRTCStats() }.getOrNull() ?: continue
            val key = "in:" + pub.sid
            audioKeys += key
            val a = audioSampler.inbound(key, report.statsMap.values.map { it.type to it.members }) ?: continue
            if (recvAudio == null || (a.levelDb ?: -100) > (recvAudio.levelDb ?: -100)) recvAudio = a
        }
        audioSampler.forget(audioKeys)
        val micReport = r.localParticipant.audioTrackPublications.firstOrNull { !it.first.muted }?.second
            ?.let { t -> runCatching { t.getRTCStats() }.getOrNull() }
        if (micReport != null && !micStatsLogged) {
            micStatsLogged = true
            micReport.statsMap.values.filter { it.type == "media-source" }.forEach { diag.log("mic stats fields: ${it.members.keys.sorted()}") }
        }
        val micDb = micReport?.let { rep -> audioSampler.outboundLevel(rep.statsMap.values.map { it.type to it.members }) }
        val volume = runCatching { audioManager.getStreamVolume(AudioManager.STREAM_VOICE_CALL) to audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL) }.getOrNull()
        val route = actualRoute(r)?.label
        return CallMediaStats(
            sendCam, sendScreen, recvVideo, recvScreen, route,
            receivingAudio = recvAudio, sendingAudioDb = micDb,
            callVolume = volume?.let { (v, m) -> CallAudioPolicy.describeVolume(v, m) },
            volumeLow = volume?.let { (v, m) -> CallAudioPolicy.volumeLow(v, m) } ?: false,
        )
    }

    /**
     * Follows LiveKit's audio devices (UI-003): the call screen shows the route the phone actually uses, a headset that
     * appears takes over, and the person's earlier choice is applied again in a new room (after a rejoin). Logs device
     * types only, never names.
     */
    private fun watchAudioRoute(r: Room) {
        val handler = r.audioSwitchHandler ?: return
        audioListener?.let { runCatching { handler.unregisterAudioDeviceChangeListener(it) } }
        val listener: (List<AudioDevice>, AudioDevice?) -> Unit = { devices, selected -> if (room === r) onAudioDevices(r, devices, selected) }
        audioListener = listener
        handler.registerAudioDeviceChangeListener(listener)
        onAudioDevices(r, handler.availableAudioDevices, handler.selectedAudioDevice)
    }

    private fun onAudioDevices(r: Room, devices: List<AudioDevice>, selected: AudioDevice?) {
        val routes = devices.map(::routeOf)
        val current = selected?.let(::routeOf)
        val before = _state.value.audioRoutes
        diag.log("audio route ${current?.kind} of ${routes.joinToString { it.kind.name }}")
        val handler = r.audioSwitchHandler
        val chosen = userRoute
        when {
            routes.isEmpty() -> {}
            // A headset plugged in or connected mid-call wins over a speaker/earpiece choice (the person's, or the
            // automatic move to the speaker when the camera came on), as on a phone call.
            before.isNotEmpty() && CallAudioPolicy.headsetArrived(before, routes) -> {
                userRoute = null
                if (current?.kind != AudioRouteKind.Bluetooth && current?.kind != AudioRouteKind.Wired) handler?.selectDevice(null)
            }
            // First device list of a room (a rejoin): the person's choice again, if that output is still there.
            routedRoom !== r -> {
                routedRoom = r
                if (chosen != null && !CallAudioPolicy.matches(chosen, current)) {
                    devices.firstOrNull { CallAudioPolicy.matches(chosen, routeOf(it)) }?.let { handler?.selectDevice(it) }
                }
            }
        }
        _state.update { it.copy(audioRoutes = routes, audioRoute = current, speakerOn = current?.kind == AudioRouteKind.Speaker) }
    }

    private fun routeOf(d: AudioDevice): AudioRoute = when (d) {
        is AudioDevice.Speakerphone -> AudioRoute(AudioRouteKind.Speaker)
        is AudioDevice.Earpiece -> AudioRoute(AudioRouteKind.Earpiece)
        is AudioDevice.WiredHeadset -> AudioRoute(AudioRouteKind.Wired)
        is AudioDevice.BluetoothHeadset -> AudioRoute(AudioRouteKind.Bluetooth, d.name)
        else -> AudioRoute(AudioRouteKind.Other, d.name)
    }

    private fun deviceClass(k: AudioRouteKind): Class<out AudioDevice>? = when (k) {
        AudioRouteKind.Speaker -> AudioDevice.Speakerphone::class.java
        AudioRouteKind.Earpiece -> AudioDevice.Earpiece::class.java
        AudioRouteKind.Bluetooth -> AudioDevice.BluetoothHeadset::class.java
        AudioRouteKind.Wired -> AudioDevice.WiredHeadset::class.java
        AudioRouteKind.Other -> null
    }

    /**
     * Where the phone really sends call audio. On Android 12+ that's the communication device the system reports, which
     * catches a route LiveKit asked for but the system refused; on older versions, what LiveKit selected.
     */
    private fun actualRoute(r: Room): AudioRoute? {
        if (Build.VERSION.SDK_INT >= 31) {
            val info = runCatching { audioManager.communicationDevice }.getOrNull()
            if (info != null) return routeOfInfo(info)
        }
        return r.audioSwitchHandler?.selectedAudioDevice?.let(::routeOf)
    }

    @androidx.annotation.RequiresApi(31)
    private fun routeOfInfo(info: AudioDeviceInfo): AudioRoute = when (info.type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> AudioRoute(AudioRouteKind.Speaker)
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRoute(AudioRouteKind.Earpiece)
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> AudioRoute(AudioRouteKind.Wired)
        // Matched by kind only: the system's product name and the Bluetooth name can be written differently.
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID -> AudioRoute(AudioRouteKind.Bluetooth)
        else -> AudioRoute(AudioRouteKind.Other)
    }

    /** Room options per [CallMediaPolicy]: explicit camera settings, and screen share tuned for readable text. */
    private fun displaySize(): Pair<Int, Int> {
        val wm = context.getSystemService(android.view.WindowManager::class.java)
        return if (android.os.Build.VERSION.SDK_INT >= 30) wm.maximumWindowMetrics.bounds.let { it.width() to it.height() }
        else android.util.DisplayMetrics().also { @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(it) }.let { it.widthPixels to it.heightPixels }
    }

    private fun roomOptions(e2ee: E2EEOptions?): RoomOptions {
        val (w, h) = displaySize()
        val (long, short) = CallMediaPolicy.screenCaptureSize(w, h)
        return RoomOptions(
            adaptiveStream = true,
            dynacast = true,
            e2eeOptions = e2ee,
            // Microphone processing and Opus settings, explicit (round 7, [CallMediaPolicy]).
            audioTrackCaptureDefaults = LocalAudioTrackOptions(
                // Batch B10: "Noise reduction" off keeps music and quiet sounds (noise suppression and level control off).
                noiseSuppression = settings.current.noiseReduction, echoCancellation = true, autoGainControl = settings.current.noiseReduction, highPassFilter = true,
                typingNoiseDetection = CallMediaPolicy.TYPING_NOISE_DETECTION,
            ),
            audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = CallMediaPolicy.AUDIO_MAX_BITRATE, dtx = true, red = true),
            videoTrackCaptureDefaults = LocalVideoTrackOptions(captureParams = VideoCaptureParameter(CallMediaPolicy.CAMERA_WIDTH, CallMediaPolicy.CAMERA_HEIGHT, CallMediaPolicy.CAMERA_FPS)),
            videoTrackPublishDefaults = VideoTrackPublishDefaults(videoEncoding = VideoPreset169.H720.encoding, simulcast = true),
            // The SDK orients the capture to the screen: (long, short) on a landscape display, (short, long) on a portrait one.
            screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(long, short, CallMediaPolicy.SCREEN_FPS)),
            screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
                videoEncoding = VideoEncoding(CallMediaPolicy.SCREEN_MAX_BITRATE, CallMediaPolicy.SCREEN_FPS),
                simulcast = false,
                degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION,
            ),
        )
    }

    private fun onRoomEvent(ev: RoomEvent) {
        diag.event(ev)
        when (ev) {
            is RoomEvent.ParticipantConnected -> {
                stage("peer joined")
                peerBack()
                _state.update { if (it.phase == CallPhase.Outgoing) it.copy(phase = CallPhase.Connected, connectedAt = System.currentTimeMillis()) else it }
                scope.launch { db.calls().getLog(_state.value.callId ?: "")?.let { db.calls().upsertLog(it.copy(answeredAt = System.currentTimeMillis())) } }
            }
            is RoomEvent.ParticipantDisconnected -> {
                securityTracker?.let { t -> ev.participant.identity?.value?.let(t::participantLeft); publishSecurity(t) }
                val s = _state.value
                // 1:1: the other person may only have lost their connection (a hang-up arrives as a call "ended" event).
                // Wait for them to come back instead of ending the call at once.
                if (!s.isGroup && room?.remoteParticipants?.isEmpty() == true && peerWait == null) {
                    _state.update { it.copy(peerReconnecting = true) }
                    peerWait = scope.launch {
                        delay(CallRecovery.PEER_WINDOW_MS)
                        peerWait = null
                        if (room?.remoteParticipants?.isEmpty() == true) finish("lost", notifyServer = true)
                    }
                }
            }
            is RoomEvent.Reconnecting -> {
                reconnectingSince = System.currentTimeMillis()
                _state.update { it.copy(phase = CallPhase.Reconnecting) }
            }
            is RoomEvent.Reconnected -> {
                // Batch B10: how long the media library's own reconnect took (the full rejoin logs its own time).
                reconnectingSince?.let { diag.log("reconnected in ${System.currentTimeMillis() - it} ms") }
                reconnectingSince = null
                _state.update { it.copy(phase = CallPhase.Connected) }
                // A full reconnect re-syncs the other person without a "joined" event (found in B10's emulator test):
                // clear "connection dropped" when they're there.
                if (room?.remoteParticipants?.isNotEmpty() == true) peerBack()
            }
            is RoomEvent.Disconnected -> if (_state.value.phase != CallPhase.Idle && _state.value.phase != CallPhase.Ended) {
                val reason = ev.reason?.name
                Log.i(TAG, "room disconnected: $reason")
                // A lost connection (not a hang-up or removal): rejoin the same call with the same key for a while.
                if (CallRecovery.retryable(reason) && rejoinJob?.isActive != true) rejoin() else if (rejoinJob?.isActive != true) finish("disconnected", notifyServer = true)
            }
            // The SDK has set up the track's frame cryptor by now: register the track for the badge, then
            // swap in the crash-safe observer.
            is RoomEvent.TrackSubscribed -> {
                if (ev.publication.kind == Track.Kind.AUDIO) {
                    stage("remote audio subscribed")
                    watchFirstAudio(ev.room, ev.track)
                    // Batch B10: someone joining while you're deafened stays silent.
                    if (_state.value.deafened) (ev.track as? io.livekit.android.room.track.RemoteAudioTrack)?.setVolume(0.0)
                }
                if (ev.publication.kind == Track.Kind.VIDEO) stage("remote video subscribed")
                // Their media arriving means they're back, also when the re-sync came without a "joined" event.
                if (_state.value.peerReconnecting) peerBack()
                trackChanged { it.trackAdded(trackKey(ev.participant, ev.publication), remote = true, muted = ev.publication.muted) }
                cryptorGuard?.guard(ev.room, ev.publication, ev.participant)
            }
            is RoomEvent.TrackPublished -> {
                // Remote publications get a cryptor only once subscribed (TrackSubscribed); local ones now.
                if (ev.participant === ev.room.localParticipant) {
                    trackChanged { it.trackAdded(trackKey(ev.participant, ev.publication), remote = false, muted = ev.publication.muted) }
                }
                cryptorGuard?.guard(ev.room, ev.publication, ev.participant)
            }
            is RoomEvent.TrackUnsubscribed -> trackChanged { it.trackRemoved(trackKey(ev.participant, ev.publications)) }
            is RoomEvent.TrackUnpublished -> {
                trackChanged { it.trackRemoved(trackKey(ev.participant, ev.publication)) }
                // Batch B11: a viewer is told the share ended instead of the screen just disappearing.
                if (ev.participant !== ev.room.localParticipant && ev.publication.source == Track.Source.SCREEN_SHARE) {
                    val who = _state.value.participants.firstOrNull { it.identity == ev.participant.identity?.value }?.name ?: _state.value.title
                    _state.update { it.copy(notice = context.getString(R.string.b11_share_ended, who)) }
                }
            }
            is RoomEvent.TrackMuted -> trackChanged { it.trackMuted(trackKey(ev.participant, ev.publication), true) }
            is RoomEvent.TrackUnmuted -> trackChanged { it.trackMuted(trackKey(ev.participant, ev.publication), false) }
            // Only until the guard has replaced a cryptor's observer; afterwards states arrive through the guard.
            is RoomEvent.TrackE2EEStateEvent -> securityTracker?.let { onE2eeState(it, trackKey(ev.participant, ev.publication), ev.state) }
            is RoomEvent.ConnectionQualityChanged -> {
                val r = room
                val qualities = listOfNotNull(r?.localParticipant?.connectionQuality) + r?.remoteParticipants?.values?.map { it.connectionQuality }.orEmpty()
                val weak = qualities.any { it == ConnectionQuality.POOR || it == ConnectionQuality.LOST }
                if (weak != _state.value.connectionWeak) diag.log("connection quality ${ev.quality} (weak=$weak)")
                _state.update { it.copy(connectionWeak = weak) }
            }
            else -> {}
        }
        refreshParticipants()
    }

    private fun trackKey(p: Participant, pub: TrackPublication) = FrameCryptorGuard.key(p.identity?.value, pub.sid)

    private inline fun trackChanged(change: (MediaSecurityTracker) -> Unit) {
        val t = securityTracker ?: return
        change(t)
        publishSecurity(t)
    }

    private fun onE2eeState(tracker: MediaSecurityTracker, key: String, st: E2EEState) {
        if (!tracker.state(key, st)) return
        publishSecurity(tracker)
        // Tiles show who has an encryption problem: refresh them from the call's own scope (this may be WebRTC's thread).
        scope.launch { if (securityTracker === tracker) refreshParticipants() }
    }

    /**
     * Shows what [tracker] can prove, unless its call has ended or been replaced meanwhile. Computed inside the lock, so
     * two threads can't publish out of order and leave a stale badge (lock order: [securityLock], then the tracker).
     */
    private fun publishSecurity(tracker: MediaSecurityTracker) {
        synchronized(securityLock) {
            if (securityTracker !== tracker) return
            val sec = tracker.security()
            if (_state.value.security != sec) diag.log("media security: $sec")
            _state.update { if (it.security == sec) it else it.copy(security = sec) }
        }
    }

    private fun refreshParticipants() {
        val r = room ?: return
        val problems = securityTracker?.problemIdentities().orEmpty()
        fun ui(p: Participant, local: Boolean): ParticipantUi {
            val meta = p.metadata
            val uid = meta?.let { Regex("\"userId\":\"([^\"]+)\"").find(it)?.groupValues?.get(1) } ?: p.identity?.value?.substringBefore('.') ?: ""
            val camPub = p.videoTrackPublications.firstOrNull { it.first.source == Track.Source.CAMERA && !it.first.muted }
            val cam = camPub?.second as? VideoTrack
            val scr = p.videoTrackPublications.firstOrNull { it.first.source == Track.Source.SCREEN_SHARE && !it.first.muted }?.second as? VideoTrack
            val id = p.identity?.value ?: ""
            synchronized(firstSeen) { if (id.isNotEmpty() && id !in firstSeen) firstSeen[id] = seenCounter++ }
            return ParticipantUi(
                id, uid, p.name?.takeIf { it.isNotBlank() } ?: (if (local) "You" else "Participant"), local, p.isSpeaking, p.isMicrophoneEnabled, cam, scr,
                cameraOn = camPub != null,
                connectionWeak = p.connectionQuality == ConnectionQuality.POOR || p.connectionQuality == ConnectionQuality.LOST,
                e2eeProblem = id in problems,
                mirrored = CallMediaPolicy.mirrorPreview(local, (cam as? LocalVideoTrack)?.options?.position == io.livekit.android.room.track.CameraPosition.BACK),
            )
        }
        // One tile per identity in a stable order (others by arrival, then you), never yourself twice.
        val list = com.meldiq.android.ui.screens.calls.CallTiles.order(
            listOf(ui(r.localParticipant, true)) + r.remoteParticipants.values.map { ui(it, false) },
            identity = { it.identity }, isLocal = { it.isLocal }, firstSeen = { synchronized(firstSeen) { firstSeen[it] ?: Long.MAX_VALUE } },
        )
        val sharers = list.filter { !it.isLocal && it.screen != null }.map { it.identity }
        _state.update {
            it.copy(
                participants = list,
                watchingShare = com.meldiq.android.ui.screens.calls.CallTiles.watchedShare(sharers, it.watchingShare),
                micOn = r.localParticipant.isMicrophoneEnabled,
                cameraOn = r.localParticipant.isCameraEnabled,
                screenSharing = r.localParticipant.isScreenShareEnabled,
            )
        }
    }

    fun toggleMic() = scope.launch {
        val r = room ?: return@launch
        if (_state.value.listenOnly) { _state.update { it.copy(notice = CallFailure.LISTEN_ONLY) }; return@launch }
        runCatching { r.localParticipant.setMicrophoneEnabled(!r.localParticipant.isMicrophoneEnabled) }
        refreshParticipants()
    }

    /** Batch B10 (Discord's deafen): silences everyone for you and mutes you; undeafening restores your microphone. */
    fun toggleDeafen() = scope.launch {
        val r = room ?: return@launch
        val deafen = !_state.value.deafened
        if (deafen) {
            micBeforeDeafen = r.localParticipant.isMicrophoneEnabled
            if (micBeforeDeafen) runCatching { r.localParticipant.setMicrophoneEnabled(false) }
        } else if (micBeforeDeafen && !_state.value.listenOnly) {
            runCatching { r.localParticipant.setMicrophoneEnabled(true) }
        }
        _state.update { it.copy(deafened = deafen) }
        applyDeafen(r)
        diag.log("deafen ${if (deafen) "on" else "off"}")
        refreshParticipants()
    }

    /** Every remote voice at volume 0 while deafened (and new ones as they arrive), back to 1 otherwise. */
    private fun applyDeafen(r: Room) {
        val volume = if (_state.value.deafened) 0.0 else 1.0
        r.remoteParticipants.values.forEach { p ->
            p.audioTrackPublications.forEach { (_, track) -> (track as? io.livekit.android.room.track.RemoteAudioTrack)?.setVolume(volume) }
        }
    }

    fun toggleCamera() = scope.launch {
        val r = room ?: return@launch
        if (_state.value.listenOnly) { _state.update { it.copy(notice = CallFailure.LISTEN_ONLY) }; return@launch }
        val turningOn = !r.localParticipant.isCameraEnabled
        runCatching { r.localParticipant.setCameraEnabled(turningOn) }
            .onSuccess {
                // Video is watched at arm's length: a call on the earpiece moves to the speaker (not if the person chose it).
                val s = _state.value
                if (turningOn && CallAudioPolicy.speakerForVideo(s.audioRoute, userRoute?.kind)) {
                    s.audioRoutes.firstOrNull { it.kind == AudioRouteKind.Speaker }?.let { r.audioSwitchHandler?.selectDevice(deviceFor(r, it)) }
                }
            }
            .onFailure { _state.update { s -> s.copy(error = CallFailure.CAMERA) } }
        refreshParticipants()
    }

    /**
     * Switches between the front and back camera (round 7, bug 3). One switch at a time: LiveKit updates the track's
     * camera position only once the new camera's first frame arrives, so a second tap before that used to aim at the
     * wrong camera and stack switches. The preview's mirroring follows the position LiveKit reports, so it changes
     * with the first frame of the new camera, never on a stale frame.
     */
    fun flipCamera() {
        if (cameraSwitching) return
        val r = room ?: return
        val track = r.localParticipant.videoTrackPublications.firstOrNull { it.first.source == Track.Source.CAMERA }?.second as? LocalVideoTrack ?: return
        val back = io.livekit.android.room.track.CameraPosition.BACK
        val front = io.livekit.android.room.track.CameraPosition.FRONT
        val target = if (track.options.position == back) front else back
        cameraSwitching = true
        scope.launch {
            try {
                val t0 = System.currentTimeMillis()
                runCatching { track.switchCamera(position = target) }.onFailure { _state.update { s -> s.copy(error = CallFailure.CAMERA) } }
                while (room === r && track.options.position != target && System.currentTimeMillis() - t0 < CAMERA_SWITCH_TIMEOUT_MS) delay(50)
                // Batch B10 trace (docs/product/MELDIQ_CALLING_SCREENSHARE_AUDIT.md §3, stages 1 and 3): which camera opened,
                // which published track carries it, at what size. `adb logcat -s CallDiag` on both phones.
                val pub = r.localParticipant.videoTrackPublications.firstOrNull { it.first.source == Track.Source.CAMERA }?.first
                diag.log(
                    "camera switch: facing ${track.options.position?.name?.lowercase()} id ${track.options.deviceId ?: "?"} track ${pub?.sid ?: "?"} " +
                        "size ${track.dimensions.width}x${track.dimensions.height} " +
                        "${if (track.options.position == target) "done" else "not confirmed"} in ${System.currentTimeMillis() - t0} ms",
                )
            } finally {
                cameraSwitching = false
                refreshParticipants()
            }
        }
    }

    /**
     * Sends the call's sound to [route] (UI-003). The choice sticks for this call (and after a rejoin), and is checked
     * against what the phone reports a moment later: a route the system didn't apply shows a recoverable error instead
     * of a button that claims a route the phone isn't using.
     */
    fun selectAudioRoute(route: AudioRoute) {
        val r = room ?: return
        val device = deviceFor(r, route)
        if (device == null) {
            _state.update { it.copy(routeError = CallAudioPolicy.routeFailed(route)) }
            return
        }
        userRoute = route
        _state.update { it.copy(routeError = null) }
        r.audioSwitchHandler?.selectDevice(device)
        routeCheck?.cancel()
        routeCheck = scope.launch {
            delay(ROUTE_CHECK_MS)
            if (room !== r || userRoute != route) return@launch
            val actual = actualRoute(r)
            if (!CallAudioPolicy.matches(route, actual)) {
                diag.log("audio route check failed: asked ${route.kind}, phone uses ${actual?.kind}")
                _state.update { it.copy(routeError = CallAudioPolicy.routeFailed(route)) }
            }
        }
    }

    /** The speaker button with only the speaker and the earpiece available: one tap switches between them. */
    fun toggleSpeaker() {
        val s = _state.value
        CallAudioPolicy.toggleTarget(s.audioRoute, s.audioRoutes)?.let(::selectAudioRoute)
    }

    fun clearRouteError() = _state.update { it.copy(routeError = null) }

    private fun deviceFor(r: Room, route: AudioRoute): AudioDevice? =
        r.audioSwitchHandler?.availableAudioDevices?.firstOrNull { CallAudioPolicy.matches(route, routeOf(it)) }

    /** Shrinks the call to the in-app call panel; the call and its media carry on (nothing is released). */
    fun minimize() {
        val p = _state.value.phase
        if (p != CallPhase.Idle && p != CallPhase.Incoming) _minimized.value = true
    }

    /** Back to the full call screen (the panel, picture-in-picture or the notification). */
    fun expand() {
        _minimized.value = false
    }

    fun clearNotice() = _state.update { it.copy(notice = null) }

    /**
     * Called with the MediaProjection consent result. Never invoked without the system dialog. The capture runs in
     * LiveKit's mediaProjection service with Meldiq's own notification (who sees what, and a Stop action). When Android
     * or the person ends the capture from outside the call screen, LiveKit unpublishes the track; it's never restarted
     * on its own, and the call screen says it stopped.
     */
    fun startScreenShare(resultData: Intent, mode: ShareMode = ShareMode.TEXT, appSound: Boolean = false) = scope.launch {
        val r = room ?: return@launch
        if (_state.value.listenOnly) { _state.update { it.copy(notice = CallFailure.LISTEN_ONLY) }; return@launch }
        if (_state.value.phase != CallPhase.Connected) {
            _state.update { it.copy(error = "Screen sharing can start once the call is connected.") }
            return@launch
        }
        val othersSharing = _state.value.participants.count { !it.isLocal && it.screen != null }
        if (!com.meldiq.android.ui.screens.calls.CallTiles.canStartShare(othersSharing)) {
            _state.update { it.copy(error = context.getString(R.string.vid_share_full, com.meldiq.android.ui.screens.calls.CallTiles.MAX_SHARES)) }
            return@launch
        }
        stoppingShare = false
        applyShareMode(r, mode)
        try {
            val params = ScreenCaptureParams(
                resultData,
                notificationId = CallService.SHARE_NOTIFICATION_ID,
                notification = CallService.shareNotification(context, _state.value.title),
                onStop = { scope.launch { onCaptureStopped(r) } },
            )
            if (!r.localParticipant.setScreenShareEnabled(true, params)) {
                _state.update { it.copy(error = "Screen sharing failed to start") }
            } else {
                val share = r.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track as? LocalVideoTrack
                (share?.capturer as? livekit.org.webrtc.ScreenCapturerAndroid)?.let { shareRotation.start(it, mode) }
                val withSound = appSound && share != null && startAppSound(r, share)
                _state.update { it.copy(shareMode = mode, shareAppSound = withSound) }
                diag.log("screen share: ${mode.name.lowercase()} ${mode.maxLong}x${mode.maxShort} ${mode.fps} fps ${mode.maxBitrate / 1000} kbps, app sound ${if (withSound) "on" else "off"}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "screen share start failed: ${e.javaClass.simpleName}")
            _state.update { it.copy(error = "Screen sharing failed to start") }
        }
        refreshParticipants()
    }

    private fun onCaptureStopped(r: Room) {
        shareRotation.stop()
        stopAppSound(r)
        if (room !== r) return
        val ours = stoppingShare
        stoppingShare = false
        Log.i(TAG, "screen capture stopped (${if (ours) "Stop in Meldiq" else "by Android or the status bar"})")
        if (!ours) _state.update { it.copy(notice = "Screen sharing stopped") }
        refreshParticipants()
    }

    /** Shows [identity]'s shared screen (one of several); nothing changes for anyone else. */
    fun watchShare(identity: String) {
        _state.update { s -> if (s.participants.any { it.identity == identity && !it.isLocal && it.screen != null }) s.copy(watchingShare = identity) else s }
    }

    /** Stops sharing only; the call goes on (leaving is the End button). */
    fun stopScreenShare() = scope.launch {
        val r = room ?: return@launch
        if (!r.localParticipant.isScreenShareEnabled) return@launch
        stoppingShare = true
        shareRotation.stop()
        stopAppSound(r)
        runCatching { r.localParticipant.setScreenShareEnabled(false, null) }
        refreshParticipants()
    }

    fun clearError() = _state.update { it.copy(error = null) }

    fun hangup() {
        Log.i(TAG, "user tapped end")
        finish("hangup", notifyServer = true)
    }

    private fun finish(remoteReason: String, notifyServer: Boolean) {
        // Claimed under a lock: a hang-up, the server's "ended" frame and a room disconnect can arrive on different
        // threads at the same moment, and each used to run the teardown (disconnect and release twice on one Room).
        val s = synchronized(finishLock) {
            val cur = _state.value
            if (cur.phase == CallPhase.Idle || cur.phase == CallPhase.Ended) return
            _state.value = cur.copy(phase = CallPhase.Ended, endReason = remoteReason, participants = emptyList())
            cur
        }
        markHandled(s.callId)
        Log.i(TAG, "call ending: reason=$remoteReason notifyServer=$notifyServer phase=${s.phase} participants=${s.participants.size}")
        val id = s.callId
        if (notifyServer && id != null) {
            scope.launch {
                runCatching { if (!s.isGroup || s.participants.size <= 1) api.post<CallRes>("/v1/calls/$id/end") else api.post<CallRes>("/v1/calls/$id/leave") }
                    .onFailure { runCatching { api.post<CallRes>("/v1/calls/$id/leave") } }
            }
        }
        scope.launch {
            id?.let { cid ->
                db.calls().getLog(cid)?.let { db.calls().upsertLog(it.copy(endedAt = System.currentTimeMillis(), endReason = remoteReason)) }
                db.calls().dropKey(cid, System.currentTimeMillis() - 24 * 3600_000L)
            }
        }
        teardown()
        scope.launch {
            delay(1500)
            if (_state.value.phase == CallPhase.Ended) reset()
        }
    }

    private fun fail(msg: String) {
        synchronized(finishLock) {
            val p = _state.value.phase
            if (p == CallPhase.Idle || p == CallPhase.Ended) return
            _state.update { it.copy(phase = CallPhase.Ended, error = msg, endReason = "error") }
        }
        teardown()
        scope.launch {
            delay(3500)
            if (_state.value.phase == CallPhase.Ended) reset()
        }
    }

    /**
     * Ordered shutdown. Freeing WebRTC's native objects while its audio/render threads or the call
     * UI's video sinks still reference them crashed the process (SIGSEGV in libjingle_peerconnection_so,
     * seen on a physical phone). So: drop the room reference (the UI detaches its sinks), disconnect,
     * and only release native resources after those threads have wound down.
     * Disconnecting clears the remote tracks but leaves their frame cryptors running, so every cryptor
     * gets the crash-safe observer first, including ones whose TrackSubscribed event was still queued.
     */
    private var peerWait: kotlinx.coroutines.Job? = null
    private var rejoinJob: kotlinx.coroutines.Job? = null
    private var reconnectingSince: Long? = null

    /** Batch B11: app sound mixed into the microphone track while sharing (null when not). */
    private var shareSound: ScreenAudioCapturer? = null

    /** Sets the room's screen-share capture and encoding for [mode] just before a share is published. */
    private fun applyShareMode(r: Room, mode: ShareMode) {
        val (w, h) = displaySize()
        val (long, short) = CallMediaPolicy.screenCaptureSize(w, h, mode)
        r.screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(long, short, mode.fps))
        r.screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
            videoEncoding = VideoEncoding(mode.maxBitrate, mode.fps),
            simulcast = false,
            degradationPreference = if (mode.keepFrameRate) RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE else RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION,
        )
    }

    /**
     * Mixes the shared apps' sound into the microphone track (Android 10+). Apps that forbid capture stay silent; the
     * sound goes only while the microphone is on. Returns whether it started.
     */
    @android.annotation.SuppressLint("MissingPermission") // calls only start with the microphone allowed
    private fun startAppSound(r: Room, share: LocalVideoTrack): Boolean {
        // Written out (not CallMediaPolicy.canShareAppSound) so lint sees the Android 10 check.
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) return false
        val mic = r.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack ?: return false
        val capturer = runCatching { ScreenAudioCapturer.createFromScreenShareTrack(share) }
            .onFailure { Log.w(TAG, "app sound capture failed: ${it.javaClass.simpleName}") }
            .getOrNull() ?: return false
        mic.setAudioBufferCallback(capturer)
        shareSound = capturer
        return true
    }

    /** Stops mixing app sound; [r] is null when the room is already gone. */
    private fun stopAppSound(r: Room?) {
        val capturer = shareSound ?: return
        shareSound = null
        (r?.localParticipant?.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack)?.let { runCatching { it.setAudioBufferCallback(null) } }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) runCatching { capturer.releaseAudioResources() }
        _state.update { it.copy(shareAppSound = false) }
    }

    /** The other person is in the room again: stop waiting for them and drop the "connection dropped" notice. */
    private fun peerBack() {
        peerWait?.cancel()
        peerWait = null
        _state.update { it.copy(peerReconnecting = false) }
    }

    /**
     * After this phone's media connection dropped (the SDK's own reconnect gave up): new media credentials from the
     * server and a new room with the same call key, retried with backoff for [CallRecovery.REJOIN_WINDOW_MS]. The call
     * screen says "Reconnecting…" meanwhile; the call ends only if the window runs out or the call has ended.
     */
    private fun rejoin() {
        val s = _state.value
        val callId = s.callId ?: return finish("disconnected", notifyServer = true)
        // A screen share ends with the old room (Android's consent is single-use): say so instead of dropping it silently.
        _state.update { it.copy(phase = CallPhase.Reconnecting, notice = if (it.screenSharing) "Screen sharing stopped while reconnecting. Tap Share to start again." else it.notice) }
        rejoinJob = scope.launch {
            val started = System.currentTimeMillis()
            var attempt = 0
            teardownRoomOnly()
            while (System.currentTimeMillis() - started < CallRecovery.REJOIN_WINDOW_MS) {
                delay(CallRecovery.backoff(attempt++))
                if (_state.value.callId != callId || _state.value.phase == CallPhase.Ended || _state.value.phase == CallPhase.Idle) return@launch
                val res = try {
                    api.post<CallRes>("/v1/calls/$callId/join")
                } catch (e: ApiException) {
                    if (e.status == 410 || e.status == 404) { finish("ended", notifyServer = false); return@launch }
                    continue
                }
                val key = if (settings.current.mediaE2ee) messages.callKey(callId) else null
                if (settings.current.mediaE2ee && key == null) continue
                runCatching { connect(callId, res.media ?: continue, key, s.video) }.onSuccess {
                    diag.log("rejoined after ${System.currentTimeMillis() - started} ms ($attempt attempts)")
                    return@launch
                }
            }
            finish("lost", notifyServer = true)
        }
    }

    /** Drops the current room without ending the call (before a rejoin). */
    private fun teardownRoomOnly() {
        stopAppSound(room)
        mediaJob?.cancel()
        mediaJob = null
        eventsJob?.cancel()
        eventsJob = null
        val r = room
        room = null
        synchronized(securityLock) { securityTracker = null }
        if (r != null) scope.launch(Dispatchers.Main) { runCatching { r.disconnect() }; delay(1500); runCatching { r.release() } }
    }

    private fun teardown() {
        routeCheck?.cancel()
        routeCheck = null
        routedRoom = null
        peerWait?.cancel()
        peerWait = null
        rejoinJob?.cancel()
        rejoinJob = null
        IncomingCallNotifier.cancel(context)
        synchronized(firstSeen) { firstSeen.clear() }
        mediaJob?.cancel()
        mediaJob = null
        eventsJob?.cancel()
        eventsJob = null
        diag.stop()
        val r = room
        room = null
        val guard = cryptorGuard
        cryptorGuard = null
        synchronized(securityLock) { securityTracker = null }
        val listener = audioListener
        audioListener = null
        CallService.stop(context)
        if (r != null) {
            listener?.let { l -> runCatching { r.audioSwitchHandler?.unregisterAudioDeviceChangeListener(l) } }
            releaseJob = scope.launch(Dispatchers.Main) {
                delay(600)
                runCatching { guard?.sweep(r) }
                runCatching { r.disconnect() }
                delay(2000)
                runCatching { r.release() }
                guard?.let { diag.log("frame-cryptor guard after release: ${it.lateCallbacks} late callbacks ignored, ${it.failedCallbacks} failed") }
            }
        }
    }

    private fun reset() {
        userRoute = null
        shareRotation.stop()
        stopAppSound(room)
        _minimized.value = false
        _state.value = CallUiState()
        // No call any more: no ongoing-call notification either, whatever raced the service's stop.
        if (room == null) CallService.cancelNotification(context)
    }

    companion object {
        private const val TAG = "CallManager"
        /** How long after a route change the phone's reported route is checked. */
        private const val ROUTE_CHECK_MS = 1500L
        /** Longest wait for a camera switch to show the new camera's first frame. */
        private const val CAMERA_SWITCH_TIMEOUT_MS = 3000L
        /** The callee looks for the call's key every 50 ms, for up to 10 s (it used to look every 250 ms). */
        private const val KEY_WAIT_STEP_MS = 50L
        private const val KEY_WAIT_STEPS = 200
        private const val FIRST_AUDIO_WATCH_MS = 5000L
    }
}

/** A live call as rows show it: its kind, how many people are in it and who is sharing a screen. */
data class LiveCall(val callId: String, val video: Boolean, val people: Int, val sharing: List<String>) {
    companion object {
        fun of(call: com.meldiq.android.data.api.CallDto) =
            LiveCall(call.id, call.video, call.participants.map { it.userId }.distinct().size, call.sharing.distinct())
    }
}
