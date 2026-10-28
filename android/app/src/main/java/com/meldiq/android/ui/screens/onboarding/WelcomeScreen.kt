package com.meldiq.android.ui.screens.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.unit.em
import com.meldiq.android.ui.theme.Shapes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.meldiq.android.R
import com.meldiq.android.ui.components.ButtonTone
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.MeldiqLockup
import com.meldiq.android.ui.components.MeldiqLogo
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.pressable
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.accentBrush

private val MaxWelcomeWidth = 520.dp
private const val LOCK_ICON = "lock"
private val HeroMax = 208.dp
/** The logo's size within the hero, and the scale it settles in from. */
private const val HERO_LOGO = 0.62f
private const val HERO_START_SCALE = 0.88f

/**
 * The first screen: the Meldiq logo, the promise in two lines, Sign up (primary) and Log in (secondary).
 * [onBrandTap] counts taps on the lockup (seven toggle developer options); [showServer] adds the server button.
 */
@Composable
internal fun WelcomeScreen(
    showServer: Boolean,
    onBrandTap: () -> Unit,
    onSignUp: () -> Unit,
    onLogIn: () -> Unit,
    onServer: () -> Unit,
) {
    val c = Griip.colors
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = Space.screen, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MeldiqLockup(Modifier.clip(Shapes.small).pressable(onBrandTap))
            Spacer(Modifier.weight(1f))
            LanguageButton()
            if (showServer) CircleIconButton(Icons.Outlined.Dns, stringResource(R.string.auth_server_settings), onServer)
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val hero = min(HeroMax, maxHeight * 0.34f)
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(horizontal = Space.screen),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(Modifier.widthIn(max = MaxWelcomeWidth).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    MeldiqHero(hero)
                    Spacer(Modifier.height(Space.xxl))
                    Text(
                        buildAnnotatedString {
                            append(stringResource(R.string.welcome_title_1))
                            append("\n")
                            withStyle(SpanStyle(brush = c.accentBrush())) { append(stringResource(R.string.welcome_title_2)) }
                        },
                        style = Griip.type.hero,
                        color = c.textPrimary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )
                    Spacer(Modifier.height(Space.md))
                    Text(stringResource(R.string.welcome_body), style = Griip.type.body, color = c.textSecondary, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(Space.lg))
                    val trust = stringResource(R.string.welcome_trust)
                    Text(
                        buildAnnotatedString {
                            appendInlineContent(LOCK_ICON) // alternate text must not be empty; TalkBack gets [trust] below
                            append("  ")
                            append(trust)
                        },
                        style = Griip.type.caption, color = c.textSecondary, textAlign = TextAlign.Center,
                        modifier = Modifier.clearAndSetSemantics { contentDescription = trust },
                        inlineContent = mapOf(
                            LOCK_ICON to InlineTextContent(Placeholder(1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
                                Icon(Icons.Rounded.Lock, null, tint = c.textSecondary, modifier = Modifier.fillMaxSize())
                            },
                        ),
                    )
                    Spacer(Modifier.height(Space.lg))
                }
            }
        }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Space.screen).padding(top = 8.dp, bottom = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = MaxWelcomeWidth).fillMaxWidth()) {
                PillButton(stringResource(R.string.welcome_sign_up), onSignUp, Modifier.fillMaxWidth(), height = 56.dp)
                Spacer(Modifier.height(Space.md))
                PillButton(stringResource(R.string.welcome_log_in), onLogIn, Modifier.fillMaxWidth(), tone = ButtonTone.Glass, height = 56.dp)
            }
        }
    }
}

/**
 * Meldling's banner over a soft glow in the palette's accent. It settles in once (a short scale and fade) unless the
 * person turned animations off; nothing loops.
 */
@Composable
private fun MeldiqHero(size: Dp) {
    val c = Griip.colors
    val reduced = com.meldiq.android.ui.theme.rememberReducedMotion()
    var shown by androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(reduced) }
    androidx.compose.runtime.LaunchedEffect(Unit) { shown = true }
    val progress by androidx.compose.animation.core.animateFloatAsState(
        if (shown) 1f else 0f, if (reduced) androidx.compose.animation.core.snap() else com.meldiq.android.ui.theme.Motion.entrance(), label = "hero",
    )
    Box(
        // Decoration: the lockup above already names Meldiq for TalkBack.
        Modifier.fillMaxWidth().clearAndSetSemantics {}.drawBehind {
            val r = this.size.minDimension / 2
            drawCircle(Brush.radialGradient(listOf(c.accentStart.copy(alpha = 0.22f * progress), c.accentEnd.copy(alpha = 0.10f * progress), Color.Transparent), center, r), r, center)
        },
        contentAlignment = Alignment.Center,
    ) {
        // The owner's Meldling banner (2026-10-29, as Meldiq Web's sign-in hero), settling in once.
        androidx.compose.foundation.Image(
            androidx.compose.ui.res.painterResource(com.meldiq.android.R.drawable.meldling_banner), null,
            Modifier.fillMaxWidth().aspectRatio(BANNER_RATIO).clip(com.meldiq.android.ui.theme.Shapes.hero).graphicsLayer {
                alpha = progress
                val scale = HERO_START_SCALE + (1f - HERO_START_SCALE) * progress
                scaleX = scale
                scaleY = scale
            },
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
        )
    }
}

/** The banner art's width to height (1600 × 635). */
private const val BANNER_RATIO = 1600f / 635f
