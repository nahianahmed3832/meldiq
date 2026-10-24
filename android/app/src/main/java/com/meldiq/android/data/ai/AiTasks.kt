package com.meldiq.android.data.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Tasks for people (server docs/AI_WORKFORCE_2_PLAN.md phase 4, API 0.39.0): work the Agent Manager or an admin gives
 * someone, accepted, worked and handed in, then accepted or sent back by someone else. The server says which actions
 * this person may take on each task ([AiTaskActions]); the app shows only those. Tasks aren't end-to-end encrypted.
 */
@Serializable
data class AiPerson(val id: String, val name: String)

@Serializable
data class AiTaskAgent(val installId: String, val name: String)

@Serializable
data class AiTaskSummary(
    val id: String,
    val title: String,
    val state: String,
    val priority: String = "normal",
    val overdue: Boolean = false,
    val dueAt: Long? = null,
    val assignee: AiPerson,
    val createdBy: AiPerson,
    val agent: AiTaskAgent? = null,
    val jobId: String? = null,
    val updatedAt: Long = 0,
)

/** What this person may do with a task now, as the server decides. */
@Serializable
data class AiTaskActions(
    val accept: Boolean = false,
    val start: Boolean = false,
    val block: Boolean = false,
    val submit: Boolean = false,
    val approve: Boolean = false,
    val `return`: Boolean = false,
    val cancel: Boolean = false,
    val reassign: Boolean = false,
) {
    fun allowed(): List<String> = buildList {
        if (accept) add(AiTaskStates.ACCEPT)
        if (start) add(AiTaskStates.START)
        if (block) add(AiTaskStates.BLOCK)
        if (submit) add(AiTaskStates.SUBMIT)
        if (approve) add(AiTaskStates.APPROVE)
        if (`return`) add(AiTaskStates.RETURN)
        if (cancel) add(AiTaskStates.CANCEL)
        if (reassign) add(AiTaskStates.REASSIGN)
    }
}

@Serializable
data class AiTask(
    val id: String,
    val title: String,
    val state: String,
    val priority: String = "normal",
    val overdue: Boolean = false,
    val dueAt: Long? = null,
    val assignee: AiPerson,
    val createdBy: AiPerson,
    val agent: AiTaskAgent? = null,
    val jobId: String? = null,
    val updatedAt: Long = 0,
    val instructions: String = "",
    val deliverables: String = "",
    val conversationId: String? = null,
    val blockedReason: String? = null,
    val submissionNote: String? = null,
    val returnReason: String? = null,
    val cancelReason: String? = null,
    val rev: Int,
    val createdAt: Long = 0,
    val submittedAt: Long? = null,
    val doneAt: Long? = null,
    val doneBy: AiPerson? = null,
    val files: List<AiFile> = emptyList(),
    val references: List<AiFile> = emptyList(),
    val can: AiTaskActions = AiTaskActions(),
)

@Serializable
data class AiTaskEvent(val at: Long, val actor: AiPerson? = null, val kind: String, val detail: JsonObject = JsonObject(emptyMap()))

@Serializable
data class AiAssigneeLoad(val person: AiPerson, val active: Int = 0, val overdue: Int = 0)

@Serializable
data class AiTaskReport(val byState: Map<String, Int> = emptyMap(), val overdue: Int = 0, val byAssignee: List<AiAssigneeLoad> = emptyList())

@Serializable
data class AiTasksPage(val tasks: List<AiTaskSummary> = emptyList(), val next: Long? = null, val report: AiTaskReport? = null)

@Serializable
data class AiTaskRes(val task: AiTask, val events: List<AiTaskEvent> = emptyList())

@Serializable
data class AiEligible(val id: String, val name: String, val roles: List<String> = emptyList())

@Serializable
data class AiTaskSettings(val roles: List<String> = emptyList(), val users: List<String> = emptyList(), val updatedAt: Long? = null, val eligible: List<AiEligible> = emptyList())

@Serializable
data class AiTaskSettingsRes(val settings: AiTaskSettings)

@Serializable
data class AiTaskSettingsReq(val roles: List<String>, val users: List<String>)

@Serializable
data class AiNewTask(
    val title: String,
    val instructions: String,
    val deliverables: String,
    val assigneeId: String,
    val dueAt: Long? = null,
    val priority: String = "normal",
    val conversationId: String? = null,
)

/** A change to a task: the version it was read at, and what that change needs (a reason, a note, files, a person). */
@Serializable
data class AiTaskActionReq(
    val rev: Int,
    val reason: String? = null,
    val note: String? = null,
    val fileIds: List<String>? = null,
    val assigneeId: String? = null,
)

object AiTaskStates {
    val ALL = listOf("waiting", "open", "accepted", "in_progress", "blocked", "submitted", "done", "cancelled")
    val PRIORITIES = listOf("low", "normal", "high", "urgent")

    const val ACCEPT = "accept"
    const val START = "start"
    const val BLOCK = "block"
    const val SUBMIT = "submit"
    const val APPROVE = "approve"
    const val RETURN = "return"
    const val CANCEL = "cancel"
    const val REASSIGN = "reassign"

    /** Actions that ask for something first: a reason, a note or files, a person. */
    fun needsForm(action: String) = action in setOf(SUBMIT, BLOCK, RETURN, CANCEL, REASSIGN)

    /** Whether the form for [action] can be sent with [text], [files] and [assignee]. */
    fun formReady(action: String, text: String, files: Int, assignee: String?) = when (action) {
        REASSIGN -> !assignee.isNullOrBlank()
        BLOCK, RETURN -> text.isNotBlank()
        SUBMIT -> text.isNotBlank() || files > 0
        else -> true
    }

    /** The request body for [action] on [task]. */
    fun body(task: AiTask, action: String, text: String, fileIds: List<String>, assignee: String?) = AiTaskActionReq(
        rev = task.rev,
        note = text.trim().takeIf { action == SUBMIT && it.isNotEmpty() },
        fileIds = fileIds.takeIf { action == SUBMIT },
        reason = text.trim().takeIf { action in setOf(BLOCK, RETURN, CANCEL) && it.isNotEmpty() },
        assigneeId = assignee.takeIf { action == REASSIGN },
    )
}
