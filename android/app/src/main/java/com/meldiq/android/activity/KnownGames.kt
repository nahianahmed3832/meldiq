package com.meldiq.android.activity

/**
 * Popular mobile games by package (docs/ACTIVITY_STATUS.md): counted as games even when their developer didn't set
 * Android's game category, and shown under the name players know rather than the launcher label ("BGMI", "PUBG MOBILE").
 * Any other app counts only if Android lists it as a game (ApplicationInfo.CATEGORY_GAME).
 */
object KnownGames {
    private val NAMES: Map<String, String> = mapOf(
        "com.tencent.ig" to "PUBG Mobile",
        "com.pubg.krmobile" to "PUBG Mobile",
        "com.vng.pubgmobile" to "PUBG Mobile",
        "com.rekoo.pubgm" to "PUBG Mobile",
        "com.pubg.imobile" to "Battlegrounds Mobile India",
        "com.pubg.newstate" to "PUBG: New State",
        "com.dts.freefireth" to "Free Fire",
        "com.dts.freefiremax" to "Free Fire MAX",
        "com.activision.callofduty.shooter" to "Call of Duty: Mobile",
        "com.activision.callofduty.warzone" to "Call of Duty: Warzone Mobile",
        "com.miHoYo.GenshinImpact" to "Genshin Impact",
        "com.HoYoverse.hkrpgoversea" to "Honkai: Star Rail",
        "com.HoYoverse.Nap" to "Zenless Zone Zero",
        "com.mobile.legends" to "Mobile Legends: Bang Bang",
        "com.levelinfinite.sgameGlobal" to "Honor of Kings",
        "com.riotgames.league.wildrift" to "League of Legends: Wild Rift",
        "com.supercell.clashofclans" to "Clash of Clans",
        "com.supercell.clashroyale" to "Clash Royale",
        "com.supercell.brawlstars" to "Brawl Stars",
        "com.roblox.client" to "Roblox",
        "com.mojang.minecraftpe" to "Minecraft",
        "com.innersloth.spacemafia" to "Among Us",
        "com.nianticlabs.pokemongo" to "Pokémon GO",
        "jp.konami.pesam" to "eFootball",
        "com.ea.gp.fifamobile" to "EA SPORTS FC Mobile",
        "com.kiloo.subwaysurf" to "Subway Surfers",
        "com.king.candycrushsaga" to "Candy Crush Saga",
        "com.gameloft.android.ANMP.GloftA9HM" to "Asphalt Legends",
        "com.garena.game.codm" to "Call of Duty: Mobile",
        "com.ngame.allstar.eu" to "Arena of Valor",
        "com.YoStarEN.Arknights" to "Arknights",
        "com.netease.newspike" to "Marvel Rivals",
        "com.ludo.king" to "Ludo King",
    )

    /** The name to show for [packageId] when it's a known game; null otherwise. */
    fun nameOf(packageId: String): String? = NAMES[packageId]

    fun isKnown(packageId: String): Boolean = packageId in NAMES

    /**
     * Whether [packageId] is reported as a game: a known one, or one Android lists as a game. Meldiq itself and the
     * phone's launcher never are.
     */
    fun counts(packageId: String, androidSaysGame: Boolean, ownPackage: String): Boolean =
        packageId != ownPackage && (isKnown(packageId) || androidSaysGame)

    /** The name shown for a game: the known one, else its launcher label trimmed to what the server accepts. */
    fun displayName(packageId: String, label: String?): String? =
        (nameOf(packageId) ?: label)?.replace(Regex("[\\p{Cc}\\p{Cf}\\u2028\\u2029]"), "")?.trim()?.take(MAX_NAME)?.ifBlank { null }

    /** The server's limit on an activity's name. */
    const val MAX_NAME = 64
}
