package com.meldiq.android.data.ai

import com.meldiq.android.data.db.MessageEntity
import java.text.Normalizer

/**
 * The AI Workforce rules the app applies before the server does (as Meldiq Web's `sync/agentRules.ts`). Unit-tested
 * in `AgentRulesTest`.
 */
object AgentRules {
    /** How many recent channel messages a request can share (server `AI_SHARED_MAX`, `AI_SHARED_CHARS`, per message). */
    val SHARE_CHOICES = listOf(20, 50, 150)
    const val SHARE_MAX = 150
    const val SHARE_CHARS = 30_000
    const val SHARE_MESSAGE_CHARS = 2_000
    private const val AUTHOR_CHARS = 80

    /** The brief, as the server takes it. */
    const val BRIEF_MAX = 8_000

    /** "Reel Maker" → "reel-maker": how an agent set to "command" is asked (`/reel-maker …`). */
    fun commandName(displayName: String): String =
        Normalizer.normalize(displayName, Normalizer.Form.NFKD)
            .replace(Regex("\\p{M}+"), "")
            .lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')

    data class Invocation(val installId: String, val displayName: String, val brief: String, val canInvoke: Boolean)

    /** What may follow a name: the end, a space or punctuation. */
    private const val NAME_END = "(?=\$|[\\s,:;.!?])"

    /**
     * Where [t] calls [a], by the server's rule (server `src/modules/workforce/invocation.ts`, tested against the shared
     * cases in `shared/contracts/fixtures/rules/agent-invocation.json`): "@Name" anywhere, at the start or after a
     * space, ending where the name ends ("@Reel Maker2" isn't "@Reel Maker"), for agents activated by mention; "/name"
     * (or the name without its dashes) at the start only, for agents activated by mention or command.
     */
    private fun callIn(t: String, a: AiChannelAgent): IntRange? {
        if (a.activation != "mention" && a.activation != "command") return null
        val slug = commandName(a.displayName)
        if (slug.isNotEmpty()) {
            Regex("^/(${slug}|${slug.replace("-", "")})$NAME_END", RegexOption.IGNORE_CASE).find(t)?.let { return it.range }
        }
        if (a.activation != "mention" || a.displayName.isBlank()) return null
        val m = Regex("(^|\\s)@${Regex.escape(a.displayName)}$NAME_END", RegexOption.IGNORE_CASE).find(t) ?: return null
        return (m.range.first + m.groupValues[1].length)..m.range.last
    }

    /**
     * The agent [text] asks and what it asks (the text without the call: "fix this @Agent?" → "fix this?"), or null for
     * an ordinary message or a call with nothing asked. The longest matching name wins. Such a message isn't sent as an
     * encrypted message: mentions live inside the encryption, so the server could never see them. The app opens the
     * request, with its notice, instead.
     */
    fun invocation(text: String, agents: List<AiChannelAgent>): Invocation? {
        val t = text.trim()
        var best: Pair<AiChannelAgent, IntRange>? = null
        for (a in agents) {
            val at = callIn(t, a) ?: continue
            if (best == null || at.count() > best.second.count()) best = a to at
        }
        val (agent, at) = best ?: return null
        val before = t.substring(0, at.first).trimEnd()
        val after = t.substring(at.last + 1)
        val brief = (if (before.isNotEmpty()) before + after else after.replace(Regex("^[\\s,:;]+"), "")).trim()
        if (brief.isEmpty()) return null
        return Invocation(agent.id, agent.displayName, brief, agent.canInvoke)
    }

    /**
     * The newest readable messages of a channel, oldest first, as this phone decrypted them, within the server's limits:
     * what a request shares when the person picks a number. Deleted, call, system and undecryptable messages and
     * thread replies are left out. [messages] may be in any order.
     */
    fun messagesToShare(messages: List<MessageEntity>, nameOf: (String) -> String, count: Int): List<AiSharedMessage> {
        if (count <= 0) return emptyList()
        val picked = ArrayList<AiSharedMessage>()
        var chars = 0
        for (m in messages.sortedByDescending { it.sortTs }) {
            if (picked.size >= minOf(count, SHARE_MAX)) break
            val text = m.text.trim().take(SHARE_MESSAGE_CHARS)
            if (m.kind != "text" || m.deleted || m.threadRootId != null || text.isEmpty()) continue
            val author = nameOf(m.senderUserId).take(AUTHOR_CHARS).trim().ifEmpty { "?" }
            val cost = text.length + author.length + 2
            if (chars + cost > SHARE_CHARS) break
            chars += cost
            picked += AiSharedMessage(author, text, m.sortTs)
        }
        return picked.reversed()
    }

    /** The share choices worth offering for [available] messages: 20, then each larger one only if more exist. */
    fun shareChoices(available: Int): List<Int> = SHARE_CHOICES.filterIndexed { i, _ -> i == 0 || SHARE_CHOICES[i - 1] < available }

    /** A MIME type from a file name, for files Android didn't type (subtitles, code, data). Text is sent as plain text. */
    fun mimeOf(name: String, given: String?): String {
        if (!given.isNullOrBlank() && given != "application/octet-stream") return given
        return when (name.substringAfterLast('.', "").lowercase()) {
            "md" -> "text/markdown"
            "csv" -> "text/csv"
            "json" -> "application/json"
            "html", "htm" -> "text/html"
            "srt" -> "application/x-subrip"
            "vtt" -> "text/vtt"
            "mp4" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "video/webm"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "m4a" -> "audio/mp4"
            "ogg" -> "audio/ogg"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            else -> "text/plain"
        }
    }

    data class PickedFile(val name: String, val mime: String, val size: Long)

    /** Why [files] can't go to an agent with [limits] (count, kinds, sizes), or null when they can. */
    sealed interface FileProblem {
        data class TooMany(val max: Int) : FileProblem
        data class TooFew(val min: Int, val types: List<String>) : FileProblem
        data class WrongKind(val name: String) : FileProblem
        data class TooLarge(val name: String) : FileProblem
    }

    fun fileProblem(files: List<PickedFile>, limits: AiFileLimits?): FileProblem? {
        if (limits == null) return null
        if (files.size > limits.max) return FileProblem.TooMany(limits.max)
        if (files.size < limits.min) return FileProblem.TooFew(limits.min, limits.types.take(4))
        files.firstOrNull { limits.types.isNotEmpty() && it.mime !in limits.types }?.let { return FileProblem.WrongKind(it.name) }
        files.firstOrNull { limits.maxBytes > 0 && it.size > limits.maxBytes }?.let { return FileProblem.TooLarge(it.name) }
        return null
    }

    /** Deliverables a job shows: current versions first; replaced ones are listed apart. */
    fun currentFiles(files: List<AiFile>) = files.filter { it.role == "artifact" && it.approvalState != "superseded" }
    fun replacedFiles(files: List<AiFile>) = files.filter { it.role == "artifact" && it.approvalState == "superseded" }

    /** The approval waiting on a job, if any. */
    fun pendingApproval(job: AiJobDetail): AiApproval? = job.approvals.firstOrNull { it.state == "pending" }

    /**
     * Who may steer a job (cancel, retry, answer, ask for changes): who asked, and people who manage agents. Who may
     * approve: approvers, and who asked (for internal actions of their own request; the server decides which).
     */
    fun maySteer(job: AiJobDetail, me: String?, perms: AiPermissions) = job.requestedBy == me || perms.canManage
    fun mayApprove(job: AiJobDetail, me: String?, perms: AiPermissions) = perms.canApprove || job.requestedBy == me

    /** An agent's "#RRGGBB" colour as an ARGB value, or null when it isn't one. */
    fun hexColor(hex: String?): Long? = hex?.takeIf { Regex("^#[0-9A-Fa-f]{6}$").matches(it) }?.let { 0xFF000000 or it.substring(1).toLong(16) }
}

/**
 * AI agents in a conversation's chat, like bots (as Meldiq Web's AgentChat): their posts and the requests to them sit
 * among the messages in time order. Unit-tested in `AgentTimelineTest`.
 */
object AgentTimeline {
    sealed interface Entry {
        val key: String
        val at: Long
        data class Msg(val m: MessageEntity) : Entry {
            override val key get() = m.id
            override val at get() = m.sortTs
        }
        data class Post(val p: AiPost) : Entry {
            override val key get() = "x-" + p.id
            override val at get() = p.createdAt
        }
    }

    /** A progress note is dropped once its request has an answer (result, error or approval): it reads as question and answer. */
    fun chatPosts(posts: List<AiPost>): List<AiPost> {
        val answered = posts.filter { it.jobId != null && it.kind in setOf("result", "error", "approval") }.mapNotNull { it.jobId }.toSet()
        return posts.filterNot { it.kind == "progress" && it.jobId != null && it.jobId in answered }
    }

    /** [newestFirst] messages (as the list shows them) with [posts] merged in by time, newest first; messages keep their order. */
    fun merge(newestFirst: List<MessageEntity>, posts: List<AiPost>): List<Entry> {
        val msgs = newestFirst.map { Entry.Msg(it) }
        if (posts.isEmpty()) return msgs
        // Only posts from the loaded stretch: older ones wait until older messages are loaded (a long list stays in order).
        val oldest = newestFirst.lastOrNull()?.sortTs ?: Long.MIN_VALUE
        val extra = chatPosts(posts).filter { newestFirst.isEmpty() || it.createdAt >= oldest }.sortedByDescending { it.createdAt }.map { Entry.Post(it) }
        val out = ArrayList<Entry>(msgs.size + extra.size)
        var i = 0
        var j = 0
        while (i < msgs.size || j < extra.size) {
            out += when {
                j >= extra.size -> msgs[i++]
                i >= msgs.size -> extra[j++]
                extra[j].at > msgs[i].at -> extra[j++]
                else -> msgs[i++]
            }
        }
        return out
    }

    fun indexOfMessage(entries: List<Entry>, id: String) = entries.indexOfFirst { it is Entry.Msg && it.m.id == id }

    data class Suggest(val start: Int, val command: Boolean, val agents: List<AiChannelAgent>)

    /**
     * Agents to suggest while typing: after "@" (by name), or, as commands, after a leading "/". [cursor] is the caret.
     * Only agents this person may ask.
     */
    fun suggest(text: String, cursor: Int, agents: List<AiChannelAgent>): Suggest? {
        val usable = agents.filter { it.canInvoke }
        if (usable.isEmpty() || cursor < 1 || cursor > text.length) return null
        val before = text.substring(0, cursor)
        Regex("^/([a-z0-9-]*)$", RegexOption.IGNORE_CASE).find(before)?.let { m ->
            val q = m.groupValues[1].lowercase()
            return usable.filter { AgentRules.commandName(it.displayName).startsWith(q) }.take(8).takeIf { it.isNotEmpty() }?.let { Suggest(0, true, it) }
        }
        val at = before.lastIndexOf('@')
        if (at < 0 || (at > 0 && !before[at - 1].isWhitespace())) return null
        val q = before.substring(at + 1)
        if (q.contains('\n') || q.length > 40) return null
        return usable.filter { it.displayName.startsWith(q, ignoreCase = true) || AgentRules.commandName(it.displayName).startsWith(q.lowercase()) }
            .take(8).takeIf { it.isNotEmpty() }?.let { Suggest(at, false, it) }
    }

    /** [text] with the suggestion at [s] replaced by [agent]'s mention or command; the caret goes after it. */
    fun insert(text: String, cursor: Int, s: Suggest, agent: AiChannelAgent): Pair<String, Int> {
        val token = if (s.command) "/" + AgentRules.commandName(agent.displayName) else "@" + agent.displayName
        val next = text.substring(0, s.start) + token + " " + text.substring(cursor)
        return next to s.start + token.length + 1
    }
}
