package com.meldiq.android.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.SportsEsports
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meldiq.android.R
import com.meldiq.android.activity.ActivityDto
import com.meldiq.android.activity.ActivityElapsed
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.theme.Griip
import kotlinx.coroutines.delay

/** How often the elapsed time on an activity line moves on. */
private const val ELAPSED_TICK_MS = 30_000L

/** What [userId] is playing right now, as this account may see it (docs/ACTIVITY_STATUS.md); null: nothing shown. */
@Composable
fun rememberActivity(userId: String?): ActivityDto? {
    val all by LocalContainer.current.activities.all.collectAsStateWithLifecycle()
    return userId?.let { all[it] }
}

/** "Playing PUBG Mobile · 12 min" (the elapsed time only with [withElapsed]), kept current while shown. */
@Composable
fun activityLabel(activity: ActivityDto, withElapsed: Boolean = true): String {
    val playing = stringResource(R.string.act_playing, activity.name)
    if (!withElapsed) return playing
    val now by produceState(System.currentTimeMillis(), activity.startedAt) {
        while (true) {
            delay(ELAPSED_TICK_MS)
            value = System.currentTimeMillis()
        }
    }
    val elapsed = when (val e = ActivityElapsed.of(activity.startedAt, now)) {
        ActivityElapsed.Shown.JustStarted -> stringResource(R.string.act_just_started)
        is ActivityElapsed.Shown.Minutes -> stringResource(R.string.act_minutes, e.minutes)
        is ActivityElapsed.Shown.Hours -> stringResource(R.string.act_hours, e.hours, e.minutes)
    }
    return "$playing · $elapsed"
}

/**
 * The "Playing …" line under a name: a controller glyph and the label. Shows nothing for [activity] null, so callers
 * can place it unconditionally.
 */
@Composable
fun PlayingLine(
    activity: ActivityDto?,
    modifier: Modifier = Modifier,
    withElapsed: Boolean = true,
    style: TextStyle = Griip.type.caption,
    color: Color = Griip.colors.textSecondary,
) {
    if (activity == null) return
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.SportsEsports, stringResource(R.string.act_cd_game), tint = Griip.colors.primary, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text(activityLabel(activity, withElapsed), style = style, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Your own activity (the You tab and its user panel): what this account's devices report, while it lasts. */
@Composable
fun MyPlayingLine(modifier: Modifier = Modifier) {
    PlayingLine(rememberActivity(LocalContainer.current.session.session?.userId), modifier)
}
