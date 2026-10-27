package com.meldiq.android.data.model

/**
 * Batch B5 (Discord reference CHAT-MSG-004 "Copy Message Link"): a link to one message, `https://web.meldiq.app/m/CONV/MSG`
 * (also `meldiq://m/CONV/MSG`). It carries only ids, never content: it opens on a phone that is in the conversation and
 * has the message, and says so otherwise. Nobody else learns anything from it.
 */
object MessageLinks {
    /** As Meldiq Web (2026-10-28): the web app opens it in a browser; older meldiq.app links are still recognised. */
    private const val HOST = "web.meldiq.app"
    private const val ID = "[A-Za-z0-9_-]{1,128}"
    private val LINK = Regex("""^(?:https://(?:www\.|web\.)?meldiq\.app/m/|meldiq://m/)($ID)/($ID)/?$""", RegexOption.IGNORE_CASE)

    data class Target(val conversationId: String, val messageId: String)

    fun link(conversationId: String, messageId: String) = "https://$HOST/m/$conversationId/$messageId"

    /** The conversation and message a link points to, or null when [url] isn't a message link. */
    fun parse(url: String): Target? = LINK.matchEntire(url.trim())?.let { Target(it.groupValues[1], it.groupValues[2]) }

    /** Only messages the server has (sent, not pending or failed) and that still exist get a link. */
    fun canLink(deleted: Boolean, status: String): Boolean = !deleted && status != MessageStatus.SENDING && status != MessageStatus.FAILED
}
