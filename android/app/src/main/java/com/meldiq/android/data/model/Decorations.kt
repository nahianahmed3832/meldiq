package com.meldiq.android.data.model

import kotlinx.serialization.Serializable

/**
 * Profile decorations (API 0.60.0, server docs/PROFILE_DECORATIONS.md, as Meldiq Web): Meldiq's own, ones people make
 * and send in (shown to everyone once Meldiq's staff approve them), and your own submissions. A decoration is a square
 * image whose middle circle is left for the avatar; it's drawn 1.2 times the avatar's size, centred on it. The six
 * classic frames ([LookRules.DECORATIONS]) are still drawn by the app.
 */
@Serializable
data class DecorationCreatorDto(val userId: String, val username: String? = null, val displayName: String = "")

@Serializable
data class DecorationDto(
    val id: String,
    val name: String,
    /** "meldiq" or "community". */
    val kind: String = "community",
    val animated: Boolean = false,
    val imageUrl: String = "",
    val creator: DecorationCreatorDto? = null,
)

@Serializable
data class DecorationCatalogDto(val decorations: List<DecorationDto> = emptyList(), val classic: List<String> = emptyList(), val templateUrl: String = "/v2/decorations/template")

@Serializable
data class DecorationSubmissionDto(
    val id: String,
    val name: String,
    /** "pending", "approved", "rejected" or "removed". */
    val status: String,
    val reason: String? = null,
    val animated: Boolean = false,
    val imageUrl: String = "",
    val wearers: Int = 0,
    val createdAt: Long = 0,
    val reviewedAt: Long? = null,
)

@Serializable
data class MyDecorationsDto(val submissions: List<DecorationSubmissionDto> = emptyList(), val artist: Boolean = false, val pendingLimit: Int = 3, val pending: Int = 0)

@Serializable
data class SubmissionRes(val submission: DecorationSubmissionDto)

@Serializable
data class UserDecorationsRes(val decorations: List<DecorationDto> = emptyList())

object DecorationRules {
    /** Meldiq's own ids (lowercase words) or a community one ("c_" and 16 letters or digits). */
    private val ID = Regex("^(?:[a-z0-9-]{2,32}|c_[a-z0-9]{16})$")
    /** What the server takes (server DECORATION_LIMITS). */
    const val MAX_BYTES = 1536L * 1024
    const val MIN_SIDE = 128
    const val MAX_SIDE = 1024
    val TYPES = listOf("image/png", "image/webp", "image/gif")
    /** The image is this much larger than the avatar it frames. */
    const val SCALE = 1.2f

    fun isClassic(id: String?): Boolean = id != null && id in LookRules.DECORATIONS

    /** An image decoration (not a classic frame) the app can load by id. */
    fun isImage(id: String?): Boolean = id != null && !isClassic(id) && ID.matches(id)
}
