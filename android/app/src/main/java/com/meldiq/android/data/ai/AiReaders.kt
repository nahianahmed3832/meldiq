package com.meldiq.android.data.ai

import kotlinx.serialization.Serializable

/**
 * AI agents reading a conversation (server docs/AI_WORKFORCE_2_PLAN.md phase 5, API 0.40.0). A reader is an agent's
 * server-held device in one conversation; each member chooses whether their own messages are encrypted to it ("share")
 * or not ("keep"). No choice yet counts as keep. A direct conversation with an agent is the person's choice to share.
 */
@Serializable
data class AiReaderView(
    val readerId: String,
    val orgId: String,
    val installId: String,
    val agentUserId: String = "",
    val name: String,
    val conversationId: String,
    val conversationName: String? = null,
    /** channel · direct */
    val mode: String,
    val state: String = "on",
    val since: Long = 0,
    val turnedOnBy: AiPerson? = null,
    val reason: String = "",
    /** This person's choice here: share, keep, or null (not chosen; treated as keep). */
    val myChoice: String? = null,
) {
    val direct get() = mode == "direct"
}

@Serializable
data class AiConversationReaders(val readingEnabled: Boolean = false, val readers: List<AiReaderView> = emptyList()) {
    /** Readers this person sees (none while the platform has reading off). */
    val active get() = if (readingEnabled) readers else emptyList()

    /** A channel reader this person hasn't chosen for yet: the composer waits for the choice. */
    val pending get() = active.filter { !it.direct && it.myChoice == null }

    val direct get() = active.firstOrNull { it.direct }

    /** Readers this person shares their messages with here. */
    val sharingReaders get() = active.filter { it.myChoice == "share" }.map { it.readerId }.toSet()

    /** Agents (install ids) this person shares with here: "@Agent …" then goes as an ordinary message, which it reads. */
    val sharingAgents get() = active.filter { it.myChoice == "share" }.map { it.installId }.toSet()
}

@Serializable
data class AiChoiceReq(val choice: String)

@Serializable
data class AiInstallReaders(val readingEnabled: Boolean = false, val readers: List<AiReaderView> = emptyList())

@Serializable
data class AiReaderRes(val reader: AiReaderView)

@Serializable
data class AiReadersRes(val readers: List<AiReaderView> = emptyList())

@Serializable
data class AiReaderOnReq(val conversationId: String, val reason: String)

@Serializable
data class AiReadScopeReq(val scope: String, val reason: String)

@Serializable
data class AiReasonReq(val reason: String)

@Serializable
data class AiDirectRes(val conversationId: String, val reader: AiReaderView)

/** Which outgoing messages a reader may get: text messages and their edits and deletes, never calls, reactions or the rest. */
object ReaderRules {
    fun shareable(cls: String, type: String?): Boolean = (cls == "message" && type == "text") || (cls == "control" && (type == "edit" || type == "delete"))

    /** The reader devices a message goes to: only readers this person chose to share with. */
    fun <T> pick(readers: List<T>, readerIdOf: (T) -> String, choices: AiConversationReaders): List<T> {
        val sharing = choices.sharingReaders
        return readers.filter { readerIdOf(it) in sharing }
    }
}
