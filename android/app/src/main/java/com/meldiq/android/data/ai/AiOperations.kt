package com.meldiq.android.data.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * How an agent works on its own (server docs/AI_WORKFORCE.md §5b, API 0.36.0): its autonomy, readiness checks, recent
 * activity and triggers. The server enforces all of it; choosing more autonomy never grants a tool or a channel.
 */
object AiAutonomy {
    const val MANUAL = "manual"
    const val ASSISTED = "assisted"
    const val GUARDED = "guarded"
    const val CONTINUOUS = "continuous"
    val ALL = listOf(MANUAL, ASSISTED, GUARDED, CONTINUOUS)
}

@Serializable
data class AiCheck(val key: String, val label: String, val status: String, val detail: String = "", val fixBy: String? = null) {
    val ok get() = status == "ok"
    val missing get() = status == "missing"
}

@Serializable
data class AiReadiness(val ready: Boolean = false, val checks: List<AiCheck> = emptyList()) {
    val missingCount get() = checks.count { it.missing }

    /** The checks whose key starts with one of [prefixes] (e.g. "model." for the models step). */
    fun only(vararg prefixes: String) = checks.filter { c -> prefixes.any { c.key.startsWith(it) } }
}

@Serializable
data class AiReadinessRes(val readiness: AiReadiness)

@Serializable
data class AiTrigger(
    val id: String,
    val installId: String,
    /** schedule · webhook · after_agent */
    val kind: String,
    val enabled: Boolean = true,
    val label: String,
    val brief: String = "",
    val conversationId: String? = null,
    val config: JsonElement? = null,
    val sourceInstallId: String? = null,
    val runAs: String = "",
    val nextRunAt: Long? = null,
    val lastFiredAt: Long? = null,
    val lastJobId: String? = null,
    val lastError: String? = null,
    val failures: Int = 0,
    val rev: Int,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

@Serializable
data class AiNow(val running: Int = 0, val queued: Int = 0, val waiting: Int = 0)

@Serializable
data class AiWeek(val completed: Int = 0, val failed: Int = 0, val cancelled: Int = 0, val averageMs: Long? = null, val retries: Int = 0)

@Serializable
data class AiLastFailure(val at: Long, val code: String? = null, val message: String = "")

@Serializable
data class AiActivity(
    val now: AiNow = AiNow(),
    val week: AiWeek = AiWeek(),
    val lastSuccessAt: Long? = null,
    val lastFailure: AiLastFailure? = null,
    val nextRunAt: Long? = null,
    val triggers: List<AiTrigger> = emptyList(),
)

@Serializable
data class AiActivityRes(val activity: AiActivity)

@Serializable
data class AiTriggersRes(val triggers: List<AiTrigger> = emptyList())

@Serializable
data class AiTriggerRes(val trigger: AiTrigger)

/** A new trigger; a webhook's secret and address come back once ([AiTriggerAdded]). */
@Serializable
data class AiNewTrigger(
    val kind: String,
    val label: String,
    val brief: String,
    val conversationId: String? = null,
    val config: JsonObject = JsonObject(emptyMap()),
    val sourceInstallId: String? = null,
)

@Serializable
data class AiTriggerAdded(val trigger: AiTrigger, val secret: String? = null, val hookUrl: String? = null)

@Serializable
data class AiOkPlain(val ok: Boolean = true)

/** Reading a trigger's schedule and a skill's limits, as the settings show them. Unit-tested in `AiOperationsTest`. */
object AiTriggerRules {
    data class Schedule(val every: String, val at: String, val weekday: Int, val timeZone: String)

    fun schedule(config: JsonElement?): Schedule {
        val o = config as? JsonObject
        fun str(k: String) = (o?.get(k) as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        val weekday = (o?.get("weekday") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull()
        return Schedule(str("every") ?: "day", str("at") ?: "09:00", (weekday ?: 1).coerceIn(0, 6), str("timeZone") ?: "UTC")
    }

    /** The skill's own (longest run in seconds, tries), or null when it doesn't say. */
    fun skillLimits(limits: Map<String, JsonElement>): Pair<Int, Int>? {
        fun n(k: String) = (limits[k] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()?.toInt()
        val run = n("maxRuntimeSec") ?: return null
        val tries = n("maxAttempts") ?: return null
        return run to tries
    }
}
