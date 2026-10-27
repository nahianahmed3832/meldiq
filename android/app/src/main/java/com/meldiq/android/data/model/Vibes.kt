package com.meldiq.android.data.model

/**
 * Colour themes ("vibes", as Meldiq Web's Settings › Appearance › Colour themes, 2026-10-28): a gradient that tints the
 * whole app, from Meldiq's presets or two or three colours of your own, at the strength you choose. Drawn as one soft
 * layer over the app, so text keeps its contrast in every palette, light or dark. This phone's choice only.
 */
object Vibes {
    data class Vibe(val id: String, val colors: List<String>)

    const val CUSTOM = "custom"
    const val STRENGTH_DEFAULT = 60
    const val STRENGTH_MIN = 10
    const val STRENGTH_MAX = 100
    const val STRENGTH_STEP = 5

    /** The web's presets, same ids and colours. */
    val ALL = listOf(
        Vibe("mint-wave", listOf("#6ee7b7", "#38bdf8")),
        Vibe("peach", listOf("#fdba74", "#fde68a")),
        Vibe("lavender", listOf("#a5b4fc", "#c4b5fd")),
        Vibe("cotton", listOf("#f9a8d4", "#fcd34d")),
        Vibe("tangerine", listOf("#fb923c", "#fbbf24")),
        Vibe("lilac", listOf("#e879f9", "#93c5fd")),
        Vibe("seafoam", listOf("#67e8f9", "#86efac")),
        Vibe("sand", listOf("#d9c48a", "#a3b18a")),
        Vibe("coral", listOf("#fb7185", "#fb923c")),
        Vibe("sky-grape", listOf("#22d3ee", "#c084fc")),
        Vibe("jade", listOf("#10b981", "#0ea5e9")),
        Vibe("ruby", listOf("#be123c", "#7f1d1d")),
        Vibe("indigo", listOf("#6366f1", "#7c3aed")),
        Vibe("rust", listOf("#c2410c", "#9a3412")),
        Vibe("dusk", listOf("#8b5cf6", "#d946ef")),
        Vibe("lagoon", listOf("#06b6d4", "#3b82f6")),
        Vibe("sunset", listOf("#f43f5e", "#f59e0b")),
        Vibe("aurora", listOf("#2dd4bf", "#6366f1")),
        Vibe("neon", listOf("#e879f9", "#22d3ee")),
        Vibe("deep-sea", listOf("#1e40af", "#1e3a8a")),
    )

    /** A custom theme starts from these two (the web's default). */
    val CUSTOM_START = listOf("#ff6b4a", "#a855f7")

    /** Colours to build a custom theme from (no colour picker on phones): the presets' colours, each once. */
    val SWATCHES: List<String> = (ALL.flatMap { it.colors } + CUSTOM_START).distinct()

    /** The colours a choice paints with, or null for none (an unknown id, or a custom theme that isn't 2–3 colours). */
    fun colors(vibe: String?, custom: List<String>?): List<String>? = when (vibe) {
        null -> null
        CUSTOM -> custom?.takeIf { it.size in 2..3 && it.all(LookRules::isHex) }
        else -> ALL.firstOrNull { it.id == vibe }?.colors
    }

    fun strength(v: Int): Int = v.coerceIn(STRENGTH_MIN, STRENGTH_MAX)

    /**
     * How opaque the tint layer is (as the web's stylesheet): a soft-light layer at 0.9 × strength on dark palettes, a
     * multiply layer at 0.28 × strength on light ones.
     */
    fun alpha(strength: Int, dark: Boolean): Float = strength(strength) / 100f * if (dark) DARK_FACTOR else LIGHT_FACTOR

    private const val DARK_FACTOR = 0.9f
    private const val LIGHT_FACTOR = 0.28f
}
