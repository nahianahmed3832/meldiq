package com.meldiq.android.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/** Spacing on a 4 dp grid (docs/DESIGN_SYSTEM.md §3.4). 16 dp side gutter since the 2026-10-16 redesign. */
object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
    val xxxl = 32.dp
    val gutter = 16.dp
    /** Side margin of focused, single-task screens (welcome, sign-up, sign-in): more air than a list screen. */
    val screen = 24.dp
}

/**
 * Radii. The floating redesign (2026-10-28, as Meldiq Web's `--r-card` and `--r-panel`): 18 dp cards, 24 dp panels, sheets
 * and dialogs, pill buttons; 14 dp tiles and 12 dp icon tiles, 8 dp for small parts.
 */
object Shapes {
    val hero = RoundedCornerShape(24.dp)
    val card = RoundedCornerShape(18.dp)
    val tile = RoundedCornerShape(14.dp)
    val iconTile = RoundedCornerShape(12.dp)
    val small = RoundedCornerShape(8.dp)
    /** Inputs on focused forms (sign-up, sign-in). */
    val field = RoundedCornerShape(16.dp)
    /** Floating panels: the channel list, Settings, choice cards. */
    val panel = RoundedCornerShape(24.dp)
    val pill = RoundedCornerShape(percent = 50)
    val sheet = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    /** Message bubbles: 18 dp, with a 6 dp corner toward the sender on the first bubble of a run. */
    val bubble = 18.dp
    val bubbleTail = 6.dp
}

/**
 * Motion tokens (docs/DESIGN_SYSTEM.md › Motion, Meldiq 2.0). Short and purposeful: nothing waits on an animation,
 * and with the system's animations off every state change snaps ([rememberReducedMotion]).
 *
 * - [INSTANT] 90 ms: what leaves first (a fading tab, a dismissed chip).
 * - [QUICK] 160 ms: small state changes (selection, toggles, badges).
 * - [STANDARD] 220 ms: panels, sheets, expanding sections.
 * - [PAGE] 260 ms: whole screens sliding in or out.
 * - [ENTRANCE] 420 ms: one-off entrances only (welcome logo, a sticker landing), never looping.
 *
 * Things arriving decelerate ([EmphasizedDecelerate]); things leaving accelerate ([EmphasizedAccelerate]), the
 * Material 3 emphasized curves.
 */
object Motion {
    const val INSTANT = 90
    const val QUICK = 160
    const val STANDARD = 220
    const val PAGE = 260
    const val ENTRANCE = 420
    /** A tab's content waits this long so the old one is gone first (fade-through). */
    const val FADE_THROUGH_DELAY = 60
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    fun <T> standard() = tween<T>(STANDARD, easing = FastOutSlowInEasing)
    fun <T> quick() = tween<T>(QUICK, easing = FastOutSlowInEasing)
    fun <T> entrance() = tween<T>(ENTRANCE, easing = FastOutSlowInEasing)
    /** Something arriving: a screen, a sheet, a panel. */
    fun <T> enter(durationMillis: Int = PAGE, delayMillis: Int = 0) = tween<T>(durationMillis, delayMillis, EmphasizedDecelerate)
    /** Something leaving. */
    fun <T> exit(durationMillis: Int = PAGE) = tween<T>(durationMillis, easing = EmphasizedAccelerate)
}

/**
 * Batch B16: how a list row moves when the list changes (a category opening or closing, a message arriving, a row
 * moving): it fades in or out and slides to its new place. Rows keep their keys, so only the rows that changed move;
 * nothing animates on first load or on an edit of a row. Still when animations are off.
 */
@androidx.compose.runtime.Composable
fun androidx.compose.foundation.lazy.LazyItemScope.listItemMotion(): androidx.compose.ui.Modifier =
    if (rememberReducedMotion()) androidx.compose.ui.Modifier
    else androidx.compose.ui.Modifier.animateItem(
        fadeInSpec = tween(Motion.QUICK, easing = FastOutSlowInEasing),
        placementSpec = androidx.compose.animation.core.spring(
            stiffness = androidx.compose.animation.core.Spring.StiffnessMediumLow,
            visibilityThreshold = androidx.compose.ui.unit.IntOffset.VisibilityThreshold,
        ),
        fadeOutSpec = tween(Motion.INSTANT),
    )

/**
 * Whether the person turned animations off (Settings › Accessibility › Remove animations, or an animator scale of 0).
 * Decorative motion (entrances, stickers, loops) stays still then; state changes simply snap.
 */
@androidx.compose.runtime.Composable
fun rememberReducedMotion(): Boolean {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    return androidx.compose.runtime.remember {
        val scale = runCatching {
            android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
        !com.meldiq.android.ui.NavMotionRules.animationsEnabled(scale)
    }
}
