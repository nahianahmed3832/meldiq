package com.meldiq.android.ui.screens.conversation

import com.meldiq.android.ui.theme.listItemMotion

import com.meldiq.android.R
import com.meldiq.android.data.model.MentionSpan
import com.meldiq.android.data.model.MentionRules
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import com.meldiq.android.ui.media.CreateDocumentFor
import com.meldiq.android.ui.media.MediaAction
import com.meldiq.android.ui.media.MediaGallery
import com.meldiq.android.ui.media.MediaViewer
import com.meldiq.android.data.model.AttachmentRef
import androidx.compose.material.icons.outlined.AddReaction
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Headset
import androidx.compose.material.icons.outlined.MarkChatUnread
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Share
import android.widget.Toast
import android.os.Build
import androidx.activity.result.PickVisualMediaRequest
import com.meldiq.android.data.model.AttachmentPolicy
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Translate
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.ContactPage
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.automirrored.outlined.Forward
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.semantics.heading
import android.Manifest
import android.content.ClipData
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import com.meldiq.android.data.model.ComposerAux
import com.meldiq.android.ui.media.BulkSave
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.BookmarkRemove
import androidx.compose.material.icons.outlined.BookmarkAdd
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.GppMaybe
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.db.MessageEntity
import com.meldiq.android.data.model.MessageStatus
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.data.repo.GlobalAddress
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.friendly
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.BannerKind
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.GlassSheet
import com.meldiq.android.ui.components.MenuRow
import com.meldiq.android.ui.components.StatusBanner
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.containerViewModel
import com.meldiq.android.ui.screens.chats.ConversationAvatar
import com.meldiq.android.ui.screens.home.ConnectionBanner
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.voice.VoiceDraftController
import com.meldiq.android.voice.VoiceNote
import kotlinx.coroutines.launch

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🎉", "😮", "🙏")
/** Pause after typing before searching the conversation. */
private const val SEARCH_DEBOUNCE_MS = 200L

@Composable
fun ConversationScreen(nav: NavHostController, conversationId: String, threadRoot: String?, focusMessage: String? = null) {
    val vm = containerViewModel(key = "conv:$conversationId:$threadRoot") { ConversationViewModel(it, conversationId, threadRoot) }
    val c = Griip.colors
    val ctx = LocalContext.current
    val conv by vm.conversation.collectAsStateWithLifecycle()
    val messages by vm.messages.collectAsStateWithLifecycle()
    // Who reacted: the message and the reaction long-pressed (as Meldiq Web's reactions dialog).
    var reactorsFor by remember { mutableStateOf<Pair<String, String>?>(null) }
    // What the list shows, newest first.
    val timeline = messages
    val currentTimeline by androidx.compose.runtime.rememberUpdatedState(timeline)
    val root by vm.rootMessage.collectAsStateWithLifecycle()
    val users by vm.users.collectAsStateWithLifecycle()
    val typing by vm.typing.collectAsStateWithLifecycle()
    val threadCounts by vm.threadCounts.collectAsStateWithLifecycle()
    val forumReplies by vm.forumReplies.collectAsStateWithLifecycle()
    val transfers by vm.transfers.collectAsStateWithLifecycle()
    val conn by vm.connection.collectAsStateWithLifecycle()
    val call by vm.call.collectAsStateWithLifecycle()
    val replyTo by vm.replyTo.collectAsStateWithLifecycle()
    val editing by vm.editing.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val changedMembers by vm.changedMembers.collectAsStateWithLifecycle()
    val heldIncoming by vm.heldIncoming.collectAsStateWithLifecycle()
    val voiceDraft by vm.voiceDraft.state.collectAsStateWithLifecycle()
    val voicePlayer by vm.voicePlayer.collectAsStateWithLifecycle()
    var actionFor by remember { mutableStateOf<MessageEntity?>(null) }
    var infoFor by remember { mutableStateOf<MessageEntity?>(null) }
    // Text plus cursor: the cursor says where an @mention is being typed.
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
    val text = field.text
    fun setText(t: String) { field = TextFieldValue(t, TextRange(t.length)) }
    val mentionMembers by vm.mentionMembers.collectAsStateWithLifecycle()
    // A send that failed before the message was stored gives its text back (only into an empty composer).
    val restore by vm.restoreText.collectAsStateWithLifecycle()
    LaunchedEffect(restore) { restore?.let { if (field.text.isEmpty()) setText(it); vm.restoreText.value = null } }
    val canMentionAll by vm.canMentionAll.collectAsStateWithLifecycle()
    // Swipe-to-reply and the menu's "Reply" put the cursor in the composer, showing the keyboard.
    val composerFocus = remember { FocusRequester() }
    val focusComposer: () -> Unit = { runCatching { composerFocus.requestFocus() } }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    // Up to 10 photos, videos or files at once, reviewed in the send preview (BatchComposer) before anything is uploaded.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) vm.pick(ctx, uris) }
    val mediaPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(AttachmentPolicy.MAX_ITEMS)) { uris -> if (uris.isNotEmpty()) vm.pick(ctx, uris) }
    var attachSheet by remember { mutableStateOf(false) }
    val batch by vm.batch.collectAsStateWithLifecycle()
    val batchNote by vm.batchNote.collectAsStateWithLifecycle()
    val riskyOpen by vm.riskyOpen.collectAsStateWithLifecycle()
    val maxFile by vm.maxFile.collectAsStateWithLifecycle()
    val chatSettings by vm.c.settings.state.collectAsStateWithLifecycle()
    // Camera: a photo or a video taken now, reviewed in the send preview like a picked one. The camera permission is
    // asked only when the camera is used.
    var captureUri by rememberSaveable { mutableStateOf<String?>(null) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> captureUri?.let { u -> if (ok) vm.pick(ctx, listOf(android.net.Uri.parse(u))) } }
    val takeVideo = rememberLauncherForActivityResult(ActivityResultContracts.CaptureVideo()) { ok -> captureUri?.let { u -> if (ok) vm.pick(ctx, listOf(android.net.Uri.parse(u))) } }
    var pendingCamera by remember { mutableStateOf<Boolean?>(null) } // true: video
    fun launchCamera(video: Boolean) {
        val dir = java.io.File(ctx.cacheDir, "camera").apply { mkdirs() }
        val f = java.io.File(dir, "meldiq-${System.currentTimeMillis()}" + if (video) ".mp4" else ".jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", f)
        captureUri = uri.toString()
        runCatching { if (video) takeVideo.launch(uri) else takePhoto.launch(uri) }.onFailure { vm.error.value = ctx.getString(R.string.b5_no_camera) }
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val v = pendingCamera
        pendingCamera = null
        if (granted && v != null) launchCamera(v) else if (!granted) vm.error.value = ctx.getString(R.string.b5_need_camera)
    }
    fun openCamera(video: Boolean) {
        if (androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) launchCamera(video)
        else { pendingCamera = video; cameraPermission.launch(android.Manifest.permission.CAMERA) }
    }
    // Contact: one picked entry, previewed before sending.
    // Round 7: a Meldiq profile card (yours or someone you talk to), never an address-book entry or phone number.
    var profileSheet by remember { mutableStateOf(false) }
    // Location: once, after the person confirms.
    var locationSheet by remember { mutableStateOf(false) }
    var location by remember { mutableStateOf<com.meldiq.android.data.model.SharedLocation?>(null) }
    var locating by remember { mutableStateOf(false) }
    var locationProblem by remember { mutableStateOf<String?>(null) }
    fun locate() {
        locating = true
        locationProblem = null
        scope.launch {
            val l = com.meldiq.android.media.OneShotLocation.current(ctx)
            location = l?.let { com.meldiq.android.data.model.RichRules.clean(com.meldiq.android.data.model.SharedLocation(it.latitude, it.longitude, if (it.hasAccuracy()) it.accuracy else null)) }
            if (location == null) locationProblem = ctx.getString(R.string.b5_no_location)
            locating = false
        }
    }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        if (res.values.any { it }) { locationSheet = true; locate() } else vm.error.value = ctx.getString(R.string.b5_need_location)
    }
    fun shareLocation() {
        val has = listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { androidx.core.content.ContextCompat.checkSelfPermission(ctx, it) == android.content.pm.PackageManager.PERMISSION_GRANTED }
        if (has) { locationSheet = true; locate() }
        else locationPermission.launch(arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION))
    }
    var emojiSheet by remember { mutableStateOf(false) }
    var pollSheet by remember { mutableStateOf(false) }
    var newPostSheet by remember { mutableStateOf(false) }
    var remindFor by remember { mutableStateOf<MessageEntity?>(null) }
    val stickerPrefs = remember { com.meldiq.android.data.repo.StickerPrefs(ctx) }
    val emojiPrefs = remember { com.meldiq.android.data.repo.EmojiPrefs(ctx) }
    // Batch B9: the community's own emoji and stickers (servers with `community-expressions`).
    val expressionLists by vm.c.expressions.lists.collectAsStateWithLifecycle()
    val convOrg = conv?.orgId
    val communityExpressions = convOrg?.let { expressionLists[it] }.orEmpty()
    LaunchedEffect(convOrg) {
        if (convOrg != null && vm.c.features.has(com.meldiq.android.data.repo.ServerFeatures.COMMUNITY_EXPRESSIONS) == true) runCatching { vm.c.expressions.refresh(convOrg) }
    }
    /** The message getting a reaction from the full picker ("More reactions"). */
    var reactFor by remember { mutableStateOf<MessageEntity?>(null) }
    // Saved for later (Home › Later): which messages here are saved, and whether this server keeps them.
    val saved by vm.saved.collectAsStateWithLifecycle()
    val savingSupported by vm.savingSupported.collectAsStateWithLifecycle()
    val savedIds = remember(saved) { saved.map { it.messageId }.toSet() }
    // Search in this conversation: messages are decrypted only on this phone, so the search runs here.
    var searching by rememberSaveable { mutableStateOf(false) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<MessageEntity>>(emptyList()) }
    LaunchedEffect(searchQuery, searching) {
        if (!searching) return@LaunchedEffect
        kotlinx.coroutines.delay(SEARCH_DEBOUNCE_MS)
        searchResults = vm.search(searchQuery)
    }
    androidx.activity.compose.BackHandler(enabled = searching) { searching = false; searchQuery = "" }
    val translations by vm.translations.collectAsStateWithLifecycle()
    var translateFor by remember { mutableStateOf<MessageEntity?>(null) }
    // Links: opened as the Chat settings say, after a confirmation when asked for or when the address looks misleading.
    var linkToOpen by remember { mutableStateOf<String?>(null) }
    val onOpenLink: (String) -> Unit = { url ->
        // Batch B4b: a Meldiq invite link opens the invite here (preview, then join), not in a browser.
        val uri = runCatching { android.net.Uri.parse(url) }.getOrNull()
        val invite = if (uri != null && com.meldiq.android.ui.scan.InviteCodes.isInviteLink(uri.scheme, uri.host, uri.path)) com.meldiq.android.ui.scan.InviteCodes.fromScan(url) else null
        val messageLink = com.meldiq.android.data.model.MessageLinks.parse(url)
        if (invite != null) nav.navigate(com.meldiq.android.ui.Routes.JOIN + "?code=$invite")
        else if (messageLink != null) scope.launch { com.meldiq.android.ui.MessageLinkOpener.open(vm.c, nav, ctx, messageLink) }
        else if (com.meldiq.android.ui.LinkOpener.needsConfirmation(url, chatSettings.linkOpening)) linkToOpen = url
        else if (!com.meldiq.android.ui.LinkOpener.open(ctx, url, chatSettings.linkOpening == com.meldiq.android.data.repo.LinkOpening.IN_APP)) vm.error.value = ctx.getString(R.string.b5_no_app_link)
    }
    val composerPreview by vm.linkPreview.collectAsStateWithLifecycle()
    var forwardFor by remember { mutableStateOf<MessageEntity?>(null) }
    // Batch B4: reporting someone else's message (servers with `reports`).
    var reportFor by remember { mutableStateOf<MessageEntity?>(null) }
    var reportsAvailable by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { reportsAvailable = vm.c.features.has(com.meldiq.android.data.repo.ServerFeatures.REPORTS) == true }
    // Photos and videos open in the in-app viewer; other files are opened explicitly with another app.
    // 2026-10-23: the YouTube video playing inside Meldiq (message id, video id).
    var playing by remember { mutableStateOf<Pair<String, String>?>(null) }
    var viewerFor by rememberSaveable { mutableStateOf<String?>(null) }
    var saveTarget by remember { mutableStateOf<AttachmentRef?>(null) }
    val notice by vm.notice.collectAsStateWithLifecycle()
    LaunchedEffect(notice) { notice?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show(); vm.notice.value = null } }
    val saveDocument = rememberLauncherForActivityResult(CreateDocumentFor()) { uri -> val ref = saveTarget; if (uri != null && ref != null) vm.saveToDocument(ref, uri) }
    val storagePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val ref = saveTarget
        if (ok && ref != null) vm.saveToGallery(ref) else if (!ok) vm.error.value = ctx.getString(R.string.b5_need_storage)
    }
    val onMedia: (MediaAction, AttachmentRef) -> Unit = { action, ref ->
        saveTarget = ref
        when (action) {
            MediaAction.SaveToGallery ->
                if (MediaGallery.needsStoragePermission(Build.VERSION.SDK_INT) &&
                    ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
                ) storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE) else vm.saveToGallery(ref)
            MediaAction.SaveToFiles -> saveDocument.launch(MediaGallery.safeName(ref.name, ref.mime) to ref.mime)
            MediaAction.Share -> vm.share(ref) { intent -> runCatching { ctx.startActivity(intent) } }
        }
    }
    val openAttachment: (AttachmentRef) -> Unit = { ref -> if (MediaGallery.kindOf(ref) != null) viewerFor = ref.id else vm.openAttachment(ctx, ref) }
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 4 } }
    // The "New messages" line (docs/product/MELDIQ_COMMUNITY_CHAT_SPEC.md §5): placed once, above the oldest message
    // that was unread when the conversation opened, and the list starts there.
    val unreadAtOpen by vm.unreadAtOpen.collectAsStateWithLifecycle()
    var unreadMarker by rememberSaveable { mutableStateOf<String?>(null) }
    var unreadMarkerPlaced by rememberSaveable { mutableStateOf(false) }
    val permission = com.meldiq.android.ui.screens.calls.rememberCallPermission()
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.startVoice() else vm.error.value = VoiceDraftController.PERMISSION
    }
    val onMic = {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) vm.startVoice()
        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) vm.onVisible()
            if (e == Lifecycle.Event.ON_PAUSE) vm.onHidden()
            if (e == Lifecycle.Event.ON_STOP) vm.interruptVoice()
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); vm.onHidden() }
    }
    // Restore a saved draft once, when the conversation first loads (not after every send).
    var draftRestored by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(conv != null) {
        if (!draftRestored && conv != null) {
            draftRestored = true
            if (text.isEmpty() && editing == null) conv?.draft?.let { setText(it) }
        }
    }
    // The reply target follows its message: dropped if it's deleted, refreshed if it's edited.
    LaunchedEffect(messages, replyTo?.id) { replyTo?.let { t -> vm.refreshReplyTarget(messages.firstOrNull { it.id == t.id }) } }
    LaunchedEffect(messages.firstOrNull()?.id) {
        if (messages.isNotEmpty()) {
            if (listState.firstVisibleItemIndex <= 2) listState.animateScrollToItem(0)
            vm.onVisible()
        }
    }
    LaunchedEffect(unreadAtOpen, messages.isNotEmpty()) {
        val n = unreadAtOpen ?: return@LaunchedEffect
        if (unreadMarkerPlaced || messages.isEmpty()) return@LaunchedEffect
        unreadMarkerPlaced = true
        val lines = messages.map { com.meldiq.android.data.model.ConversationMarkers.Line(it.id, it.outgoing, it.kind == "text" && !it.deleted) }
        unreadMarker = com.meldiq.android.data.model.ConversationMarkers.firstUnread(lines, n)
        val idx = unreadMarker?.let { id -> currentTimeline.indexOfFirst { it.id == id } } ?: -1
        if (idx > 2) {
            // Reverse layout: the item lands at the bottom; move it up so the unread messages after it fit below.
            listState.scrollToItem(idx)
            listState.scrollBy(-(listState.layoutInfo.viewportSize.height * 0.6f))
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
            if (last >= currentTimeline.size - 5) vm.loadMore()
        }
    }

    val me = vm.me
    val title = conv?.let { ConversationRepository.title(it, me) } ?: ""
    val youLabel = stringResource(R.string.pin_you)
    val someoneLabel = stringResource(R.string.activity_someone)
    val jumpLabel = stringResource(R.string.b5_jump_latest)
    // Mentions are drawn from the message's mentioned ids, never from the text alone (docs/MENTIONS.md).
    fun mentionSpansFor(m: MessageEntity): List<MentionSpan> {
        if (m.text.isEmpty() || !m.text.contains('@')) return emptyList()
        val stored = MentionRules.fromStored(vm.c.messages.mentions(m))
        return MentionRules.spans(m.text, stored.ids, stored.all) { id -> users[id]?.username ?: mentionMembers.firstOrNull { it.id == id }?.username }
    }
    fun previewOf(m: MessageEntity) = com.meldiq.android.data.model.MessagePreview.of(m)
    /** Scrolls to a message (a search hit or a pin), loading older pages first when it isn't loaded yet. */
    fun jumpTo(id: String) {
        val idx = timeline.indexOfFirst { it.id == id }
        if (idx >= 0) scope.launch { listState.animateScrollToItem(idx) }
        else vm.loadUntil(id) { _ ->
            // Find it again in the list as it is now.
            scope.launch { kotlinx.coroutines.delay(50); currentTimeline.indexOfFirst { it.id == id }.takeIf { it >= 0 }?.let { listState.animateScrollToItem(it) } }
        }
    }
    // Batch B5: a message link scrolls to its message once the conversation has loaded.
    var focusDone by androidx.compose.runtime.saveable.rememberSaveable(focusMessage) { mutableStateOf(false) }
    LaunchedEffect(focusMessage, messages.isNotEmpty()) {
        if (focusMessage == null || focusDone || messages.isEmpty()) return@LaunchedEffect
        focusDone = true
        jumpTo(focusMessage)
    }
    val peer = conv?.let { ConversationRepository.peer(it, me) }
    val onlineCount by vm.onlineCount.collectAsStateWithLifecycle()
    val onlineLabel: (Int) -> String = { n -> ctx.getString(com.meldiq.android.R.string.r3_online_count, n) }
    androidx.compose.runtime.LaunchedEffect(conversationId, conv?.type) {
        while (conv?.type == "CHANNEL") {
            vm.refreshOnline()
            kotlinx.coroutines.delay(ONLINE_REFRESH_MS)
        }
    }
    val peerUser = peer?.let { users[it.id] }
    val isGroup = conv?.type != "DM"
    // People on another server (federation): their presence isn't shared across servers, and calls with them aren't available yet.
    val remoteMembers = conv?.let { ConversationRepository.remoteMembers(it) }.orEmpty()
    val federation by vm.c.conversations.federation.collectAsStateWithLifecycle()
    val remoteServers = federation[conversationId]?.servers.orEmpty()
    var showSecurity by remember { mutableStateOf(false) }
    // Batch B14: what the details screen asked for on its way back (search, the security sheet, or a message to open).
    val myEntry = remember { nav.currentBackStackEntry }
    val detailsAction by (myEntry?.savedStateHandle?.getStateFlow<String?>(DETAILS_ACTION, null) ?: kotlinx.coroutines.flow.MutableStateFlow<String?>(null))
        .collectAsStateWithLifecycle()
    LaunchedEffect(detailsAction) {
        val a = detailsAction ?: return@LaunchedEffect
        myEntry?.savedStateHandle?.set(DETAILS_ACTION, null)
        when {
            a == DetailsActions.SEARCH -> searching = true
            a == DetailsActions.SECURITY -> showSecurity = true
            else -> DetailsActions.jumpTarget(a)?.let { jumpTo(it) }
        }
    }
    // Batch B8: forum post guidelines (servers with `forum-guidelines`).
    val forumGuidelines by vm.c.conversations.guidelines.collectAsStateWithLifecycle()
    // The composer's attach/emoji buttons step aside while typing (round 7, [ComposerAux]); any touch on the messages
    // brings them back at once.
    val composerAux = remember { mutableStateOf(ComposerAux.State()) }
    // Saving several files at once (round 7): the selected messages (null while not selecting), and files the person
    // left out of the batch in the review sheet.
    var selected by remember { mutableStateOf<Set<String>?>(null) }
    var bulkSheet by remember { mutableStateOf(false) }
    var bulkExcluded by remember { mutableStateOf(emptySet<String>()) }
    val bulkBatch by vm.bulk.batch.collectAsStateWithLifecycle()
    fun bulkPicked(): List<Pair<String, AttachmentRef>> = selected.orEmpty().let { ids ->
        messages.filter { it.id in ids }.sortedBy { it.sortTs }.flatMap { m -> vm.c.messages.attachments(m).map { m.id to it } }
    }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val plan = BulkSave.plan(bulkPicked(), bulkExcluded)
        if (uri != null && plan is BulkSave.Plan.Ready) vm.bulk.start(plan.items, BulkSaver.Target.Folder(uri))
    }
    fun endSelection() {
        vm.bulk.close()
        bulkSheet = false
        selected = null
        bulkExcluded = emptySet()
    }
    androidx.activity.compose.BackHandler(selected != null) { if (bulkBatch?.summary?.running != true) endSelection() }
    val securityFacts = com.meldiq.android.data.model.ConversationSecurity.Facts(
        type = conv?.type ?: "DM",
        peerVerified = if (conv?.type == "DM") peerUser?.verified == true else null,
        changedMembers = changedMembers.size,
        otherServers = remoteServers.size.coerceAtLeast(if (remoteMembers.isNotEmpty()) 1 else 0),
        callMediaE2ee = chatSettings.mediaE2ee,
    )
    val subtitle = when {
        threadRoot != null && conv?.type == "CHANNEL" -> androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_thread_in, conv?.name.orEmpty())
        threadRoot != null -> stringResource(R.string.b5_thread)
        typing.isNotEmpty() -> if (isGroup) stringResource(R.string.b5_typing_named, typing.first()) else stringResource(R.string.b5_typing)
        conv?.type == "DM" && peer != null && remoteMembers.isNotEmpty() -> "@${peer.username}"
        conv?.type == "DM" -> listOfNotNull(
            when {
                peerUser?.online != true -> stringResource(R.string.b5_last_seen, TimeFmt.relative(peerUser?.lastSeenAt))
                peerUser.presence == com.meldiq.android.data.model.PresenceRules.IDLE -> stringResource(R.string.b6b_idle)
                peerUser.presence == com.meldiq.android.data.model.PresenceRules.DND -> stringResource(R.string.b6b_dnd)
                else -> stringResource(R.string.b5_online)
            },
            // Round 3: their status as they show it to you.
            listOfNotNull(peer?.statusEmoji, peer?.statusText).joinToString(" ").ifBlank { null },
        ).joinToString(" · ")
        // Batch B14b (the owner's reference: "3 Online"): who's online here, or the member count when nobody is (or the
        // server doesn't share it).
        conv?.type == "CHANNEL" -> onlineCount?.takeIf { it > 0 }?.let { onlineLabel(it) }
            ?: com.meldiq.android.ui.screens.community.memberCountLabel(conv?.memberCount ?: 0)
        else -> com.meldiq.android.ui.screens.community.memberCountLabel(conv?.memberCount ?: 0)
    }

    // Batch B14: a voice channel opens as its room (who's in it, Join, invite), with no messages or composer.
    conv?.takeIf { it.voice && threadRoot == null }?.let { room ->
        VoiceChannelScreen(nav, room, users, call, onJoin = { permission(false) { vm.startCall(false) } }, onOpenCall = { vm.c.calls.expand() })
        return
    }
    // Batch B12: the community's own emoji, for reactions written as `:name:`.
    val communityEmoji = remember(communityExpressions) { communityExpressions.filter { it.kind == "emoji" }.associate { it.name to vm.c.expressions.ref(it) } }
    androidx.compose.runtime.CompositionLocalProvider(com.meldiq.android.ui.components.LocalCommunityEmoji provides communityEmoji) {
        Column(Modifier.fillMaxSize().imePadding()) {
            // Header (or the search bar while searching this conversation)
            if (selected != null) {
                BulkSelectionBar(
                    files = bulkPicked().size, messages = selected.orEmpty().size,
                    onClose = { endSelection() },
                    onSelectAll = { selected = messages.filter { !it.deleted && vm.c.messages.attachments(it).isNotEmpty() }.map { it.id }.toSet() },
                    onSave = { bulkExcluded = emptySet(); bulkSheet = true },
                )
            } else if (searching) {
                ConversationSearchBar(searchQuery, { searchQuery = it }, onClose = { searching = false; searchQuery = "" })
            } else Row(
                Modifier.fillMaxWidth().background(c.surface).statusBarsPadding().height(64.dp).padding(start = 4.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircleIconButton(Icons.AutoMirrored.Rounded.ArrowBack, stringResource(R.string.b5_back), { nav.popBackStack() })
                Row(
                    Modifier.weight(1f).clip(Shapes.small).pressable({ nav.navigate(Routes.info(conversationId)) }, onClickLabel = stringResource(R.string.b5_open_info)).padding(vertical = 6.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Batch B14b: a channel's header is its name and "›" (tap for details), with no picture beside it.
                    val channelHeader = conv?.type == "CHANNEL"
                    if (!channelHeader) {
                        conv?.let { ConversationAvatar(it, me, size = 40.dp, online = peerUser?.online, presence = peerUser?.presence) }
                        Spacer(Modifier.width(10.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        val postTitle = if (threadRoot != null && conv?.format == "forum") root?.let { r -> com.meldiq.android.data.model.ForumRules.titleOf(vm.c.messages.rich(r)?.title, r.text) } else null
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                postTitle ?: if (channelHeader) "#$title" else title, style = Griip.type.titleSmall, color = c.textPrimary, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                            )
                            if (channelHeader && threadRoot == null) Icon(Icons.Rounded.ChevronRight, null, tint = c.textTertiary, modifier = Modifier.size(20.dp))
                        }
                        val online = typing.isEmpty() && (peerUser?.online == true || (channelHeader && (onlineCount ?: 0) > 0))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (channelHeader && online && threadRoot == null) {
                                Box(Modifier.size(8.dp).clip(androidx.compose.foundation.shape.CircleShape).background(c.success))
                                Spacer(Modifier.width(5.dp))
                            }
                            Text(subtitle, style = Griip.type.caption, color = if (typing.isNotEmpty() || peerUser?.online == true) c.primary else c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                // With people on another server, calls need this server to host them (it says so per conversation).
                val canCall = remoteMembers.isEmpty() || federation[conversationId]?.calls == true
                // Text channels have no call buttons (round 7): a workspace's calls happen in its voice rooms. DMs and
                // groups still call each other.
                val textChannel = conv?.type == "CHANNEL"
                // Batch B6: no calls through a message request, either way (the server refuses them too).
                if (threadRoot == null && conv?.removed != true && canCall && conv?.voice != true && !textChannel && conv?.request == null) {
                    CircleIconButton(Icons.Rounded.Call, stringResource(R.string.b5_voice_call), { permission(false) { vm.startCall(false) } }, tint = c.primary, enabled = call.phase == CallPhase.Idle)
                    CircleIconButton(Icons.Rounded.Videocam, stringResource(R.string.b5_video_call), { permission(true) { vm.startCall(true) } }, tint = c.primary, enabled = call.phase == CallPhase.Idle)
                }
                // Batch B14 and B14b: the header keeps calls (DMs and groups) and search; pins, threads, files and security
                // are tabs and rows of the details screen.
                // Batch B8: follow a thread or forum post, so its replies show in Activity.
                if (threadRoot != null) {
                    val followed by vm.c.followedThreads.followed.collectAsStateWithLifecycle()
                    val following = threadRoot in followed
                    com.meldiq.android.ui.components.PillChip(
                        stringResource(if (following) R.string.b8_following else R.string.b8_follow), following,
                        { scope.launch { vm.c.followedThreads.set(threadRoot, !following) } },
                    )
                }
                // 2026-10-23: a text channel's bell mutes it for a while and sets its notification level.
                if (textChannel && threadRoot == null && conv?.removed != true) conv?.let { com.meldiq.android.ui.screens.community.ChannelBellButton(it) }
                CircleIconButton(Icons.Rounded.Search, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.conv_search), { searching = true }, tint = c.textSecondary)
            }
            if (showSecurity) {
                ConversationSecuritySheet(
                    securityFacts, peerUser?.displayName ?: peer?.displayName,
                    onVerify = peer?.let { p -> { showSecurity = false; nav.navigate(Routes.user(p.id)) } },
                    onDismiss = { showSecurity = false },
                )
            }
            HorizontalDivider(thickness = 1.dp, color = c.border)
            ConnectionBanner(conn, Modifier.padding(horizontal = 16.dp, vertical = 2.dp)) { vm.c.realtime.reconnectNow() }
            // Round 3 (the reference's "… has paused their notifications"): only when their last-seen setting lets you know.
            if (conv?.type == "DM" && threadRoot == null && peer?.notificationsPaused == true) {
                StatusBanner(
                    androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.r3_peer_paused, peer.displayName),
                    BannerKind.Info, Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    icon = androidx.compose.material.icons.Icons.Outlined.NotificationsOff,
                )
            }
            remoteServers.firstOrNull { it.state == "decommissioned" || it.state == "revoked" }?.let { s ->
                StatusBanner(
                    stringResource(R.string.b5_server_gone, s.domain ?: stringResource(R.string.b5_their_server)),
                    BannerKind.Error, Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            } ?: remoteServers.firstOrNull { it.state == "unreachable" }?.let { s ->
                StatusBanner(
                    stringResource(R.string.b5_server_unreachable, s.domain ?: stringResource(R.string.b5_their_server)),
                    BannerKind.Warning, Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            if (changedMembers.isNotEmpty()) {
                val who = if (changedMembers.size == 1) stringResource(R.string.b5_key_changed_one, changedMembers.first().displayName.ifEmpty { stringResource(R.string.b5_a_member) })
                    else stringResource(R.string.b5_key_changed_many, changedMembers.size)
                val waiting = when {
                    heldIncoming == 1 -> " " + stringResource(R.string.b5_held_one)
                    heldIncoming > 1 -> " " + stringResource(R.string.b5_held_many, heldIncoming)
                    else -> ""
                }
                StatusBanner(
                    who + waiting,
                    BannerKind.Warning, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), icon = Icons.Rounded.GppMaybe,
                    action = stringResource(R.string.b5_review), onAction = { nav.navigate(Routes.user(changedMembers.first().id)) },
                )
            }
            val activeCall = conv?.activeCallId
            // A voice room (round 6): who's in it, and Join (which opens it when nobody is there yet).
            if (conv?.voice == true && conv?.canConnect == false && threadRoot == null) {
                StatusBanner(
                    androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_no_voice), BannerKind.Info,
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp), icon = Icons.Outlined.Headset,
                )
            } else if (conv?.voice == true && call.phase == CallPhase.Idle && threadRoot == null) {
                if (conv?.canSpeak == false) StatusBanner(
                    androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_listen_only), BannerKind.Info,
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp), icon = Icons.Outlined.Headset,
                )
                val here = conv?.let { com.meldiq.android.ui.screens.home.roomPeople(it).size } ?: 0
                StatusBanner(
                    if (here > 0) androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.vr_banner_here, here)
                    else androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.vr_banner_empty),
                    if (here > 0) BannerKind.Success else BannerKind.Info,
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp), icon = Icons.Outlined.Headset,
                    action = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.vr_join), onAction = { permission(false) { vm.startCall(false) } },
                )
            } else if (activeCall != null && call.phase == CallPhase.Idle && threadRoot == null) {
                StatusBanner(
                    stringResource(if (conv?.activeCallVideo == true) R.string.b5_call_video_live else R.string.b5_call_voice_live), BannerKind.Success,
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp), icon = Icons.Rounded.Call, action = stringResource(R.string.b5_join), onAction = { permission(conv?.activeCallVideo == true) { vm.joinCall(activeCall, conv?.activeCallVideo == true) } },
                )
            }
            // What connected apps posted in this channel (server-visible, labelled as such).

            // Messages, over Settings › Chats › wallpaper.
            Box(
                Modifier.weight(1f).then(com.meldiq.android.ui.theme.Wallpapers.modifier(chatSettings.wallpaper, c))
                    .observeTouches { composerAux.value = ComposerAux.onOutside(composerAux.value) },
            ) {
                // A forum channel lists its posts; each post opens as a thread (communities, 2026-10-21).
                if (conv?.format == "forum" && threadRoot == null && !searching) {
                    ForumPostList(
                        messages, forumReplies, users, me,
                        title = { m -> com.meldiq.android.data.model.ForumRules.titleOf(vm.c.messages.rich(m)?.title, m.text) },
                        body = { m -> com.meldiq.android.data.model.ForumRules.body(vm.c.messages.rich(m)?.title ?: m.text.lineSequence().firstOrNull(), m.text) },
                        onOpen = { m -> nav.navigate(Routes.conversation(conversationId, m.id)) },
                        forumTags = conv?.let { vm.c.conversations.forumTags(it) }.orEmpty(),
                        postTags = { m -> vm.c.messages.rich(m)?.tags.orEmpty() },
                        guidelines = forumGuidelines[conversationId],
                        topReaction = { m -> com.meldiq.android.data.model.ForumRules.topReaction(vm.c.messages.reactions(m)) },
                    )
                    return@Box
                }
                if (messages.isEmpty() && threadRoot == null && conv?.type == "CHANNEL") {
                    ChannelWelcome(
                        conv?.name.orEmpty(), conv?.topic, conv?.canManage == true,
                        onEdit = { nav.navigate(Routes.info(conversationId)) }, onAddPeople = { nav.navigate(Routes.info(conversationId)) },
                        modifier = Modifier.align(Alignment.Center),
                    )
                } else if (messages.isEmpty() && threadRoot == null) {
                    EmptyState(
                        Icons.Rounded.Lock, stringResource(R.string.b5_say_hello),
                        if (remoteMembers.isNotEmpty()) {
                            "${remoteMembers.first().displayName} is on another server (${GlobalAddress.serverOf(remoteMembers.first().username) ?: "elsewhere"}). Messages are end-to-end encrypted on your device; both servers only relay encrypted copies, kept for at most 7 days until delivered."
                        } else {
                            stringResource(R.string.b5_e2e_intro)
                        },
                        modifier = Modifier.align(Alignment.Center),
                    )
                }
                if (searching && searchQuery.isNotBlank()) {
                    ConversationSearchResults(
                        searchQuery, searchResults, users, me,
                        onOpen = { hit ->
                            searching = false
                            searchQuery = ""
                            jumpTo(hit.id)
                        },
                        modifier = Modifier.fillMaxSize().background(c.background),
                    )
                    return@Box
                }
                val byId = remember(messages) { messages.associateBy { it.id } }
                LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true, contentPadding = PaddingValues(vertical = 10.dp)) {
                    itemsIndexed(timeline, key = { _, e -> e.id }) { i, m ->
                        val older = timeline.getOrNull(i + 1)
                        val newer = timeline.getOrNull(i - 1)
                        val first = older == null || older.senderUserId != m.senderUserId || m.sortTs - older.sortTs > 5 * 60_000 || older.kind == "call" || !TimeFmt.sameDay(older.sortTs, m.sortTs)
                        val lastInRun = newer == null || newer.senderUserId != m.senderUserId || newer.sortTs - m.sortTs > 5 * 60_000 || newer.kind == "call"
                        val reply = m.replyToId?.let { byId[it] }
                        // Same rule as the long-press menu's "Reply": a posted text/attachment message where you may post.
                        val canSwipeReply = conv?.canPost != false && !m.deleted && m.kind == "text"
                        val hasFiles = !m.deleted && vm.c.messages.attachments(m).isNotEmpty()
                        // Batch B16: a new message fades in and the others slide up to make room (keys are message ids).
                        Column(
                            listItemMotion().bulkSelectable(selected != null, m.id in selected.orEmpty(), hasFiles, c.primary) {
                                val now = selected.orEmpty()
                                selected = if (m.id in now) now - m.id else now + m.id
                            },
                        ) {
                            if (older == null || !TimeFmt.sameDay(older.sortTs, m.sortTs)) DayDivider(m.sortTs)
                            if (m.id == unreadMarker) NewMessagesDivider()
                            SwipeToReply(chatSettings.swipeReply && canSwipeReply && selected == null, onReply = { vm.replyTo.value = m; vm.editing.value = null; focusComposer() }) {
                            MessageBubble(
                                BubbleModel(
                                    m, users[m.senderUserId], showSender = first, showAvatar = lastInRun, firstInGroup = first, reply = reply,
                                    replySender = reply?.let { if (it.outgoing) youLabel else users[it.senderUserId]?.displayName },
                                    reactions = vm.c.messages.reactions(m), attachments = vm.c.messages.attachments(m),
                                    threadCount = if (threadRoot == null) threadCounts[m.id] ?: 0 else 0, isGroupConv = isGroup,
                                    replyPreview = reply?.let { previewOf(it) },
                                    mentions = mentionSpansFor(m),
                                    rich = vm.c.messages.rich(m),
                                    translation = translations[m.id],
                                    animateEmoji = chatSettings.animatedEmoji,
                                    textScale = chatSettings.textScale,
                                    stream = chatSettings.messageLayout == com.meldiq.android.data.repo.MessageLayout.STREAM,
                                    mediaCards = chatSettings.mediaCards,
                                    canVote = conv?.canPost != false,
                                    saved = m.id in savedIds,
                                    mentionsYou = com.meldiq.android.data.model.ConversationMarkers.mentionsYou(m.outgoing, MentionRules.fromStored(vm.c.messages.mentions(m)), me),
                                ),
                                me = me,
                                transfer = vm.c.messages.attachments(m).firstNotNullOfOrNull { transfers[it.id] } ?: transfers[m.id],
                                localFile = { vm.c.messages.localAttachment(it) },
                                onLongPress = { if (m.kind != "call") actionFor = m },
                                onReact = { vm.react(m, it) },
                                onShowReactions = { e -> reactorsFor = m.id to e },
                                onVote = { vm.vote(m, it) },
                                onOpenAttachment = openAttachment,
                                onOpenThread = { nav.navigate(Routes.conversation(conversationId, m.id)) },
                                onRetry = { vm.retry(m) },
                                onReplyClick = { id -> val idx = timeline.indexOfFirst { it.id == id }; if (idx >= 0) scope.launch { listState.animateScrollToItem(idx) } },
                                onMentionClick = { id -> nav.navigate(Routes.user(id)) },
                                onOpenLink = onOpenLink,
                                onCopyText = { t -> scope.launch { clipboard.setClipEntry(ClipData.newPlainText("contact", t).toClipEntry()) } },
                                onFindPhone = { ph -> vm.findByPhone(ph) { id -> nav.navigate(Routes.user(id)) } },
                                voice = voicePlayer,
                                onVoiceToggle = { ref -> vm.toggleVoice(m.id, ref) },
                                onVoiceSeek = { ref, pos -> vm.seekVoice(m.id, ref, pos) },
                                // Received photos load as their message comes on screen (Settings › Chats › media).
                                onShown = { vm.loadShownMedia(m, ctx) },
                                onDoubleTap = if (chatSettings.doubleTapReact && !m.deleted && m.kind == "text" && selected == null) ({ vm.react(m, chatSettings.doubleTapEmoji) }) else null,
                                onPlayVideo = if (chatSettings.inAppVideo) ({ id -> playing = m.id to id }) else null,
                            )
                            }
                        }
                    }
                    if (threadRoot != null) {
                        item(key = "root") {
                            Column {
                                root?.let { r ->
                                    MessageBubble(
                                        BubbleModel(
                                            r, users[r.senderUserId], true, true, true, null, null, vm.c.messages.reactions(r), vm.c.messages.attachments(r), 0, isGroup,
                                            rich = vm.c.messages.rich(r), stream = chatSettings.messageLayout == com.meldiq.android.data.repo.MessageLayout.STREAM,
                                            mediaCards = chatSettings.mediaCards, canVote = conv?.canPost != false, saved = r.id in savedIds,
                                        ),
                                        me, null, { vm.c.messages.localAttachment(it) }, { actionFor = r }, { vm.react(r, it) }, openAttachment, null, { vm.retry(r) }, {},
                                        voice = voicePlayer,
                                        onVote = { vm.vote(r, it) },
                                        onVoiceToggle = { ref -> vm.toggleVoice(r.id, ref) },
                                        onVoiceSeek = { ref, pos -> vm.seekVoice(r.id, ref, pos) },
                                        onShown = { vm.loadShownMedia(r, ctx) },
                                    )
                                }
                                Text("${messages.size} ${if (messages.size == 1) "reply" else "replies"}", style = Griip.type.label, color = c.textTertiary, modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), textAlign = TextAlign.Center)
                            }
                        }
                    }
                }
                if (showJump) {
                    SmallFloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(0) } },
                        containerColor = c.surface, contentColor = c.primary,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp).semantics { contentDescription = jumpLabel },
                    ) { Icon(Icons.Rounded.KeyboardArrowDown, null) }
                }
            }

            // Typing
            AnimatedVisibility(typing.isNotEmpty()) { TypingRow(typing) }

            // Composer
            error?.let { StatusBanner(it, BannerKind.Error, Modifier.padding(horizontal = 16.dp, vertical = 4.dp), action = stringResource(R.string.b5_ok), onAction = { vm.error.value = null }) }
            // Batch B6: your message request waiting for an answer, with how many more you may send.
            val requestSent by vm.c.conversations.requestSent.collectAsStateWithLifecycle()
            if (conv?.request == com.meldiq.android.data.model.RequestRules.OUTGOING) requestSent[conversationId]?.let { (sent, limit) ->
                StatusBanner(
                    stringResource(R.string.b6_request_waiting, com.meldiq.android.data.model.RequestRules.remaining(sent, limit)),
                    BannerKind.Info, Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            if (conv?.request == com.meldiq.android.data.model.RequestRules.INCOMING && threadRoot == null) {
                MessageRequestBar(
                    peerName = peerUser?.displayName ?: peer?.displayName.orEmpty(),
                    onAnswer = { action ->
                        scope.launch {
                            runCatching { vm.c.conversations.answerRequest(conversationId, action) }
                                .onSuccess { if (action != "accept") nav.popBackStack() }
                                .onFailure { vm.error.value = it.friendly() }
                        }
                    },
                )
            } else if (conv?.format == "forum" && threadRoot == null) {
                Box(Modifier.fillMaxWidth().background(c.surface).navigationBarsPadding()) { ForumComposerBar(conv?.canPost == true) { newPostSheet = true } }
            } else if (conv != null && !conv!!.canPost) {
                // Timed out in the community (MOD-06): says until when, instead of a bare "can't post".
                val timedOutUntil = conv?.timedOutUntil?.takeIf { com.meldiq.android.ui.screens.workspace.TimeoutRules.running(it) }
                Row(
                    Modifier.fillMaxWidth().background(c.surface).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(if (conv?.kind == "ANNOUNCEMENT") Icons.Outlined.Campaign else Icons.Rounded.Lock, null, tint = c.textTertiary)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        when {
                            conv?.removed == true -> stringResource(R.string.b5_not_member)
                            timedOutUntil != null ->
                                androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.to_composer, com.meldiq.android.ui.screens.workspace.TimeoutRules.untilText(timedOutUntil))
                            conv?.archived == true -> stringResource(R.string.b5_archived_channel)
                            conv?.kind == "ANNOUNCEMENT" -> stringResource(R.string.b5_announce_only)
                            else -> stringResource(R.string.b5_cant_post)
                        },
                        style = Griip.type.bodySmall, color = c.textSecondary,
                    )
                }
            } else {
                // @mention autocomplete (groups and channels): the members matching what's typed after "@".
                val query = if (conv?.type != null && conv?.type != "DM" && field.selection.collapsed) MentionRules.activeQuery(text, field.selection.start) else null
                val suggestions = remember(query, mentionMembers, canMentionAll) {
                    query?.let { MentionRules.suggest(mentionMembers, it.query, me, canMentionAll) }.orEmpty()
                }
                if (query != null && suggestions.isNotEmpty()) {
                    MentionSuggestions(suggestions) { choice ->
                        val (t, cursor) = MentionRules.insert(text, query, choice)
                        field = TextFieldValue(t, TextRange(cursor))
                        vm.typingChanged(t)
                    }
                }
                val slowmode by vm.slowmode.collectAsStateWithLifecycle()
                if (threadRoot == null) com.meldiq.android.ui.screens.community.SlowmodeLine(slowmode)
                composerPreview?.let { p ->
                    Row(Modifier.fillMaxWidth().background(c.surface).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) { LinkPreviewCard(p, out = false, onOpen = {}) }
                        CircleIconButton(Icons.Outlined.Close, stringResource(R.string.b5_send_no_preview), { vm.dismissPreview() }, size = 36.dp, tint = c.textSecondary)
                    }
                }
                val mojoState by vm.c.mojo.state.collectAsStateWithLifecycle()
                // Only once the server enforces plan limits (Mojo on sale): until then nobody's messages are limited by plan.
                val mojoChars = mojoState.catalog?.takeIf { it.enforced }?.plan(com.meldiq.android.data.billing.MojoPlans.currentKey(mojoState.entitlements))?.messageChars ?: 0
                Composer(
                    text = field,
                    onText = { field = it; vm.typingChanged(it.text) },
                    replyLabel = replyTo?.let { stringResource(R.string.b5_replying_to, if (it.outgoing) stringResource(R.string.b5_yourself) else users[it.senderUserId]?.displayName ?: "") to previewOf(it) }
                        ?: editing?.let { stringResource(R.string.b5_editing) to it.text },
                    onCancelContext = { vm.replyTo.value = null; vm.editing.value = null; if (editing != null) setText("") },
                    onAttach = { attachSheet = true },
                    onEmoji = { emojiSheet = true },
                    onSend = {
                        vm.send(text, communityExpressions.filter { it.kind == "emoji" }.map(vm.c.expressions::ref))
                        setText("")
                    },
                    placeholder = if (threadRoot != null) stringResource(R.string.b5_reply_thread_ph) else if (conv?.type == "CHANNEL") stringResource(R.string.b5_message_channel, title) else stringResource(R.string.b5_message_ph),
                    voice = VoiceComposerState(
                        draft = voiceDraft,
                        // Voice messages go to the conversation itself, like files, so the microphone isn't offered in a thread.
                        available = threadRoot == null && editing == null,
                        playback = voicePlayer.takeIf { it.key == vm.draftKey },
                    ),
                    onMic = onMic,
                    onStopRecording = vm::stopVoice,
                    onCancelVoice = vm::cancelVoice,
                    onSendVoice = vm::sendVoice,
                    onToggleDraft = vm::toggleDraftPlayback,
                    onSeekDraft = vm::seekDraft,
                    focus = composerFocus,
                    aux = composerAux,
                    charLimit = mojoChars,
                    onSeeMojo = { nav.navigate(com.meldiq.android.ui.Routes.MOJO) },
                )
            }
        }
    }

    actionFor?.let { m ->
        // Where the user can't post, the server refuses reactions, pins, edits and deletes too.
        val interactive = conv?.canPost != false
        GlassSheet({ actionFor = null }) {
            if (interactive) Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                QUICK_REACTIONS.forEach { e ->
                    val reactLabel = stringResource(R.string.b5_react, e)
                    Box(
                        Modifier.size(46.dp).clip(CircleShape).background(c.surfaceVariant).pressable({ vm.react(m, e); actionFor = null })
                            .semantics { contentDescription = reactLabel },
                        contentAlignment = Alignment.Center,
                    ) { Text(e, fontSize = 22.sp) }
                }
                val more = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.react_more)
                Box(
                    Modifier.size(46.dp).clip(CircleShape).background(c.surfaceVariant).pressable({ reactFor = m; actionFor = null }, onClickLabel = more)
                        .semantics { contentDescription = more },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.AddReaction, null, tint = c.textSecondary, modifier = Modifier.size(22.dp)) }
            }
            if (!m.deleted && m.kind == "text") {
                if (interactive) MenuRow(Icons.AutoMirrored.Rounded.Reply, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_reply), onClick = { vm.replyTo.value = m; vm.editing.value = null; actionFor = null; focusComposer() }, trailing = null)
                if (interactive && threadRoot == null) MenuRow(Icons.Outlined.Forum, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_reply_thread), onClick = { actionFor = null; nav.navigate(Routes.conversation(conversationId, m.id)) }, trailing = null)
                if (m.text.isNotEmpty() && vm.c.messages.rich(m)?.structured != true) {
                    if (translations[m.id] != null) MenuRow(Icons.Outlined.Translate, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_show_original), onClick = { vm.showOriginal(m); actionFor = null }, trailing = null)
                    else MenuRow(Icons.Outlined.Translate, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_translate), onClick = { translateFor = m; actionFor = null }, trailing = null)
                }
                if (m.text.isNotEmpty()) MenuRow(Icons.Outlined.ContentCopy, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_copy), onClick = {
                    scope.launch { clipboard.setClipEntry(ClipData.newPlainText("message", m.text).toClipEntry()) }
                    actionFor = null
                }, trailing = null)
                // Batch B5: a link that opens this message for people in this conversation.
                if (com.meldiq.android.data.model.MessageLinks.canLink(m.deleted, m.status)) MenuRow(Icons.Outlined.Link, stringResource(R.string.b5_copy_link), onClick = {
                    scope.launch { clipboard.setClipEntry(ClipData.newPlainText("link", com.meldiq.android.data.model.MessageLinks.link(conversationId, m.id)).toClipEntry()) }
                    actionFor = null
                    Toast.makeText(ctx, ctx.getString(R.string.b5_link_copied), Toast.LENGTH_SHORT).show()
                }, trailing = null)
                if (interactive && m.outgoing && m.status != MessageStatus.FAILED && m.status != MessageStatus.SENDING) MenuRow(Icons.Outlined.Edit, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_edit), onClick = {
                    vm.editing.value = m; vm.replyTo.value = null; setText(m.text); actionFor = null
                }, trailing = null)
                if (interactive) MenuRow(Icons.Outlined.PushPin, stringResource(if (m.pinned) R.string.b5_unpin else R.string.b5_pin_everyone), tint = c.peach, tintBg = c.peachSoft, onClick = { vm.pin(m); actionFor = null }, trailing = null)
                if (!m.outgoing && threadRoot == null) MenuRow(Icons.Outlined.MarkChatUnread, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_mark_unread), onClick = {
                    actionFor = null
                    vm.markUnreadFrom(m, messages)
                    Toast.makeText(ctx, ctx.getString(com.meldiq.android.R.string.nv_marked_unread), Toast.LENGTH_SHORT).show()
                    nav.popBackStack()
                }, trailing = null)
                if (vm.c.messages.attachments(m).isNotEmpty()) MenuRow(Icons.Outlined.CheckCircle, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.bulk_menu_select), onClick = { selected = setOf(m.id); actionFor = null }, trailing = null)
                val pollOpen = vm.c.messages.rich(m)?.let { it.poll != null && !com.meldiq.android.data.model.PollRules.closed(it, System.currentTimeMillis()) } == true
                if (interactive && m.outgoing && pollOpen) MenuRow(Icons.Outlined.Lock, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.poll_close), onClick = { vm.closePoll(m); actionFor = null }, trailing = null)
            }
            // Saved for later (Home › Later), with an optional reminder: personal, synced to the person's other devices.
            if (savingSupported && !m.deleted && m.kind == "text" && m.status != MessageStatus.SENDING && m.status != MessageStatus.FAILED) {
                if (m.id in savedIds) MenuRow(Icons.Outlined.BookmarkRemove, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.later_remove), onClick = { vm.removeSaved(m); actionFor = null }, trailing = null)
                else MenuRow(Icons.Outlined.BookmarkAdd, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.later_save), onClick = {
                    vm.saveForLater(m)
                    actionFor = null
                    Toast.makeText(ctx, ctx.getString(com.meldiq.android.R.string.later_saved_toast), Toast.LENGTH_SHORT).show()
                }, trailing = null)
                MenuRow(Icons.Outlined.Alarm, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.later_remind), onClick = { remindFor = m; actionFor = null }, trailing = null)
            }
            // Saving and sharing are explicit actions; tapping a photo only opens the viewer.
            val file = if (!m.deleted) vm.c.messages.attachments(m).firstOrNull { it.id != "pending" && !VoiceNote.isVoice(it) } else null
            if (file != null) {
                if (MediaGallery.kindOf(file) != null) MenuRow(Icons.Outlined.Download, stringResource(R.string.b5_save_gallery), onClick = { actionFor = null; onMedia(MediaAction.SaveToGallery, file) }, trailing = null)
                MenuRow(Icons.Outlined.FolderOpen, stringResource(R.string.b5_save_files), onClick = { actionFor = null; onMedia(MediaAction.SaveToFiles, file) }, trailing = null)
                MenuRow(Icons.Outlined.Share, stringResource(R.string.b5_share), onClick = { actionFor = null; onMedia(MediaAction.Share, file) }, trailing = null)
            }
            if (!m.deleted && m.kind == "text" && m.status != MessageStatus.SENDING && vm.c.messages.attachments(m).none { it.id == "pending" }) {
                MenuRow(Icons.AutoMirrored.Outlined.Forward, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_forward), onClick = { forwardFor = m; actionFor = null }, trailing = null)
                if (reportsAvailable && !m.outgoing && !m.deleted) MenuRow(
                    Icons.Outlined.Flag, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.rp_menu), tint = c.danger, tintBg = c.dangerSoft,
                    onClick = { reportFor = m; actionFor = null }, trailing = null,
                )
            }
            if (m.outgoing && (m.status == MessageStatus.SENDING || m.status == MessageStatus.FAILED) && vm.c.messages.attachments(m).any { it.id == "pending" }) {
                MenuRow(Icons.Outlined.Close, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_cancel_upload), subtitle = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_cancel_upload_sub), tint = c.danger, tintBg = c.dangerSoft, onClick = { vm.cancelUpload(m); actionFor = null }, trailing = null)
            }
            if (m.status == MessageStatus.FAILED) MenuRow(Icons.Outlined.Refresh, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_retry), onClick = { vm.retry(m); actionFor = null }, trailing = null)
            if (m.outgoing) MenuRow(Icons.Outlined.Info, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_info), tint = c.lavender, tintBg = c.lavenderSoft, onClick = { infoFor = m; actionFor = null }, trailing = null)
            if (interactive && m.outgoing && !m.deleted) MenuRow(Icons.Outlined.DeleteOutline, androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.menu_delete), tint = c.danger, tintBg = c.dangerSoft, onClick = { vm.delete(m); actionFor = null }, trailing = null)
        }
    }
    viewerFor?.let { id ->
        val media = remember(messages, root) { MediaGallery.items(messages + listOfNotNull(root)) { vm.c.messages.attachments(it) } }
        MediaViewer(
            items = media, startAttachmentId = id,
            senderName = { item -> if (item.outgoing) youLabel else users[item.senderUserId]?.displayName ?: someoneLabel },
            load = vm::mediaFile,
            progress = { transfers[it] },
            canPlayVideo = vm::videoBlocked,
            onPlay = vm::pauseVoice,
            onAction = { action, item -> onMedia(action, item.ref) },
            onDismiss = { viewerFor = null },
            // 2026-10-23: the message's text under the picture, and reacting without leaving the viewer.
            captionOf = { item -> messages.firstOrNull { it.id == item.messageId }?.text?.trim()?.ifEmpty { null } },
            onReact = if (conv?.canPost != false) ({ item, emoji -> messages.firstOrNull { it.id == item.messageId }?.let { vm.react(it, emoji) } }) else null,
        )
    }
    infoFor?.let { m ->
        GlassSheet({ infoFor = null }, title = stringResource(R.string.menu_info)) {
            val delivered = vm.c.messages.deliveredTo(m).mapNotNull { users[it]?.displayName }
            val read = vm.c.messages.readBy(m).mapNotNull { users[it]?.displayName }
            InfoLine(
                stringResource(R.string.b5_info_status),
                when (m.status) {
                    MessageStatus.SENDING -> stringResource(R.string.b5_status_sending)
                    MessageStatus.SENT -> stringResource(R.string.b5_status_sent)
                    MessageStatus.DELIVERED -> stringResource(R.string.b5_status_delivered)
                    MessageStatus.READ -> stringResource(R.string.b5_status_read)
                    MessageStatus.FAILED -> stringResource(R.string.b5_status_failed)
                    else -> stringResource(R.string.b5_status_received)
                },
            )
            InfoLine(stringResource(R.string.b5_info_sent), TimeFmt.clock(m.sentAt) + " · " + TimeFmt.dayHeader(m.sentAt))
            m.serverTs?.let { InfoLine(stringResource(R.string.b5_info_relay), TimeFmt.clock(it)) }
            InfoLine(stringResource(R.string.b5_info_delivered), delivered.joinToString().ifEmpty { if (conv?.type == "CHANNEL") stringResource(R.string.b5_info_no_receipts) else stringResource(R.string.b5_not_yet) })
            InfoLine(stringResource(R.string.b5_info_read), read.joinToString().ifEmpty { stringResource(R.string.b5_not_yet) })
            InfoLine(stringResource(R.string.b5_info_encryption), stringResource(R.string.b5_info_signed))
        }
    }
    if (attachSheet) {
        AttachPanel(maxFile, onAction = { action ->
            attachSheet = false
            when (action) {
                AttachAction.Gallery -> mediaPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                AttachAction.Camera -> openCamera(false)
                AttachAction.RecordVideo -> openCamera(true)
                AttachAction.Files -> picker.launch("*/*")
                AttachAction.Contact -> profileSheet = true
                AttachAction.Location -> shareLocation()
                AttachAction.Poll -> pollSheet = true
            }
        }, onDismiss = { attachSheet = false })
    } else if (batch.isNotEmpty()) {
        BatchComposer(
            batch, batchNote, onRemove = vm::unpick, onAddMore = { attachSheet = true },
            onSend = { q, vq, caption -> vm.sendBatch(q, vq, caption) }, onDismiss = vm::clearBatch,
            maxFile = maxFile,
            defaultPhotoQuality = com.meldiq.android.ui.LocalContainer.current.settings.current.photoQuality,
            defaultVideoQuality = com.meldiq.android.ui.LocalContainer.current.settings.current.videoQuality,
        )
    }
    if (bulkSheet) {
        val picked = bulkPicked()
        BulkSaveSheet(
            plan = BulkSave.plan(picked, bulkExcluded),
            candidates = (BulkSave.plan(picked) as? BulkSave.Plan.Ready)?.items.orEmpty(),
            excluded = bulkExcluded,
            onToggle = { k -> bulkExcluded = if (k in bulkExcluded) bulkExcluded - k else bulkExcluded + k },
            batch = bulkBatch,
            onSaveToFolder = { runCatching { pickFolder.launch(null) }.onFailure { vm.error.value = ctx.getString(com.meldiq.android.R.string.bulk_no_picker) } },
            onSaveToGallery = { (BulkSave.plan(picked, bulkExcluded) as? BulkSave.Plan.Ready)?.let { vm.bulk.start(it.items, BulkSaver.Target.Gallery) } },
            onCancel = vm.bulk::cancel,
            onRetry = vm.bulk::retry,
            onDone = { endSelection() },
            onClose = { bulkSheet = false },
        )
    }
    if (profileSheet) {
        val people by vm.c.db.users().observeAll().collectAsStateWithLifecycle(emptyList())
        ProfileShareSheet(
            people, people.firstOrNull { it.id == me },
            onSend = { vm.sendRich(com.meldiq.android.data.model.RichContent(contact = it)); profileSheet = false },
            onDismiss = { profileSheet = false },
        )
    }
    if (locationSheet) {
        LocationShareSheet(
            location, locating, locationProblem, onRetry = ::locate,
            onSend = { vm.sendRich(com.meldiq.android.data.model.RichContent(location = it)); locationSheet = false; location = null },
            onDismiss = { locationSheet = false; location = null },
        )
    }
    if (emojiSheet) {
        EmojiPickerSheet(
            chatSettings.animatedEmoji,
            onInsert = { e -> val t = field.text; val sel = field.selection.start.coerceIn(0, t.length); field = TextFieldValue(t.substring(0, sel) + e + t.substring(sel), TextRange(sel + e.length)) },
            onSendAnimated = { e -> vm.sendRich(com.meldiq.android.data.model.RichContent(animoji = e)); emojiSheet = false },
            onDismiss = { emojiSheet = false },
            stickers = stickerPrefs,
            onSendSticker = { s -> vm.sendSticker(s); emojiSheet = false },
            emoji = emojiPrefs,
            community = communityExpressions,
            onSendCommunitySticker = { e ->
                vm.c.expressions.ref(e).let { ref -> vm.sendTextRich(":${e.name}:", com.meldiq.android.data.model.RichContent(customSticker = ref)) }
                emojiSheet = false
            },
        )
    }
    reactFor?.let { m ->
        GlassSheet({ reactFor = null }, title = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.react_title)) {
            // Batch B12: the community's own emoji first, then every emoji.
            val own = communityExpressions.filter { it.kind == "emoji" }
            if (own.isNotEmpty()) {
                Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.b9_community_tab), style = Griip.type.label, color = c.textSecondary)
                androidx.compose.foundation.layout.FlowRow(
                    Modifier.padding(top = 6.dp, bottom = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    own.forEach { e ->
                        Box(Modifier.size(46.dp).clip(Shapes.tile).background(c.surfaceVariant).pressable({ vm.react(m, ":${e.name}:"); reactFor = null }, onClickLabel = ":${e.name}:"), contentAlignment = Alignment.Center) {
                            com.meldiq.android.ui.components.CustomEmojiImage(vm.c.expressions.ref(e), 28.dp)
                        }
                    }
                }
            }
            EmojiPanel(emojiPrefs, onPick = { e -> vm.react(m, e); reactFor = null }, modifier = Modifier.fillMaxWidth().height(if (own.isNotEmpty()) 360.dp else 440.dp))
        }
    }
    reactorsFor?.let { (mid, emoji) ->
        val target = messages.firstOrNull { it.id == mid }
        if (target == null) reactorsFor = null
        else ReactorsSheet(vm.c.messages.reactions(target), emoji, me, users, onDismiss = { reactorsFor = null }, onOpenProfile = { id -> reactorsFor = null; nav.navigate(Routes.user(id)) })
    }
    if (newPostSheet) NewPostSheet(onDismiss = { newPostSheet = false }, forumTags = conv?.let { vm.c.conversations.forumTags(it) }.orEmpty(), guidelines = forumGuidelines[conversationId], onPost = { t, b, tags -> vm.sendForumPost(t, b, tags) })
    if (pollSheet) PollComposerSheet(onSend = { poll -> vm.sendRich(com.meldiq.android.data.model.RichContent(poll = poll)); pollSheet = false }, onDismiss = { pollSheet = false }, emojiPrefs = emojiPrefs)
    remindFor?.let { m ->
        com.meldiq.android.ui.screens.home.RemindSheet(
            current = saved.firstOrNull { it.messageId == m.id }?.remindAt,
            onPick = { at -> vm.remind(m, at); remindFor = null },
            onDismiss = { remindFor = null },
        )
    }
    reportFor?.let { m ->
        val line = { e: MessageEntity -> com.meldiq.android.data.model.ReportRules.Line(e.id, e.senderUserId, e.text, e.sentAt, vm.c.messages.attachments(e)) }
        com.meldiq.android.ui.screens.moderation.ReportSheet(
            com.meldiq.android.ui.screens.moderation.ReportTarget(
                userId = m.senderUserId, name = users[m.senderUserId]?.displayName ?: "",
                conversationId = m.conversationId, conversationType = conv?.type, messageId = m.id, orgId = conv?.orgId,
                content = com.meldiq.android.data.model.ReportRules.content(line(m), messages.map(line)),
            ),
            onDismiss = { reportFor = null },
        )
    }
    playing?.let { (messageId, videoId) ->
        val pm = messages.firstOrNull { it.id == messageId }
        com.meldiq.android.ui.media.YouTubePlayerDialog(
            videoId, sender = pm?.let { if (it.outgoing) youLabel else users[it.senderUserId]?.displayName }, sentAt = pm?.sortTs,
            caption = pm?.text?.trim()?.ifEmpty { null },
            onReact = if (pm != null && conv?.canPost != false) ({ e -> vm.react(pm, e) }) else null,
            onOpenOutside = { url -> playing = null; onOpenLink(url) },
            onDismiss = { playing = null },
        )
    }
    forwardFor?.let { m ->
        val all by vm.c.conversations.observeAll().collectAsStateWithLifecycle(emptyList())
        val files = vm.c.messages.attachments(m)
        val preview = m.text.trim().replace('\n', ' ').ifEmpty { "📎 " + files.joinToString(", ") { it.name } }
        ForwardSheet(
            all.filter { it.id != m.conversationId }, me, preview,
            filesNote = if (files.isNotEmpty()) stringResource(R.string.b5_forward_files) else null,
            onSend = { dests, note ->
                forwardFor = null
                vm.forwardMany(m, dests.map { it.id }, note) { n ->
                    vm.notice.value = if (dests.size == 1 && n == 1) ctx.getString(R.string.b5_forwarded_to, com.meldiq.android.data.repo.ConversationRepository.title(dests.first(), me))
                        else ctx.getString(R.string.ux_forwarded_n, n)
                }
            },
            onCopyLink = if (com.meldiq.android.data.model.MessageLinks.canLink(m.deleted, m.status)) ({
                scope.launch { clipboard.setClipEntry(ClipData.newPlainText("link", com.meldiq.android.data.model.MessageLinks.link(conversationId, m.id)).toClipEntry()) }
                vm.notice.value = ctx.getString(R.string.nv_copied)
            }) else null,
            onDismiss = { forwardFor = null },
        )
    }
    linkToOpen?.let { url ->
        com.meldiq.android.ui.LinkOpenSheet(
            url,
            onOpen = { inApp -> linkToOpen = null; if (!com.meldiq.android.ui.LinkOpener.open(ctx, url, inApp)) vm.error.value = ctx.getString(R.string.b5_no_app_link) },
            onCopy = { scope.launch { clipboard.setClipEntry(ClipData.newPlainText("link", url).toClipEntry()) }; linkToOpen = null },
            onDismiss = { linkToOpen = null },
        )
    }
    translateFor?.let { m ->
        GlassSheet({ translateFor = null }, title = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.translate_title)) {
            if (!vm.c.translator.consented) {
                Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.translate_consent), style = Griip.type.bodySmall, color = c.textSecondary)
                Spacer(Modifier.height(10.dp))
            }
            Text(androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.translate_into), style = Griip.type.label, color = c.textSecondary)
            vm.c.translator.targets.forEach { t ->
                MenuRow(
                    Icons.Outlined.Translate, com.meldiq.android.ui.AppLanguage.nativeName(if (t == "zh") "zh-CN" else t),
                    trailing = { if (t == vm.c.translator.lastTarget) Icon(Icons.Rounded.Check, null, tint = c.primary) },
                    onClick = { vm.c.translator.consent(); vm.translate(m, t); translateFor = null },
                )
            }
            Spacer(Modifier.height(12.dp))
        }
    }
    riskyOpen?.let { (ref, why) ->
        GlassSheet({ vm.riskyOpen.value = null }, title = stringResource(R.string.b5_open_file_q, ref.name)) {
            Text(why, style = Griip.type.body, color = Griip.colors.textPrimary)
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.b5_file_warning),
                style = Griip.type.bodySmall, color = Griip.colors.textSecondary,
            )
            Spacer(Modifier.height(16.dp))
            com.meldiq.android.ui.components.PillButton(stringResource(R.string.b5_cancel), { vm.riskyOpen.value = null }, Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            com.meldiq.android.ui.components.PillButton(
                stringResource(R.string.b5_open_anyway), { vm.riskyOpen.value = null; vm.openAttachment(ctx, ref, confirmed = true) }, Modifier.fillMaxWidth(),
                tone = com.meldiq.android.ui.components.ButtonTone.Danger,
            )
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, style = Griip.type.label, color = c.textTertiary, modifier = Modifier.width(130.dp))
        Text(value, style = Griip.type.bodySmall, color = c.textPrimary, modifier = Modifier.weight(1f))
    }
}

/** The "New messages" line above the oldest message that was unread when the conversation opened. */
@Composable
private fun NewMessagesDivider() {
    val c = Griip.colors
    val label = androidx.compose.ui.res.stringResource(com.meldiq.android.R.string.nv_new_messages)
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).semantics { contentDescription = label }, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(1.dp).background(c.badge))
        Text(
            label.uppercase(), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.onBadge,
            modifier = Modifier.padding(start = 8.dp).clip(Shapes.small).background(c.badge).padding(horizontal = 6.dp, vertical = 1.dp),
        )
    }
}

@Composable
private fun DayDivider(t: Long) {
    val c = Griip.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.Center) {
        Text(
            TimeFmt.dayHeader(t), style = Griip.type.caption, color = c.textSecondary,
            modifier = Modifier.clip(Shapes.pill).background(c.surface).border(1.dp, c.border, Shapes.pill).padding(horizontal = 12.dp, vertical = 4.dp).semantics { heading() },
        )
    }
}

/**
 * Who's typing, Meldiq's way (as Meldiq Web): Meldling and "Meldling…" with an ellipsis that fades, once however many
 * people type. Nothing moves, so the list never shifts; still under reduced motion. Screen readers get the real names.
 */
@Composable
private fun TypingRow(names: List<String>) {
    val c = Griip.colors
    val still = com.meldiq.android.ui.theme.rememberReducedMotion()
    val t = rememberInfiniteTransition(label = "typing")
    val phase by t.animateFloat(0f, 3f, infiniteRepeatable(tween(TYPING_CYCLE_MS, easing = androidx.compose.animation.core.LinearEasing)), label = "ellipsis")
    val who = typingNames(names)
    Row(
        Modifier.padding(start = 20.dp, bottom = 4.dp).semantics(mergeDescendants = true) { contentDescription = who; liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        com.meldiq.android.ui.components.MeldlingGlyph(18.dp, c.primary)
        Spacer(Modifier.width(6.dp))
        Text(stringResource(R.string.wp_typing_meldling), style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.textSecondary, modifier = Modifier.clearAndSetSemantics {})
        repeat(3) { i ->
            // Each dot fades in turn; with reduced motion all three stay.
            val alpha = if (still) 1f else (1f - kotlin.math.abs(phase - i - 0.5f)).coerceIn(0.25f, 1f)
            Text(".", style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.textSecondary.copy(alpha = alpha), modifier = Modifier.clearAndSetSemantics {})
        }
    }
}

/** One full fade of the three dots. */
private const val TYPING_CYCLE_MS = 1200

/** "Ana is typing", "Ana and Bo are typing", "Ana, Bo and 3 others are typing" (as Meldiq Web's typingNames). */
@Composable
private fun typingNames(names: List<String>): String = when (names.size) {
    0 -> ""
    1 -> stringResource(R.string.wp_typing_one, names[0])
    2 -> stringResource(R.string.wp_typing_two, names[0], names[1])
    else -> stringResource(R.string.wp_typing_many, names[0], names[1], names.size - 2)
}

/** Past this many characters the composer's corners tighten, as it is about to wrap onto a second line. */
private const val COMPOSER_PILL_CHARS = 40

@Composable
private fun Composer(
    text: TextFieldValue,
    onText: (TextFieldValue) -> Unit,
    replyLabel: Pair<String, String>?,
    onCancelContext: () -> Unit,
    onAttach: () -> Unit,
    onEmoji: () -> Unit,
    onSend: () -> Unit,
    placeholder: String,
    voice: VoiceComposerState,
    onMic: () -> Unit,
    onStopRecording: () -> Unit,
    onCancelVoice: () -> Unit,
    onSendVoice: () -> Unit,
    onToggleDraft: () -> Unit,
    onSeekDraft: (Long) -> Unit,
    focus: FocusRequester? = null,
    aux: MutableState<ComposerAux.State> = remember { mutableStateOf(ComposerAux.State()) },
    /** Meldiq Mojo: the plan's characters per message (0: unknown, the server alone decides). */
    charLimit: Int = 0,
    onSeeMojo: (() -> Unit)? = null,
) {
    val c = Griip.colors
    // Round 7: typing hides attach and emoji; 2 s without typing brings them back. Keyed on the generation, so newer
    // typing or an outside touch cancels a running timer instead of letting it fire late ([ComposerAux]).
    val auxState = aux.value
    LaunchedEffect(auxState.generation) {
        if (auxState.hidden) {
            kotlinx.coroutines.delay(ComposerAux.IDLE_MS)
            aux.value = ComposerAux.onIdle(aux.value, auxState.generation)
        }
    }
    // Emptied from elsewhere (sent, edit cancelled): show them at once.
    if (text.text.isEmpty() && auxState.hidden) SideEffect { aux.value = ComposerAux.onOutside(aux.value) }
    val showAux = !auxState.hidden
    // The field grows line by line (up to six, then scrolls inside); the growth is animated unless animations are off.
    val reduced = com.meldiq.android.ui.theme.rememberReducedMotion()
    val grow = if (reduced) androidx.compose.animation.core.snap() else com.meldiq.android.ui.theme.Motion.quick<androidx.compose.ui.unit.IntSize>()
    val multiline = text.text.contains('\n') || text.text.length > COMPOSER_PILL_CHARS
    val fieldShape = RoundedCornerShape(if (multiline) 18.dp else 24.dp)
    when (val d = voice.draft) {
        is VoiceDraftController.Draft.Recording -> {
            VoiceRecordingBar(d.startedAt, onCancelVoice, onStopRecording)
            return
        }
        is VoiceDraftController.Draft.Ready -> {
            VoicePreviewBar(d, voice.playback, onCancelVoice, onToggleDraft, onSeekDraft, onSendVoice)
            return
        }
        VoiceDraftController.Draft.Idle -> Unit
    }
    Column(Modifier.fillMaxWidth().background(c.surface)) {
        HorizontalDivider(thickness = 1.dp, color = c.border)
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 8.dp)) {
            replyLabel?.let { (label, preview) ->
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 6.dp).height(IntrinsicSize.Min).clip(Shapes.small).background(c.surfaceVariant),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(c.primary))
                    Column(Modifier.weight(1f).padding(start = 10.dp, top = 6.dp, bottom = 6.dp)) {
                        Text(label, style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primaryDeep)
                        Text(preview, style = Griip.type.caption, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    CircleIconButton(Icons.Rounded.Close, stringResource(R.string.b5_cancel), onCancelContext, size = 36.dp, tint = c.textSecondary)
                }
            }
            val counter = remember(text.text, charLimit) { com.meldiq.android.data.billing.MojoPlans.counter(text.text, charLimit) }
            CharCounter(counter, charLimit, onSeeMojo)
            Row(verticalAlignment = Alignment.Bottom) {
                AnimatedVisibility(
                    showAux,
                    enter = if (reduced) EnterTransition.None else expandHorizontally(expandFrom = Alignment.Start) + fadeIn(),
                    exit = if (reduced) ExitTransition.None else shrinkHorizontally(shrinkTowards = Alignment.Start) + fadeOut(),
                ) {
                    // Batch B14: one "+" for photos, files, camera, contacts, location and the rest (the attach sheet).
                    ComposerIcon(Icons.Rounded.Add, stringResource(R.string.b5_attach), onAttach)
                }
                if (!showAux) Spacer(Modifier.width(4.dp))
                Row(
                    Modifier.weight(1f).heightIn(min = 48.dp).animateContentSize(grow).clip(fieldShape)
                        .background(c.surfaceVariant).border(1.dp, c.border, fieldShape)
                        .padding(start = 16.dp, end = 4.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                Box(Modifier.weight(1f).padding(vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.text.isEmpty()) Text(placeholder, style = Griip.type.body, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    BasicTextField(
                        value = text,
                        onValueChange = { new -> aux.value = ComposerAux.onTextChanged(aux.value, text.text, new.text); onText(new) },
                        textStyle = Griip.type.body.copy(color = c.textPrimary), cursorBrush = SolidColor(c.primary), maxLines = 6,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.fillMaxWidth().then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
                            .onFocusChanged { if (!it.isFocused) aux.value = ComposerAux.onOutside(aux.value) }
                            .semantics { contentDescription = placeholder },
                    )
                }
                // Batch B14: emoji, stickers and GIF-like animated emoji live inside the field, as in most messengers.
                val emojiLabel = stringResource(R.string.b5_emoji)
                Box(
                    Modifier.size(40.dp).padding(bottom = 4.dp).clip(CircleShape).pressable(onEmoji, onClickLabel = emojiLabel).semantics { contentDescription = emojiLabel },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.EmojiEmotions, null, tint = c.textSecondary, modifier = Modifier.size(22.dp)) }
                }
                Spacer(Modifier.width(6.dp))
                // Over the plan's limit: nothing is cut; Send waits until the message fits (the server checks again).
                val enabled = text.text.isNotBlank() && counter !is com.meldiq.android.data.billing.MojoPlans.Counter.Over
                val recordLabel = stringResource(R.string.b5_record_voice)
                val sendLabel = stringResource(R.string.b5_send_message)
                val sendClick = stringResource(R.string.b5_send)
                // Batch B16: the mic and Send trade places with a quick crossfade as you start or clear typing.
                androidx.compose.animation.Crossfade(
                    !enabled && voice.available, animationSpec = if (reduced) androidx.compose.animation.core.snap() else androidx.compose.animation.core.tween(com.meldiq.android.ui.theme.Motion.QUICK),
                    label = "micOrSend",
                ) { mic ->
                    if (mic) Box(
                        Modifier.size(48.dp).clip(CircleShape).background(c.actionStart)
                            .pressable(onMic, onClickLabel = recordLabel)
                            .semantics { contentDescription = recordLabel },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Rounded.Mic, null, tint = c.onAction, modifier = Modifier.size(24.dp)) }
                    else Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .background(if (enabled) c.actionStart else c.surfaceVariant)
                            .pressable(if (enabled) onSend else null, onClickLabel = sendClick)
                            .semantics { contentDescription = sendLabel },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.AutoMirrored.Rounded.Send, null, tint = if (enabled) c.onAction else c.textTertiary, modifier = Modifier.size(22.dp)) }
                }
            }
        }
    }
}

/** How many characters are left near the plan's limit, and by how much a draft is over it (docs/MOJO_ANDROID.md). */
@Composable
private fun CharCounter(counter: com.meldiq.android.data.billing.MojoPlans.Counter, limit: Int, onSeeMojo: (() -> Unit)?) {
    val c = Griip.colors
    when (counter) {
        com.meldiq.android.data.billing.MojoPlans.Counter.Hidden -> Unit
        is com.meldiq.android.data.billing.MojoPlans.Counter.Near -> Text(
            stringResource(R.string.mojo_composer_left, counter.left), style = Griip.type.caption, color = c.textTertiary,
            textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.fillMaxWidth().padding(end = 12.dp, bottom = 4.dp),
        )
        is com.meldiq.android.data.billing.MojoPlans.Counter.Over -> Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.mojo_composer_over, counter.by, "%,d".format(limit)), style = Griip.type.caption, color = c.danger,
                modifier = Modifier.weight(1f).semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
            )
            if (onSeeMojo != null) androidx.compose.material3.TextButton(onSeeMojo) {
                Text(stringResource(R.string.mojo_composer_upgrade), style = Griip.type.caption.copy(fontWeight = FontWeight.Bold), color = c.primary)
            }
        }
    }
}

@Composable
private fun ComposerIcon(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = Griip.colors
    Box(Modifier.size(48.dp).clip(CircleShape).pressable(onClick, onClickLabel = label).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c.textSecondary, modifier = Modifier.size(24.dp))
    }
}

/**
 * Calls [onTouch] when a finger goes down anywhere in this area, without taking the touch from what's underneath (it
 * listens in the initial pass and consumes nothing): messages, menus and scrolling behave as before.
 */
private fun Modifier.observeTouches(onTouch: () -> Unit): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        onTouch()
    }
}


/** Batch B6: under a message request you received: who it's from, and Accept, Decline or Block. */
@Composable
private fun MessageRequestBar(peerName: String, onAnswer: (String) -> Unit) {
    val c = Griip.colors
    var confirmBlock by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(c.surface).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(stringResource(R.string.b6_request_from, peerName), style = Griip.type.bodyMedium, color = c.textPrimary)
        Text(stringResource(R.string.b6_request_explain), style = Griip.type.caption, color = c.textSecondary, modifier = Modifier.padding(top = 2.dp))
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            com.meldiq.android.ui.components.PillButton(stringResource(R.string.b6_accept), { onAnswer("accept") }, Modifier.weight(1f), height = 44.dp, showKnob = false)
            com.meldiq.android.ui.components.PillButton(stringResource(R.string.b6_decline), { onAnswer("decline") }, Modifier.weight(1f), tone = com.meldiq.android.ui.components.ButtonTone.Glass, height = 44.dp, showKnob = false)
            com.meldiq.android.ui.components.PillButton(stringResource(R.string.b6_block), { confirmBlock = true }, Modifier.weight(1f), tone = com.meldiq.android.ui.components.ButtonTone.Danger, height = 44.dp, showKnob = false)
        }
    }
    if (confirmBlock) com.meldiq.android.ui.components.ConfirmDialog(
        stringResource(R.string.b6_block_q, peerName), stringResource(R.string.b6_block_body), stringResource(R.string.b6_block),
        onConfirm = { confirmBlock = false; onAnswer("block") }, onDismiss = { confirmBlock = false }, destructive = true,
    )
}
