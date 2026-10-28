package com.meldiq.android.ui.screens.onboarding

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Workspaces
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Headset
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.meldiq.android.R
import com.meldiq.android.ui.components.MeldiqLockup
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Motion
import com.meldiq.android.ui.theme.Shapes
import com.meldiq.android.ui.theme.Space
import com.meldiq.android.ui.theme.rememberReducedMotion
import kotlinx.coroutines.launch

/** One introduction page. [soon] marks a feature that is planned but not in the app yet; the page says so. */
/** [art]: Meldling's pose for the page (the owner's art, 2026-10-29, the same poses as Meldiq Web's intro). */
private data class IntroPage(val icon: ImageVector, val title: Int, val body: Int, val soon: Boolean = false, val art: Int)

private val Pages = listOf(
    IntroPage(Icons.Outlined.Forum, R.string.intro_talk_title, R.string.intro_talk_body, art = R.drawable.meldling_waving),
    IntroPage(Icons.Outlined.NotificationsActive, R.string.intro_remind_title, R.string.intro_remind_body, art = R.drawable.meldling_love),
    IntroPage(Icons.Outlined.Headset, R.string.intro_voice_title, R.string.intro_voice_body, art = R.drawable.meldling_gaming),
    // 2026-10-21: communities replaced the connector and HR pages (both features were removed).
    IntroPage(Icons.Outlined.Workspaces, R.string.nv_intro_communities_title, R.string.nv_intro_communities_body, art = R.drawable.meldling_hello),
    IntroPage(Icons.Outlined.AdminPanelSettings, R.string.nv_intro_roles_title, R.string.nv_intro_roles_body, art = R.drawable.meldling_all_set),
)

private val MaxIntroWidth = 520.dp
private val IllustrationSize = 132.dp

/**
 * The first-run introduction (round 6): a few short pages on what Meldiq does, before sign-up. Skip is always there;
 * nothing asks for a permission here. Shown once ([com.meldiq.android.data.repo.Settings.introSeen]) and replayable
 * from Settings › About.
 */
@Composable
fun IntroScreen(onDone: () -> Unit) {
    val c = Griip.colors
    val pager = rememberPagerState { Pages.size }
    val scope = rememberCoroutineScope()
    val last = pager.currentPage == Pages.lastIndex
    Column(Modifier.fillMaxSize().background(c.background).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = Space.screen, end = 8.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            MeldiqLockup()
            Spacer(Modifier.weight(1f))
            TextButton(onDone) { Text(stringResource(R.string.intro_skip), style = Griip.type.button, color = c.textSecondary) }
        }
        HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth()) { index ->
            IntroPageView(Pages[index], selected = pager.currentPage == index)
        }
        PageDots(Pages.size, pager.currentPage, Modifier.align(Alignment.CenterHorizontally).padding(vertical = 12.dp))
        Box(Modifier.fillMaxWidth().padding(horizontal = Space.screen).padding(bottom = 16.dp), contentAlignment = Alignment.Center) {
            PillButton(
                stringResource(if (last) R.string.intro_start else R.string.intro_next),
                { if (last) onDone() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } },
                Modifier.widthIn(max = MaxIntroWidth).fillMaxWidth(), height = 56.dp,
            )
        }
    }
}

@Composable
private fun IntroPageView(page: IntroPage, selected: Boolean) {
    val c = Griip.colors
    val reduced = rememberReducedMotion()
    // The illustration settles in when its page comes into view; still when animations are off.
    val shown by animateFloatAsState(if (selected || reduced) 1f else 0f, if (reduced) snap() else Motion.entrance(), label = "intro")
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.screen),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        val art = androidx.compose.ui.res.painterResource(page.art)
        androidx.compose.foundation.Image(
            art, null,
            Modifier.height(IllustrationSize * 1.6f).aspectRatio(art.intrinsicSize.width / art.intrinsicSize.height).clearAndSetSemantics {}
                .graphicsLayer { alpha = 0.4f + 0.6f * shown; val s = 0.9f + 0.1f * shown; scaleX = s; scaleY = s }
                .clip(Shapes.panel),
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
        )
        Spacer(Modifier.height(Space.xxl))
        if (page.soon) {
            Text(
                stringResource(R.string.intro_soon), style = Griip.type.caption.copy(fontWeight = FontWeight.SemiBold), color = c.textPrimary,
                modifier = Modifier.clip(Shapes.pill).background(c.surfaceVariant).padding(horizontal = 10.dp, vertical = 4.dp),
            )
            Spacer(Modifier.height(Space.md))
        }
        Text(
            stringResource(page.title), style = Griip.type.title, color = c.textPrimary, textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = MaxIntroWidth).semantics { heading() },
        )
        Spacer(Modifier.height(Space.md))
        Text(stringResource(page.body), style = Griip.type.body, color = c.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = MaxIntroWidth))
    }
}

/** Page dots: the current one is a longer pill, so the position isn't shown by colour alone. */
@Composable
private fun PageDots(count: Int, current: Int, modifier: Modifier) {
    val c = Griip.colors
    val label = stringResource(R.string.intro_page, current + 1, count)
    Row(modifier.semantics { contentDescription = label }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(count) { i ->
            val width by animateDpAsState(if (i == current) 22.dp else 8.dp, Motion.quick(), label = "dot")
            Box(Modifier.height(8.dp).width(width).clip(Shapes.pill).background(if (i == current) c.primary else c.outline))
        }
    }
}
