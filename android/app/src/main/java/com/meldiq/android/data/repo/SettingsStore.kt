package com.meldiq.android.data.repo

import com.meldiq.android.data.model.AttachmentPolicy
import android.content.Context
import com.meldiq.android.BuildConfig
import com.meldiq.android.ui.theme.MeldiqPalettes
import com.meldiq.android.ui.theme.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class Settings(
    val serverUrl: String,
    val theme: ThemeMode,
    val notifications: Boolean,
    val backgroundConnection: Boolean,
    /**
     * Wake-ups through a UnifiedPush distributor such as ntfy (docs/BACKGROUND_DELIVERY.md). Off by default: it needs the
     * distributor app and a server that offers it. "Stay connected" stays available beside it as the fallback.
     */
    val pushWakeups: Boolean = false,
    val readReceipts: Boolean,
    val typingIndicators: Boolean,
    val mediaE2ee: Boolean,
    /**
     * Calls: use the phone maker's built-in echo canceller instead of WebRTC's own (AEC3). Off by default: LiveKit
     * otherwise switches WebRTC's canceller off on Android 10+ and relies on the hardware one, whose quality varies
     * by phone (physical-device report 2026-10-16: the other person heard their own voice).
     */
    val hardwareEchoCanceller: Boolean = false,
    /** Batch B10: calls reduce background noise (on); off keeps music and quiet sounds as they are. */
    val noiseReduction: Boolean = true,
    /** Batch B11: the last screen-share choice ("TEXT" or "GAME") and whether app sound went with it. */
    val shareMode: String = "TEXT",
    val shareAppSound: Boolean = false,
    /**
     * The user panel's microphone and headphones outside a call (as Meldiq Web, 2026-10-28): the next call starts with the
     * microphone off, or deafened (hearing nobody, microphone off). In a call they mute and deafen that call instead.
     */
    val joinMuted: Boolean = false,
    val joinDeafened: Boolean = false,
    // Chats (2026-10-17, docs/SETTINGS.md).
    /** Animated emoji move in chats (still when off, or when the system's animations are off). */
    val animatedEmoji: Boolean = true,
    /** Where tapped web links open. */
    val linkOpening: LinkOpening = LinkOpening.IN_APP,
    /** Fetch a title and description for links, on this phone. Off by default: fetching tells the site your IP address. */
    val linkPreviews: Boolean = false,
    /** Music and video links (YouTube, Spotify, …) as cards that open the official app; recognised from the address, nothing fetched. */
    val mediaCards: Boolean = true,
    /** Message text size: 0.9 to 1.3. */
    val textScale: Float = 1f,
    val wallpaper: String = "none",
    /** The colour preset (MeldiqPalettes: graphite, aurora, sunset or meadow). */
    val palette: String = MeldiqPalettes.DEFAULT,
    /** How conversations are drawn: a left-aligned stream with names and avatars (default), or bubbles. */
    val messageLayout: MessageLayout = MessageLayout.STREAM,
    /** Colour theme ([com.meldiq.android.data.model.Vibes], as Meldiq Web): a preset id, "custom", or null for none; its strength. */
    val vibe: String? = null,
    val vibeCustom: List<String> = emptyList(),
    val vibeStrength: Int = com.meldiq.android.data.model.Vibes.STRENGTH_DEFAULT,
    /** Show a community's own accent and banner while in it (as Meldiq Web); off keeps Meldiq's colours everywhere. */
    val communityColors: Boolean = true,
    /** The "Get started" checklist on Home was dismissed (or finished). */
    val setupDismissed: Boolean = false,
    /** The first-run introduction pages were seen or skipped (replayable from Settings › Introduction). */
    val introSeen: Boolean = false,
    /** Download received photos automatically: never, on Wi-Fi, or always. Files and videos are always tapped first. */
    val autoDownload: AutoDownload = AutoDownload.WIFI,
    /** The quality a photo or video send starts at (Settings › Chats); each send can still change it. */
    val photoQuality: AttachmentPolicy.Quality = AttachmentPolicy.Quality.STANDARD,
    val videoQuality: AttachmentPolicy.Quality = AttachmentPolicy.Quality.ORIGINAL,
    val previewMode: PreviewMode = PreviewMode.ALL,
    val hourFormat: HourFormat = HourFormat.AUTO,
    /** Settings › Chats › Gestures (2026-10-23): swipe a message to reply; double-tap it to react with [doubleTapEmoji]. */
    val swipeReply: Boolean = true,
    val doubleTapReact: Boolean = true,
    val doubleTapEmoji: String = "👍",
    /** Settings › Chats (2026-10-23): YouTube videos play inside Meldiq when tapped; off opens the YouTube app. */
    val inAppVideo: Boolean = true,
    // Notifications & sounds.
    val messageSound: Boolean = true,
    val groupNotifications: Boolean = true,
    val callRingtone: Boolean = true,
    val vibrate: Boolean = true,
    /** Message previews on the lock screen and in notifications ("New message" when off). */
    val notificationPreviews: Boolean = true,
    /** "system", "en", "zh-CN" or "bn" (the app's language, independent of the phone's). */
    val language: String = "system",
    /** Shows the server setup (Settings › About, tapped seven times). Hidden from ordinary use. */
    val developerMode: Boolean = false,
)

enum class LinkOpening { IN_APP, EXTERNAL, ASK }
enum class MessageLayout { STREAM, BUBBLES }
enum class AutoDownload { NEVER, WIFI, ALWAYS }
/** Settings › Appearance (2026-10-23): message text in the chat list always, only while unread, or never. */
enum class PreviewMode { ALL, UNREAD, NONE }
/** The reactions a double-tap can add (Settings › Chats › Gestures). */
val DOUBLE_TAP_EMOJI = listOf("👍", "❤️", "✅", "😂", "🔥", "🙏")
/** Settings › Appearance (2026-10-23): times in the phone's format, or always 12-hour or 24-hour. */
enum class HourFormat { AUTO, H12, H24 }

/**
 * Non-secret user preferences. Appearance and behaviour are shared by every server profile on the phone;
 * the server address is the profile's own ([serverKey]), starting at [serverDefault].
 */
class SettingsStore(
    context: Context,
    private val serverKey: String = "serverUrl",
    private val serverDefault: String = BuildConfig.DEFAULT_SERVER_URL,
) {
    private val prefs = context.getSharedPreferences("griip_settings", Context.MODE_PRIVATE).also(::migrateDesign)
    private val _state = MutableStateFlow(read())
    val state: StateFlow<Settings> = _state
    val current: Settings get() = _state.value

    private fun read() = Settings(
        serverUrl = prefs.getString(serverKey, null) ?: serverDefault,
        theme = runCatching { ThemeMode.valueOf(prefs.getString("theme", null)!!) }.getOrDefault(DEFAULT_THEME),
        notifications = prefs.getBoolean("notifications", true),
        backgroundConnection = prefs.getBoolean("backgroundConnection", true),
        pushWakeups = prefs.getBoolean("pushWakeups", false),
        readReceipts = prefs.getBoolean("readReceipts", true),
        typingIndicators = prefs.getBoolean("typingIndicators", true),
        mediaE2ee = prefs.getBoolean("mediaE2ee", true),
        hardwareEchoCanceller = prefs.getBoolean("hardwareEchoCanceller", false),
        noiseReduction = prefs.getBoolean("noiseReduction", true),
        shareMode = prefs.getString("shareMode", null) ?: "TEXT",
        shareAppSound = prefs.getBoolean("shareAppSound", false),
        joinMuted = prefs.getBoolean("joinMuted", false),
        joinDeafened = prefs.getBoolean("joinDeafened", false),
        animatedEmoji = prefs.getBoolean("animatedEmoji", true),
        linkOpening = runCatching { LinkOpening.valueOf(prefs.getString("linkOpening", null)!!) }.getOrDefault(LinkOpening.IN_APP),
        linkPreviews = prefs.getBoolean("linkPreviews", false),
        mediaCards = prefs.getBoolean("mediaCards", true),
        textScale = prefs.getFloat("textScale", 1f).coerceIn(0.9f, 1.3f),
        wallpaper = prefs.getString("wallpaper", null) ?: "none",
        palette = MeldiqPalettes.of(prefs.getString("palette", null)).id,
        messageLayout = runCatching { MessageLayout.valueOf(prefs.getString("messageLayout", null)!!) }.getOrDefault(MessageLayout.STREAM),
        vibe = prefs.getString("vibe", null),
        vibeCustom = prefs.getString("vibeCustom", null)?.split(',')?.filter { it.isNotBlank() }.orEmpty(),
        vibeStrength = com.meldiq.android.data.model.Vibes.strength(prefs.getInt("vibeStrength", com.meldiq.android.data.model.Vibes.STRENGTH_DEFAULT)),
        communityColors = prefs.getBoolean("communityColors", true),
        setupDismissed = prefs.getBoolean("setupDismissed", false),
        introSeen = prefs.getBoolean("introSeen", false),
        autoDownload = runCatching { AutoDownload.valueOf(prefs.getString("autoDownload", null)!!) }.getOrDefault(AutoDownload.WIFI),
        photoQuality = runCatching { AttachmentPolicy.Quality.valueOf(prefs.getString("photoQuality", null)!!) }.getOrDefault(AttachmentPolicy.Quality.STANDARD),
        videoQuality = runCatching { AttachmentPolicy.Quality.valueOf(prefs.getString("videoQuality", null)!!) }.getOrDefault(AttachmentPolicy.Quality.ORIGINAL),
        previewMode = runCatching { PreviewMode.valueOf(prefs.getString("previewMode", null)!!) }.getOrDefault(PreviewMode.ALL),
        hourFormat = runCatching { HourFormat.valueOf(prefs.getString("hourFormat", null)!!) }.getOrDefault(HourFormat.AUTO),
        swipeReply = prefs.getBoolean("swipeReply", true),
        doubleTapReact = prefs.getBoolean("doubleTapReact", true),
        doubleTapEmoji = prefs.getString("doubleTapEmoji", null)?.takeIf { it in DOUBLE_TAP_EMOJI } ?: "👍",
        inAppVideo = prefs.getBoolean("inAppVideo", true),
        messageSound = prefs.getBoolean("messageSound", true),
        groupNotifications = prefs.getBoolean("groupNotifications", true),
        callRingtone = prefs.getBoolean("callRingtone", true),
        vibrate = prefs.getBoolean("vibrate", true),
        notificationPreviews = prefs.getBoolean("notificationPreviews", true),
        language = prefs.getString("language", null) ?: "system",
        developerMode = prefs.getBoolean("developerMode", false),
    )

    fun update(f: (Settings) -> Settings) {
        val n = f(_state.value)
        prefs.edit()
            .putString(serverKey, n.serverUrl.trim().trimEnd('/'))
            .putString("theme", n.theme.name)
            .putBoolean("notifications", n.notifications)
            .putBoolean("backgroundConnection", n.backgroundConnection)
            .putBoolean("pushWakeups", n.pushWakeups)
            .putBoolean("readReceipts", n.readReceipts)
            .putBoolean("typingIndicators", n.typingIndicators)
            .putBoolean("mediaE2ee", n.mediaE2ee)
            .putBoolean("hardwareEchoCanceller", n.hardwareEchoCanceller)
            .putBoolean("noiseReduction", n.noiseReduction)
            .putString("shareMode", n.shareMode)
            .putBoolean("shareAppSound", n.shareAppSound)
            .putBoolean("joinMuted", n.joinMuted)
            .putBoolean("joinDeafened", n.joinDeafened)
            .putBoolean("animatedEmoji", n.animatedEmoji)
            .putString("linkOpening", n.linkOpening.name)
            .putBoolean("linkPreviews", n.linkPreviews)
            .putBoolean("mediaCards", n.mediaCards)
            .putFloat("textScale", n.textScale.coerceIn(0.9f, 1.3f))
            .putString("wallpaper", n.wallpaper)
            .putString("palette", n.palette)
            .putString("messageLayout", n.messageLayout.name)
            .putString("vibe", n.vibe)
            .putString("vibeCustom", n.vibeCustom.joinToString(","))
            .putInt("vibeStrength", com.meldiq.android.data.model.Vibes.strength(n.vibeStrength))
            .putBoolean("communityColors", n.communityColors)
            .putBoolean("setupDismissed", n.setupDismissed)
            .putBoolean("introSeen", n.introSeen)
            .putString("autoDownload", n.autoDownload.name)
            .putString("photoQuality", n.photoQuality.name)
            .putString("videoQuality", n.videoQuality.name)
            .putString("previewMode", n.previewMode.name)
            .putString("hourFormat", n.hourFormat.name)
            .putBoolean("swipeReply", n.swipeReply)
            .putBoolean("doubleTapReact", n.doubleTapReact)
            .putString("doubleTapEmoji", n.doubleTapEmoji)
            .putBoolean("inAppVideo", n.inAppVideo)
            .putBoolean("messageSound", n.messageSound)
            .putBoolean("groupNotifications", n.groupNotifications)
            .putBoolean("callRingtone", n.callRingtone)
            .putBoolean("vibrate", n.vibrate)
            .putBoolean("notificationPreviews", n.notificationPreviews)
            .putString("language", n.language)
            .putBoolean("developerMode", n.developerMode)
            .apply()
        _state.value = read()
    }

    companion object {
        /** Dark is the default look since the round-6 redesign (docs/DESIGN_SYSTEM.md). */
        val DEFAULT_THEME = ThemeMode.DARK

        /**
         * The one-time move to the round-6 look for installs that predate it: the preset becomes Graphite, and "follow
         * the system" (the old default) becomes dark. A light or dark mode someone chose is kept. Returns the new
         * (theme, palette) pair; null theme means nothing was stored.
         */
        fun migratedDesign(theme: String?): Pair<String, String> {
            val nextTheme = if (theme == null || theme == ThemeMode.SYSTEM.name) DEFAULT_THEME.name else theme
            return nextTheme to MeldiqPalettes.DEFAULT
        }

        /**
         * Version 3 (2026-10-28): the palette moves from Graphite, the previous default (every save stores it, so it
         * can't be told from a choice), to Meldiq; any other palette someone picked is kept.
         */
        fun migratedPalette(palette: String?): String =
            if (palette == null || palette == MeldiqPalettes.PREVIOUS_DEFAULT) MeldiqPalettes.DEFAULT else palette

        private fun migrateDesign(prefs: android.content.SharedPreferences) {
            val version = prefs.getInt("designVersion", 0)
            if (version >= MeldiqPalettes.DESIGN_VERSION) return
            val edit = prefs.edit().putInt("designVersion", MeldiqPalettes.DESIGN_VERSION)
            // A fresh install has nothing stored yet and simply reads the defaults.
            if (prefs.contains("theme") || prefs.contains("palette")) {
                if (version < 2) {
                    val (theme, palette) = migratedDesign(prefs.getString("theme", null))
                    edit.putString("theme", theme).putString("palette", palette)
                } else {
                    edit.putString("palette", migratedPalette(prefs.getString("palette", null)))
                }
            }
            edit.apply()
        }
    }
}
