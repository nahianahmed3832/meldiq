package com.meldiq.android.activity

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings

/**
 * Reads which app is in front from Android's usage events (docs/ACTIVITY_STATUS.md). Needs Usage access
 * (PACKAGE_USAGE_STATS), which only the person can grant in system settings. Only events are read, never usage totals,
 * and nothing about apps that aren't games leaves [gameOf].
 */
class GameDetector(private val context: Context) {
    private val usage = context.getSystemService(UsageStatsManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)

    /** Whether the person allowed Meldiq in Settings › Usage access. */
    @Suppress("DEPRECATION") // each call is the one its Android version documents for reading an app op
    fun hasUsageAccess(): Boolean {
        val ops = context.getSystemService(AppOpsManager::class.java) ?: return false
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** While the screen is off nothing is in front, and the phone doesn't look. */
    fun screenOn(): Boolean = power?.isInteractive != false

    /** Foreground changes between [from] and [to]. */
    fun events(from: Long, to: Long): List<UsageEvent> {
        val stream = runCatching { usage?.queryEvents(from, to) }.getOrNull() ?: return emptyList()
        val out = ArrayList<UsageEvent>()
        val e = UsageEvents.Event()
        while (stream.hasNextEvent()) {
            stream.getNextEvent(e)
            val type = when (e.eventType) {
                RESUMED -> UsageEvent.Type.RESUMED
                PAUSED -> UsageEvent.Type.PAUSED
                SCREEN_NON_INTERACTIVE, KEYGUARD_SHOWN -> UsageEvent.Type.SCREEN_OFF
                else -> null
            } ?: continue
            out += UsageEvent(type, e.packageName, e.timeStamp)
        }
        return out
    }

    /** [packageId] as a game, or null when it isn't one (or Android doesn't let Meldiq see it). */
    fun gameOf(packageId: String): Game? {
        val info = runCatching { context.packageManager.getApplicationInfo(packageId, 0) }.getOrNull()
        val androidSaysGame = info != null && isGame(info)
        if (!KnownGames.counts(packageId, androidSaysGame, context.packageName)) return null
        val label = info?.let { runCatching { context.packageManager.getApplicationLabel(it).toString() }.getOrNull() }
        return KnownGames.displayName(packageId, label)?.let { Game(packageId, it) }
    }

    private fun isGame(info: ApplicationInfo): Boolean {
        @Suppress("DEPRECATION")
        val legacyFlag = info.flags and ApplicationInfo.FLAG_IS_GAME != 0
        return info.category == ApplicationInfo.CATEGORY_GAME || legacyFlag
    }

    companion object {
        // UsageEvents.Event: ACTIVITY_RESUMED (MOVE_TO_FOREGROUND), ACTIVITY_PAUSED, and the screen turning off.
        private const val RESUMED = 1
        private const val PAUSED = 2
        private const val SCREEN_NON_INTERACTIVE = 16
        private const val KEYGUARD_SHOWN = 17

        /** Android's Usage access list, with Meldiq highlighted where the phone supports it. */
        fun usageAccessIntent(context: Context): Intent =
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                data = android.net.Uri.fromParts("package", context.packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }.takeIf { it.resolveActivity(context.packageManager) != null }
                ?: Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
