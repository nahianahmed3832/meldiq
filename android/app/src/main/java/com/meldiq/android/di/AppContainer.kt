package com.meldiq.android.di

import android.app.Application
import com.meldiq.android.call.CallManager
import com.meldiq.android.call.CallPhase
import com.meldiq.android.crypto.EnvelopeV1
import com.meldiq.android.crypto.IdentityStore
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.ConnState
import com.meldiq.android.data.api.RealtimeClient
import com.meldiq.android.data.repo.ApiPushServer
import com.meldiq.android.data.repo.PrefsPushStore
import com.meldiq.android.data.repo.PushRegistrar
import com.meldiq.android.data.repo.WakeFetch
import com.meldiq.android.service.ConnectorDistributor
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.repo.AppState
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.data.repo.KeyDirectory
import com.meldiq.android.data.repo.MessageRepository
import com.meldiq.android.BuildConfig
import com.meldiq.android.data.repo.OrgRepository
import com.meldiq.android.data.repo.ProfileStorage
import com.meldiq.android.data.repo.SessionRepository
import com.meldiq.android.data.repo.SessionState
import com.meldiq.android.data.repo.SettingsStore
import com.meldiq.android.data.repo.UserRepository
import com.meldiq.android.notify.MessageNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Manual dependency injection (docs/DECISIONS.md D-07). One container per active server profile;
 * recreated after "erase this device" and when the person switches profiles. [profile] decides where
 * this container's keys, database and files live; the default is the original single-account layout.
 */
class AppContainer(
    val app: Application,
    val profile: ProfileStorage = ProfileStorage.of(ProfileStorage.DEFAULT),
    serverDefault: String = BuildConfig.DEFAULT_SERVER_URL,
) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = SettingsStore(app, profile.serverKey, serverDefault)
    val identity = IdentityStore(app, profile.identityPrefs, profile.keystoreAlias)
    val session = SessionRepository(identity, settings)
    // Before this phone has encryption keys (device setup), requests carry the account's access token.
    val api = ApiClient({ session.serverUrl }, { session.token ?: identity.account()?.tokens?.accessToken }, { session.reauth() }).also { session.api = it }
    /** Orbit 2.0 accounts (docs/ORBIT_2_ARCHITECTURE_2026-10-18.md): sign-in, tokens, device setup, legacy move, workspaces. */
    private val accountApi = com.meldiq.android.data.account.HttpAccountApi(api)
    /** Keys backed up under the password, unlocked on a new phone by an emailed code (docs/KEY_BACKUP.md). */
    val keyBackups = com.meldiq.android.data.account.HttpKeyBackupApi(api)
    val accounts = com.meldiq.android.data.account.AccountRepository(accountApi, identity, session, session::deviceName, keyBackups = keyBackups)
    val legacyMigration = com.meldiq.android.data.account.LegacyMigration(accountApi, identity, session, accounts)
    val workspaces = com.meldiq.android.data.account.WorkspaceRepository(accountApi)
    /** Recovery codes for a lost email address (docs/ACCOUNT_RECOVERY.md). */
    val recoveryCodes = com.meldiq.android.data.account.RecoveryCodesApi(api)
    /** Two-step sign-in, email change, standing and bug reports (API 0.46.0, docs/ACCOUNT_SAFETY.md). */
    val accountSafety = com.meldiq.android.data.account.AccountSafetyApi(api)
    /** What this account's server supports (server-info features, 2026-10-17). */
    val features = com.meldiq.android.data.repo.ServerFeatures(api)
    /** Experiments and content-free analytics counts, silent unless the server turns them on (docs/product/EXPERIMENTS.md). */
    val analytics = com.meldiq.android.data.repo.ProductSignals(api, features, scope)
    val db: GriipDatabase = GriipDatabase.open(app, identity.databasePassphrase(), profile.dbName)
    val realtime = RealtimeClient(app, api.http, scope, { session.serverUrl }, { session.token }, { session.reauth() })
    val users = UserRepository(api, db)
    val directory = KeyDirectory(api, db)
    val conversations = ConversationRepository(api, db, users)
    val appState = AppState()
    val notifier = MessageNotifier(app)
    val crypto = EnvelopeV1 { session.keys ?: error("no keys on this device") }
    val messages = MessageRepository(
        app, db, api, realtime, session, crypto, directory, conversations, users, settings, appState, scope,
        java.io.File(app.filesDir, profile.attachmentsDir), com.meldiq.android.data.repo.AttachmentUploader(api, features),
        serverHas = { features.has(it) == true },
    ) { notifier.show(it) }
    val orgs = OrgRepository(api, db, conversations, users)
    /** Custom roles, ownership transfer, usage and the audit log (docs/WORKSPACE_ROLES.md). */
    val roles = com.meldiq.android.data.repo.RoleRepository(api)
    /** Batch B4: reports and Security actions. */
    val reports = com.meldiq.android.data.repo.ReportRepository(api)
    /** Batch B4b: join applications and activity alerts. */
    val applications = com.meldiq.android.data.repo.ApplicationRepository(api)
    /** Batch B6: connections and messaging settings. */
    val connections = com.meldiq.android.data.repo.ConnectionRepository(api)
    /** Starred, sections, collapsed groups and mutes, kept on the server for every device (docs/WORKSPACE_ADMINISTRATION.md). */
    val navPrefs = com.meldiq.android.data.repo.NavPreferences(api, db, features, scope).also { np ->
        messages.countsEveryoneOf = { conv -> np.countsEveryone(conv) }
        messages.notifyLevelOf = { conv -> np.levelOf(conv) }
    }
    /** Reminders kept and fired by the server, sealed on this phone (docs/REMINDERS.md). */
    val reminderNotifier = com.meldiq.android.notify.ReminderNotifier(app, db) { session.session?.userId }
    val meetingNotifier = com.meldiq.android.notify.MeetingNotifier(app, api)
    val reminders = com.meldiq.android.data.repo.ReminderRepository(api, session, features) { reminderNotifier.show(it) }
    /** When each thread was last opened on this phone (Activity's thread replies). */
    val threadSeen = com.meldiq.android.data.repo.ThreadSeen(db)
    /** Batch B8: threads and forum posts followed on this phone. */
    val followedThreads = com.meldiq.android.data.repo.FollowedThreads(db)
    /** Batch B8b: the community guide and onboarding questions. */
    val guide = com.meldiq.android.data.repo.CommunityGuideRepository(api, db)
    /** Batch B9: a community's own emoji and stickers. */
    val expressions = com.meldiq.android.data.repo.ExpressionRepository(app, api, profile.id)
    val federation = com.meldiq.android.data.repo.FederationRepository(api)
    /** Meldiq Mojo: plans, Sparks and gifts bought through Google Play and verified by the server (docs/MOJO_ANDROID.md). */
    val mojo = com.meldiq.android.data.billing.MojoRepository(
        com.meldiq.android.data.billing.HttpMojoBackend(api), com.meldiq.android.data.billing.PlayBilling(app), scope,
    ).also { m -> scope.launch { messages.entitlementsChanged.collect { m.refreshEntitlements() } } }
    /** Encrypted message history on the server (docs/MESSAGE_HISTORY.md). */
    val history = com.meldiq.android.data.repo.HistorySync(api, db, session, features, conversations, scope)
    val profiles = com.meldiq.android.data.repo.ProfileRepository(app, api, users, session, profile.id)
    /** Home's per-community view on this phone: last channel, hide muted, unread only (Discord reference round). */
    val communityView = com.meldiq.android.data.repo.CommunityViewPrefs(app, profile.id)
    val translator by lazy { com.meldiq.android.data.repo.MessageTranslator(app) }
    val backups = com.meldiq.android.data.repo.BackupManager(app, db, session, java.io.File(app.filesDir, profile.attachmentsDir), profile.id)
    val calls = CallManager(app, api, db, session, messages, conversations, settings, scope)
    val voicePlayer = com.meldiq.android.voice.VoicePlayer(app)
    /** Push wake-ups for this profile (docs/BACKGROUND_DELIVERY.md); the profile id is the UnifiedPush instance. */
    val push = PushRegistrar(
        profile.id, PrefsPushStore(app), ApiPushServer(api, features),
        ConnectorDistributor(app) { "Meldiq · " + (runCatching { java.net.URI(session.serverUrl).host }.getOrNull() ?: session.serverUrl) },
    )
    /** Firebase wake-ups (docs/PUSH_FCM.md): only in builds with the owner's google-services.json. */
    val fcm = com.meldiq.android.data.repo.FcmRegistrar(com.meldiq.android.service.FirebaseTokenSource(app), com.meldiq.android.data.repo.ApiFcmServer(api, features))
    /** What a wake-up does: hold the relay connection until the backlog drained and ringing calls were looked up. */
    val wakeFetch = WakeFetch(scope, appState.wakeHolds, messages.backlogDrained, calls.ringChecks, calls.state.map { it.phase == CallPhase.Incoming })

    init {
        session.accountRenewal = { if (accounts.record?.tokens != null) accounts.refreshTokens() else null }
        messages.start()
        calls.start()
        history.start()
        scope.launch { orgs.loadSelection() }
        scope.launch { runCatching { threadSeen.load() } }
        scope.launch { runCatching { followedThreads.load() } }
        scope.launch { runCatching { guide.load() } }
        // The personal workspace's preferences, then the selected organisation's whenever it changes.
        scope.launch { runCatching { navPrefs.load(com.meldiq.android.data.repo.NavPreferences.PERSONAL) } }
        scope.launch { orgs.selectedOrg.collect { id -> if (id != null) runCatching { navPrefs.load(id) } } }
        scope.launch { messages.prefsUpdated.collect { ws -> runCatching { navPrefs.sync(ws) } } }
        // Firebase wake-ups started or stopped working: the background connection (and its notification) follows.
        scope.launch { fcm.state.collect { com.meldiq.android.service.BackgroundDelivery.sync(app) } }
        // Your name, status, photo or pause changed on another device: this one shows it at once.
        scope.launch { messages.ownAccountUpdates.collect { runCatching { profiles.refreshStatus() } } }
        // Reminders for saved messages follow the synced list (set, changed or cleared on any of the person's devices).
        // A server that keeps reminders fires them (docs/REMINDERS.md); otherwise this phone's own timers do.
        scope.launch {
            navPrefs.saved.collect { saved ->
                if (reminders.available.value) {
                    runCatching { com.meldiq.android.notify.LaterReminders.sync(app, emptyList()) }
                    runCatching { reminders.syncLater(saved) }
                } else runCatching { com.meldiq.android.notify.LaterReminders.sync(app, saved) }
            }
        }
        scope.launch { messages.reminderEvents.collect { runCatching { reminders.refresh() } } }
        // Round 7: "starting soon" for scheduled meetings (docs/WORKSPACE_C5.md).
        scope.launch { messages.meetingSoon.collect { id -> runCatching { meetingNotifier.startingSoon(id) } } }
        // Conversations that arrive later (a new channel, the first list after sign-in) get their synced mute state.
        scope.launch {
            conversations.observeAll().map { list -> list.map { it.id }.toSet() }.distinctUntilChanged()
                .collect { runCatching { navPrefs.reapplyMutes() } }
        }
        // Waiting changes go out when the connection comes back.
        scope.launch {
            realtime.state.collect { if (it == ConnState.Connected) navPrefs.prefs.value.keys.forEach { ws -> runCatching { navPrefs.sync(ws) } } }
        }
        // Reminders that went off while this phone was offline (a push wake-up connects it) are shown on reconnect.
        scope.launch {
            realtime.state.collect {
                if (it == ConnState.Connected) runCatching {
                    reminders.refresh()
                    if (reminders.available.value) reminders.syncLater(navPrefs.saved.value)
                }
            }
        }
        scope.launch { messages.orgDeleted.collect { runCatching { orgs.forget(it) }; runCatching { navPrefs.forget(it) } } }
        scope.launch {
            combine(session.state, appState.foreground, settings.state, calls.state, appState.wakeHolds) { s, fg, st, call, wake ->
                s is SessionState.SignedIn && (fg || st.backgroundConnection || call.phase != CallPhase.Idle || wake > 0)
            }.collect { want -> if (want) realtime.start() else realtime.stop() }
        }
        // An endpoint the server couldn't be told about (it was unreachable) goes as soon as the app connects again.
        scope.launch { realtime.state.collect { if (it == ConnState.Connected) push.retryPending() } }
        // Firebase wake-ups follow the session: registered when signed in, forgotten when signed out.
        scope.launch {
            session.state.map { it is SessionState.SignedIn }.distinctUntilChanged().collect { signedIn ->
                if (signedIn) {
                    runCatching { fcm.start() }.onFailure { android.util.Log.w("MeldiqFcm", "start failed: ${it.javaClass.simpleName}") }
                    android.util.Log.i("MeldiqFcm", "wake-ups: ${fcm.state.value}")
                } else fcm.reset()
            }
        }
        scope.launch { realtime.state.collect { if (it == ConnState.Connected) runCatching { fcm.retryPending() } } }
    }

    fun close() {
        mojo.close()
        voicePlayer.stop()
        realtime.stop()
        scope.cancel()
        db.close()
    }

    companion object {
        const val DB_NAME = "griip.db"
    }
}
