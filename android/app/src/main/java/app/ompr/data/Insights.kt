package app.ompr.data

import kotlinx.serialization.Serializable

/**
 * Kotlin mirror of the usage / file / git result types in protocol/src/index.ts
 * (`usage.get`, `fs.read`, `git.status`, `git.diff`). Kept apart from Protocol.kt on purpose.
 */

/** Capability names a bridge lists in `HostInfo.features`. */
object Features {
    const val USAGE = "usage"
    const val FILES = "files"
    const val GIT = "git"
}

/** Older bridges send no `features`: they offer none of the optional capabilities. */
fun HostInfo?.supports(feature: String): Boolean = this?.features?.contains(feature) == true

@Serializable
data class UsageLimit(
    val id: String = "",
    val label: String = "",
    val status: String = "unknown",
    val usedFraction: Double? = null,
    @Serializable(with = FlexLongOrNull::class) val resetsAt: Long? = null,
)

@Serializable
data class UsageAccount(
    val provider: String = "",
    val email: String? = null,
    val org: String? = null,
    val limits: List<UsageLimit> = emptyList(),
)

@Serializable
data class UsageResult(
    @Serializable(with = FlexLong::class) val generatedAt: Long = 0,
    val accounts: List<UsageAccount> = emptyList(),
)

@Serializable
data class FsReadResult(
    val path: String = "",
    @Serializable(with = FlexLong::class) val size: Long = 0,
    val truncated: Boolean = false,
    val binary: Boolean = false,
    val text: String? = null,
)

@Serializable
data class GitStatusFile(val path: String = "", val status: String = "")

@Serializable
data class GitStatusResult(
    val root: String = "",
    val branch: String? = null,
    val files: List<GitStatusFile> = emptyList(),
    val truncated: Boolean = false,
)

@Serializable
data class GitDiffResult(val diff: String = "", val truncated: Boolean = false)
