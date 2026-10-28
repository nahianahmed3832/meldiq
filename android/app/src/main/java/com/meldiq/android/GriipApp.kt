package com.meldiq.android

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.launch
import com.meldiq.android.crypto.IdentityStore
import com.meldiq.android.data.repo.ProfileRegistry
import com.meldiq.android.data.repo.ProfileStorage
import com.meldiq.android.di.AppContainer
import com.meldiq.android.notify.Channels
import com.meldiq.android.service.BackgroundDelivery
import com.meldiq.android.service.PersistentConnection
import com.meldiq.android.service.UnifiedPushDelivery
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

class GriipApp : Application() {
    @Volatile var container: AppContainer? = null
        private set
    /** Bumped when the container is recreated so the UI rebinds. */
    val generation = MutableStateFlow(0)
    /** Work that outlives a profile's container (telling a server to stop wake-ups after switching away from it). */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var profiles: ProfileRegistry
        private set

    override fun onCreate() {
        super.onCreate()
        Channels.create(this)
        // The shared sticker catalogue (a few KB): read once; a missing or malformed file just means no stickers.
        runCatching { assets.open(com.meldiq.android.data.model.StickerCatalog.ASSET).bufferedReader().use { com.meldiq.android.data.model.StickerCatalog.load(it.readText()) } }
        profiles = ProfileRegistry(this)
        container = containerFor(profiles.current.active)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                val c = container ?: return
                c.appState.foreground.value = true
                // FGS may only be started while visible: (re)start the optional background connection here.
                BackgroundDelivery.sync(this@GriipApp)
                // Experiments and analytics: silent unless this account's server turned them on.
                if (c.session.session != null) c.scope.launch {
                    c.analytics.refresh()
                    c.analytics.track("app.opened")
                }
                // Meldiq Mojo: send the server any Google Play purchase it hasn't confirmed yet (docs/MOJO_ANDROID.md).
                if (c.session.session != null) c.scope.launch { c.mojo.reconcile() }
            }

            override fun onStop(owner: LifecycleOwner) {
                container?.appState?.foreground?.value = false
                container?.let { c -> c.scope.launch { c.analytics.flush() } }
            }
        })
    }

    private fun containerFor(id: String): AppContainer =
        AppContainer(this, ProfileStorage.of(id), profiles.initialUrl(id) ?: BuildConfig.DEFAULT_SERVER_URL)

    /**
     * "Sign out & erase" for the active profile: deletes its keys, encrypted database and downloaded
     * attachments. Other server profiles on this phone are not touched.
     */
    fun eraseEverything() {
        PersistentConnection.stop(this)
        val storage = container?.profile ?: ProfileStorage.of(profiles.current.active)
        container?.let {
            UnifiedPushDelivery.endLocally(this, it.profile.id) // the server's copy went with the device's revocation
            it.notifier.clearAll() // decrypted message text must not stay in the notification shade
            it.identity.clearAll()
            it.close()
        }
        deleteProfileFiles(storage)
        container = containerFor(storage.id)
        generation.value++
    }

    /**
     * Makes [id] the active profile. The current profile is closed, not erased: its keys, messages and
     * session stay on this phone for when the person switches back. Nothing is copied between profiles.
     */
    fun switchProfile(id: String) {
        val current = container
        if (current?.profile?.id == id || !profiles.current.has(id)) return
        PersistentConnection.stop(this)
        current?.let {
            UnifiedPushDelivery.release(it, appScope) // only the active profile is woken; switching back registers again
            it.notifier.clearAll() // notifications belong to the profile that showed them
            it.close()
        }
        profiles.update { it.activate(id) }
        container = containerFor(id)
        generation.value++
        BackgroundDelivery.sync(this)
    }

    /** Adds a profile for another server and switches to it; the new profile starts signed out. */
    fun addProfile(serverUrl: String): String {
        var id = ""
        profiles.update { l -> l.add(serverUrl, System.currentTimeMillis()).also { id = it.extra.last().id } }
        switchProfile(id)
        return id
    }

    /**
     * Removes an inactive, non-original profile from this phone: its keys, messages and files here. The
     * account on that server isn't deleted (another device or the recovery key can still sign in).
     */
    fun removeProfile(id: String) {
        val l = profiles.current
        if (id == ProfileStorage.DEFAULT || id == l.active || !l.has(id)) return
        val storage = ProfileStorage.of(id)
        UnifiedPushDelivery.endLocally(this, id)
        IdentityStore(this, storage.identityPrefs, storage.keystoreAlias).clearAll()
        deleteProfileFiles(storage)
        deleteSharedPreferences(storage.identityPrefs)
        profiles.update { it.remove(id) }
    }

    data class ProfileSummary(val id: String, val serverUrl: String, val username: String?, val active: Boolean, val original: Boolean, val displayName: String? = null)

    /**
     * What the Servers screen lists. An inactive profile's session is opened with that profile's own
     * Keystore key, only to show its server and username; nothing is copied out of it.
     */
    fun profileSummaries(): List<ProfileSummary> {
        val l = profiles.current
        val settings = getSharedPreferences("griip_settings", MODE_PRIVATE)
        return l.ids.map { id ->
            val st = ProfileStorage.of(id)
            val c = container?.takeIf { it.profile.id == id }
            val session = c?.session?.session ?: if (c == null) runCatching { IdentityStore(this, st.identityPrefs, st.keystoreAlias).session() }.getOrNull() else null
            val url = session?.serverUrl ?: settings.getString(st.serverKey, null) ?: profiles.initialUrl(id) ?: BuildConfig.DEFAULT_SERVER_URL
            ProfileSummary(id, url, session?.username, id == l.active, id == ProfileStorage.DEFAULT, session?.displayName?.ifEmpty { null })
        }
    }

    private fun deleteProfileFiles(storage: ProfileStorage) {
        deleteDatabase(storage.dbName)
        File(filesDir, storage.attachmentsDir).deleteRecursively()
        File(filesDir, storage.picturesDir).deleteRecursively()
        getSharedPreferences("griip_settings", MODE_PRIVATE).edit().remove(storage.serverKey).apply()
    }
}
