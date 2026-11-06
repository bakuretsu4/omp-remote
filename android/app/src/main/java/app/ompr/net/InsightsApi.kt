package app.ompr.net

import app.ompr.data.FsReadResult
import app.ompr.data.GitDiffResult
import app.ompr.data.GitStatusResult
import app.ompr.data.UsageResult
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Host operations behind the optional features "usage", "files" and "git" (check `HostInfo.supports` first).

/** `omp usage` can take a while on the PC (it queries each provider); the bridge caps it at 60 s. */
suspend fun HostConnection.usageGet(): UsageResult =
    call("usage.get", buildJsonObject {}, UsageResult.serializer(), 75_000)

suspend fun HostConnection.fsRead(path: String, maxBytes: Int? = null): FsReadResult =
    call(
        "fs.read",
        buildJsonObject {
            put("path", path)
            if (maxBytes != null) put("maxBytes", maxBytes)
        },
        FsReadResult.serializer(),
    )

suspend fun HostConnection.gitStatus(path: String): GitStatusResult =
    call("git.status", buildJsonObject { put("path", path) }, GitStatusResult.serializer(), 30_000)

/** [file] is relative to the repository root, exactly as `git.status` reports it. */
suspend fun HostConnection.gitDiff(path: String, file: String? = null, staged: Boolean = false): GitDiffResult =
    call(
        "git.diff",
        buildJsonObject {
            put("path", path)
            if (file != null) put("file", file)
            if (staged) put("staged", true)
        },
        GitDiffResult.serializer(),
        30_000,
    )
