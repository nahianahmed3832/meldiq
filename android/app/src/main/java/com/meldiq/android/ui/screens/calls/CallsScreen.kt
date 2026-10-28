package com.meldiq.android.ui.screens.calls

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.CallMade
import androidx.compose.material.icons.automirrored.rounded.CallMissed
import androidx.compose.material.icons.automirrored.rounded.CallReceived
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.rounded.AddIcCall
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.meldiq.android.call.CallPhase
import com.meldiq.android.data.db.CallLogEntity
import com.meldiq.android.data.repo.ConversationRepository
import com.meldiq.android.ui.LocalContainer
import com.meldiq.android.ui.Routes
import com.meldiq.android.ui.TimeFmt
import com.meldiq.android.ui.components.CircleIconButton
import com.meldiq.android.ui.components.EmptyState
import com.meldiq.android.ui.components.LargeHeader
import com.meldiq.android.ui.components.ListCard
import com.meldiq.android.ui.components.PillButton
import com.meldiq.android.ui.components.SectionHeader
import com.meldiq.android.ui.screens.chats.ConversationAvatar
import com.meldiq.android.ui.theme.Griip
import com.meldiq.android.ui.theme.Space
import kotlinx.coroutines.launch

/** How a call-log entry is described: direction, whether it was missed, and its duration if it connected. */
internal object CallLogText {
    fun missed(e: CallLogEntity) = !e.outgoing && e.answeredAt == null
    fun detail(e: CallLogEntity): String {
        val kind = if (e.video) "Video" else "Voice"
        val direction = when {
            missed(e) -> "Missed"
            e.outgoing && e.answeredAt == null -> "Not answered"
            e.outgoing -> "Outgoing"
            else -> "Incoming"
        }
        val length = e.answeredAt?.let { a -> e.endedAt?.takeIf { it > a }?.let { TimeFmt.duration((it - a) / 1000) } }
        return listOfNotNull("$direction ${kind.lowercase()} call", length, TimeFmt.listStamp(e.startedAt)).joinToString(" · ")
    }
}

/** Calls (from Home's Calls card, Activity and the menus): calls running now in your conversations, then the call history kept on this device. */
@Composable
fun CallsScreen(nav: NavHostController) {
    val container = LocalContainer.current
    val c = Griip.colors
    val me = container.session.session?.userId
    val log by container.db.calls().observeLog().collectAsStateWithLifecycle(emptyList())
    val convs by container.conversations.observeAll().collectAsStateWithLifecycle(emptyList())
    val call by container.calls.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val permission = rememberCallPermission()
    val byId = convs.associateBy { it.id }
    val live = convs.filter { it.activeCallId != null }
    val idle = call.phase == CallPhase.Idle

    fun callBack(conversationId: String, video: Boolean) = permission(video) { scope.launch { container.calls.startCall(conversationId, video) } }

    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding())) {
            item { com.meldiq.android.ui.components.GriipTopBar("Calls", onBack = { nav.popBackStack() }) }
            if (live.isNotEmpty()) {
                item { SectionHeader("Active now", Modifier.padding(top = 4.dp, bottom = 4.dp)) }
                items(live, key = { "live" + it.id }) { conv ->
                    val title = ConversationRepository.title(conv, me).let { if (conv.type == "CHANNEL") "#$it" else it }
                    ListCard(
                        title, Modifier.padding(horizontal = 8.dp),
                        subtitle = if (conv.activeCallVideo) "Video call in progress" else "Voice call in progress",
                        leading = { ConversationAvatar(conv, me, size = 48.dp) },
                        trailing = {
                            PillButton("Join", {
                                permission(conv.activeCallVideo) { scope.launch { container.calls.join(conv.id, conv.activeCallId!!, conv.activeCallVideo) } }
                            }, enabled = idle, height = 40.dp)
                        },
                        onClick = { nav.navigate(Routes.conversation(conv.id)) },
                    )
                }
            }
            if (log.isNotEmpty()) item { SectionHeader("Recent", Modifier.padding(top = 8.dp, bottom = 4.dp)) }
            if (log.isEmpty() && live.isEmpty()) {
                item {
                    EmptyState(
                        Icons.Outlined.Call, "No calls yet",
                        "Voice and video calls travel over encrypted connections; the call screen shows their state. Your call history is kept on Meldiq's servers.",
                        action = "Start a call", onAction = { nav.navigate(Routes.NEW_CHAT + "?mode=call") },
                    )
                }
            }
            items(log, key = { it.callId }) { e ->
                val conv = byId[e.conversationId]
                val missed = CallLogText.missed(e)
                val name = conv?.let { ConversationRepository.title(it, me) } ?: e.peerName ?: "Call"
                ListCard(
                    name, Modifier.padding(horizontal = 8.dp),
                    leading = {
                        if (conv != null) ConversationAvatar(conv, me, size = 48.dp)
                        else com.meldiq.android.ui.components.Avatar(name, name.hashCode(), size = 48.dp)
                    },
                    subtitleContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                when {
                                    missed -> Icons.AutoMirrored.Rounded.CallMissed
                                    e.outgoing -> Icons.AutoMirrored.Rounded.CallMade
                                    else -> Icons.AutoMirrored.Rounded.CallReceived
                                },
                                null, tint = if (missed) c.danger else c.textSecondary, modifier = Modifier.size(15.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(CallLogText.detail(e), style = Griip.type.bodySmall, color = if (missed) c.danger else c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    trailing = {
                        CircleIconButton(
                            if (e.video) Icons.Rounded.Videocam else Icons.Rounded.Call,
                            if (e.video) "Video call $name" else "Voice call $name",
                            { callBack(e.conversationId, e.video) },
                            // An older call in a text channel can't be called back: text channels have no calls (round 7).
                            tint = c.primary, enabled = idle && conv != null && !conv.removed && (conv.type != "CHANNEL" || conv.voice),
                        )
                    },
                    onClick = { if (conv != null) nav.navigate(Routes.conversation(conv.id)) },
                )
            }
        }
        ExtendedFloatingActionButton(
            onClick = { nav.navigate(Routes.NEW_CHAT + "?mode=call") },
            icon = { Icon(Icons.Rounded.AddIcCall, null) },
            text = { Text("New call", style = Griip.type.button) },
            containerColor = c.actionStart, contentColor = c.onAction,
            modifier = Modifier.align(Alignment.BottomEnd).padding(Space.gutter).navigationBarsPadding(),
        )
    }
}

