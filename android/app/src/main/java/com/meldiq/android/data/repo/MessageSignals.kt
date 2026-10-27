package com.meldiq.android.data.repo

import com.meldiq.android.data.api.ServerEvent
import com.meldiq.android.data.db.GriipDatabase
import com.meldiq.android.data.model.PresenceRules
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * Receiving, part 1: what the socket says besides queue items (typing, presence, calls, community and reminder
 * changes), as flows the screens and managers collect. [MessageReceiver] handles the queue items themselves.
 */
class MessageSignals(
    private val db: GriipDatabase,
    private val conversations: ConversationRepository,
    private val directory: KeyDirectory,
    private val users: UserRepository,
    private val myUserId: () -> String?,
) {
    private val _typing = MutableStateFlow<Map<String, Map<String, Long>>>(emptyMap())
    val typing: StateFlow<Map<String, Map<String, Long>>> = _typing
    private val _callInvites = MutableSharedFlow<IncomingCallKey>(extraBufferCapacity = 16)
    val callInvites: SharedFlow<IncomingCallKey> = _callInvites
    private val _callFrames = MutableSharedFlow<ServerEvent.Call>(extraBufferCapacity = 32)
    val callFrames: SharedFlow<ServerEvent.Call> = _callFrames
    private val _orgEvents = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** Round 7: a meeting starting in ten minutes (its id), and a workspace whose meetings changed (its id). */
    private val _meetingSoon = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val meetingSoon: SharedFlow<String> = _meetingSoon
    private val _meetingUpdates = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val meetingUpdates: SharedFlow<String> = _meetingUpdates
    val orgEvents: SharedFlow<String> = _orgEvents
    private val _connectionsChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** Batch B6: someone sent, accepted, cancelled or removed a connection with you (screens reload their lists). */
    val connectionsChanged: SharedFlow<Unit> = _connectionsChanged
    private val _orgDeleted = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val orgDeleted: SharedFlow<String> = _orgDeleted
    private val _reminderEvents = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** Reminders that went off or changed on another device ("reminder.due", "reminders.changed"): their ids. */
    val reminderEvents: SharedFlow<String> = _reminderEvents
    private val _prefsUpdated = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** Workspaces whose personal preferences another device of this person changed ("prefs.updated"). */
    val prefsUpdated: SharedFlow<String> = _prefsUpdated
    val backlogDrained = MutableStateFlow(false)

    private val _userUpdates = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** Your own profile or account settings changed on another device (your id): screens showing them reload. */
    val ownAccountUpdates: SharedFlow<String> = _userUpdates

    /** A call's media key arrived from someone else (the receiver opened it). */
    internal fun emitCallInvite(key: IncomingCallKey) {
        _callInvites.tryEmit(key)
    }

    /** Forgets typing indicators that weren't renewed in time. */
    fun pruneTyping(now: Long = System.currentTimeMillis()) {
        _typing.update { m -> m.mapValues { (_, u) -> u.filterValues { it > now } }.filterValues { it.isNotEmpty() } }
    }

    /** Routes one event; queue batches go to [queue] (the receiver), which acknowledges them. */
    suspend fun handle(e: ServerEvent, queue: suspend (ServerEvent.Queue) -> Unit) {
        when (e) {
            is ServerEvent.Queue -> queue(e)
            ServerEvent.QueueDrained -> backlogDrained.value = true
            is ServerEvent.Typing -> _typing.update { m ->
                val cur = m[e.c].orEmpty().toMutableMap()
                if (e.on) cur[e.u] = System.currentTimeMillis() + 6000 else cur.remove(e.u)
                m + (e.c to cur)
            }
            is ServerEvent.Presence -> db.users().setPresence(e.userId, e.online, e.lastSeenAt, PresenceRules.stored(e.presence))
            is ServerEvent.ConvUpdated -> conversations.refreshOne(e.conversationId)
            is ServerEvent.OrgUpdated -> {
                _orgEvents.tryEmit(e.orgId)
                runCatching { conversations.refresh() }
            }
            is ServerEvent.OrgDeleted -> {
                _orgDeleted.tryEmit(e.orgId)
                _orgEvents.tryEmit(e.orgId)
            }
            is ServerEvent.DevicesChanged -> directory.invalidateUser(e.userId)
            // Live profile changes: names, photos and statuses everywhere read the refreshed rows; a DM's title comes
            // from its conversation, so the list is reloaded too.
            is ServerEvent.UserUpdated -> {
                runCatching { users.fetch(e.userId) }
                if (e.userId == myUserId()) _userUpdates.tryEmit(e.userId) else runCatching { conversations.refresh() }
            }
            ServerEvent.ConnectionsUpdated -> _connectionsChanged.tryEmit(Unit)
            is ServerEvent.PrefsUpdated -> _prefsUpdated.tryEmit(e.workspaceId)
            is ServerEvent.ReminderDue -> _reminderEvents.tryEmit(e.id)
            is ServerEvent.RemindersChanged -> _reminderEvents.tryEmit(e.id)
            is ServerEvent.MeetingSoon -> _meetingSoon.tryEmit(e.meetingId)
            is ServerEvent.MeetingUpdated -> _meetingUpdates.tryEmit(e.orgId)
            is ServerEvent.Call -> _callFrames.tryEmit(e)
            // Moderator and applicant signals: the screens that show them reload when opened.
            is ServerEvent.OrgReports, is ServerEvent.OrgApplications, is ServerEvent.OrgApplication, is ServerEvent.OrgAlert -> Unit
            // The socket's own bookkeeping, and frames from a newer server.
            is ServerEvent.Hello, is ServerEvent.Pong, is ServerEvent.Unknown -> Unit
        }
    }
}
