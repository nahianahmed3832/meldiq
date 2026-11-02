package com.meldiq.android.crypto

import android.content.Context
import com.meldiq.android.data.account.SupabaseSession
import com.meldiq.android.data.account.SupabaseSessionVault
import kotlinx.serialization.json.Json

/** Separate sealed session slot; does not overwrite legacy device keys, account sessions or pending messages. */
class SupabaseSessionStore(context: Context, profile: String) : SupabaseSessionVault {
    init { require(profile.matches(Regex("[A-Za-z0-9_-]{1,80}"))) }
    private val prefs = context.getSharedPreferences("meldiq_supabase_$profile", Context.MODE_PRIVATE)
    private val sealer = KeystoreSealer("meldiq_supabase_v1_$profile")
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): SupabaseSession? {
        val sealed = prefs.getString("session", null) ?: return null
        return json.decodeFromString<SupabaseSession>(String(sealer.open(sealed.unb64()), Charsets.UTF_8))
    }

    override fun save(session: SupabaseSession?) {
        val edit = prefs.edit()
        if (session == null) edit.remove("session")
        else edit.putString("session", sealer.seal(json.encodeToString(SupabaseSession.serializer(), session).toByteArray(Charsets.UTF_8)).b64())
        check(edit.commit()) { "Account session could not be saved securely" }
    }
}
