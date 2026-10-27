package com.meldiq.android.data.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Every frame the server sends on `/v1/ws`, one subtype per `t` (the server's `ServerEvent` union in
 * `server/src/shared/contracts/realtime.ts`, published as `docs/api/realtime.schema.json`). Frames are parsed only in
 * [RealtimeCodec]; a `t` this app doesn't know becomes [Unknown] and is ignored, never an error.
 *
 * Defaults keep what the app did with its old all-nullable frame: a field older servers may leave out reads as
 * absent or false instead of failing the frame.
 */
sealed interface ServerEvent {
    @Serializable data class Hello(val userId: String? = null, val deviceId: String? = null, val serverTime: Long? = null) : ServerEvent
    @Serializable data class Pong(val serverTime: Long? = null) : ServerEvent

    /** Live items (`backlog` false) or a backlog batch after connecting, acknowledged with `backlog: true`. */
    @Serializable data class Queue(val items: List<QueueItem> = emptyList(), val more: Boolean = false, val backlog: Boolean = false) : ServerEvent
    data object QueueDrained : ServerEvent

    @Serializable data class Typing(val c: String, val u: String, val on: Boolean = false) : ServerEvent

    /** [presence]: "online", "idle", "dnd" or "offline" (servers with `presence-modes`). */
    @Serializable data class Presence(
        val userId: String, val online: Boolean = false, val presence: String? = null, val lastSeenAt: Long? = null,
    ) : ServerEvent

    /**
     * A call changed. [event] is one of [CallEvents] (unknown names are passed on and ignored by the call manager).
     * `ring` names the caller in [from]; `declined` says who in [userId] and why in [reason]; `moderated` (voice rooms)
     * says what a manager did to you in [action]: "mute", "lower_hand" or "remove".
     */
    @Serializable data class Call(
        val event: String = "",
        val call: CallDto,
        val from: CallCaller? = null,
        val userId: String? = null,
        val reason: String? = null,
        val action: String? = null,
    ) : ServerEvent

    @Serializable data class ConvUpdated(val conversationId: String) : ServerEvent
    @Serializable data class OrgUpdated(val orgId: String) : ServerEvent
    /** 2026-10-17: an owner deleted the community (older servers only send [OrgUpdated]). */
    @Serializable data class OrgDeleted(val orgId: String) : ServerEvent
    /** Moderators: the number of open reports changed. */
    @Serializable data class OrgReports(val orgId: String, val open: Int = 0) : ServerEvent
    /** Approvers: join applications changed. */
    @Serializable data class OrgApplications(val orgId: String) : ServerEvent
    /** The applicant: their application was decided ("approved" or "denied"). */
    @Serializable data class OrgApplication(val orgId: String, val status: String? = null) : ServerEvent
    /** Safety moderators: an activity alert (a burst of joins). */
    @Serializable data class OrgAlert(val orgId: String, val kind: String? = null, val count: Int = 0, val at: Long? = null) : ServerEvent
    /** Someone's devices changed: refresh their keys before encrypting to them. */
    @Serializable data class DevicesChanged(val userId: String) : ServerEvent
    /**
     * Someone's profile changed (name, status, photo, privacy), or one of your own account settings did: fetch it again.
     * Server 0.28.0 and later; older servers never send it.
     */
    @Serializable data class UserUpdated(val userId: String) : ServerEvent
    /** Batch B6: a connection request, acceptance or removal involving you. */
    data object ConnectionsUpdated : ServerEvent
    /** Which workspace's personal preferences changed on another device of this person. */
    @Serializable data class PrefsUpdated(val workspaceId: String, val rev: Int? = null) : ServerEvent
    /** docs/REMINDERS.md. */
    @Serializable data class RemindersChanged(val id: String, val rev: Int? = null, val deleted: Boolean = false) : ServerEvent
    @Serializable data class ReminderDue(val id: String, val occurrenceAt: Long? = null, val firedAt: Long? = null) : ServerEvent
    /** Round 7 meetings (docs/WORKSPACE_C5.md). */
    @Serializable data class MeetingUpdated(val orgId: String, val meetingId: String? = null, val startsAt: Long? = null) : ServerEvent
    @Serializable data class MeetingSoon(val orgId: String? = null, val meetingId: String, val startsAt: Long? = null) : ServerEvent

    /** A frame this app version doesn't know (a newer server). Ignored. */
    data class Unknown(val t: String) : ServerEvent
}

/** `ring`: who is calling. */
@Serializable data class CallCaller(val userId: String, val displayName: String = "")

/** The call event names the server sends (`CallEventName` plus voice rooms' `moderated`). */
object CallEvents {
    const val RING = "ring"
    const val STARTED = "started"
    const val UPDATED = "updated"
    const val ENDED = "ended"
    const val DECLINED = "declined"
    const val DISMISSED = "dismissed"
    const val ALERTED = "alerted"
    const val MODERATED = "moderated"
}

/** Every frame this app sends (the server's `ClientEvent` union). `auth` is browser-only: the app sends a header. */
@Serializable
sealed interface ClientEvent {
    @Serializable @SerialName("ping") data object Ping : ClientEvent

    /** Acknowledge queue items; `backlog: true` asks for the next backlog batch. */
    @Serializable @SerialName("ack") data class Ack(val ids: List<Long>, val backlog: Boolean) : ClientEvent

    @Serializable @SerialName("typing") data class Typing(val c: String, val on: Boolean) : ClientEvent
}

/** The one place realtime frames are parsed and built. */
object RealtimeCodec {
    private val wire = Json(GriipJson) { classDiscriminator = "t" }

    private val serializers: Map<String, KSerializer<out ServerEvent>> = mapOf(
        "hello" to ServerEvent.Hello.serializer(),
        "pong" to ServerEvent.Pong.serializer(),
        "queue" to ServerEvent.Queue.serializer(),
        "typing" to ServerEvent.Typing.serializer(),
        "presence" to ServerEvent.Presence.serializer(),
        "call" to ServerEvent.Call.serializer(),
        "conv.updated" to ServerEvent.ConvUpdated.serializer(),
        "org.updated" to ServerEvent.OrgUpdated.serializer(),
        "org.deleted" to ServerEvent.OrgDeleted.serializer(),
        "org.reports" to ServerEvent.OrgReports.serializer(),
        "org.applications" to ServerEvent.OrgApplications.serializer(),
        "org.application" to ServerEvent.OrgApplication.serializer(),
        "org.alert" to ServerEvent.OrgAlert.serializer(),
        "devices.changed" to ServerEvent.DevicesChanged.serializer(),
        "user.updated" to ServerEvent.UserUpdated.serializer(),
        "prefs.updated" to ServerEvent.PrefsUpdated.serializer(),
        "reminders.changed" to ServerEvent.RemindersChanged.serializer(),
        "reminder.due" to ServerEvent.ReminderDue.serializer(),
        "meeting.updated" to ServerEvent.MeetingUpdated.serializer(),
        "meeting.soon" to ServerEvent.MeetingSoon.serializer(),
    )
    private val fieldless: Map<String, ServerEvent> = mapOf(
        "queue.drained" to ServerEvent.QueueDrained,
        "connections.updated" to ServerEvent.ConnectionsUpdated,
    )

    /** Every `t` this app understands. */
    val knownTypes: Set<String> = serializers.keys + fieldless.keys

    /**
     * The frame as a typed event; [ServerEvent.Unknown] for a `t` this app doesn't know. Throws
     * [MalformedFrame] for text that isn't a frame or a known frame missing what it needs.
     */
    fun decode(text: String): ServerEvent {
        val obj = runCatching { GriipJson.parseToJsonElement(text).jsonObject }.getOrElse { throw MalformedFrame(null, it) }
        val t = typeOf(obj) ?: throw MalformedFrame(null, null)
        fieldless[t]?.let { return it }
        val ser = serializers[t] ?: return ServerEvent.Unknown(t)
        return runCatching { GriipJson.decodeFromJsonElement(ser, obj) }.getOrElse { throw MalformedFrame(t, it) }
    }

    /** The model a known `t` decodes into (null for frames without fields and unknown ones). */
    fun serializerFor(t: String): KSerializer<out ServerEvent>? = serializers[t]

    fun encode(event: ClientEvent): String = wire.encodeToString(ClientEvent.serializer(), event)

    private fun typeOf(obj: JsonObject): String? = runCatching { obj["t"]?.jsonPrimitive?.contentOrNull }.getOrNull()
}

/** A frame that couldn't be read: [t] is its type when that much was readable. Logged and skipped. */
class MalformedFrame(val t: String?, cause: Throwable?) : Exception("malformed realtime frame ${t ?: "(no type)"}", cause)
