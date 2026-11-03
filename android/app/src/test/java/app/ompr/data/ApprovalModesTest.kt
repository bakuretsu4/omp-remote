package app.ompr.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class ApprovalModesTest {
    private fun info(vararg modes: String) = HostInfo(approvalModes = modes.toList())

    @Test
    fun anOlderBridgeThatReportsNothingKeepsEveryMode() {
        assertEquals(ApprovalModes.all, ApprovalModes.allowedBy(null))
        assertEquals(ApprovalModes.all, ApprovalModes.allowedBy(HostInfo()))
    }

    @Test
    fun onlyTheModesThePcAllowsAreOfferedStrictestFirst() {
        // The bridge default: yolo is off, so the app must not offer it.
        assertEquals(
            listOf(ApprovalModes.ALWAYS_ASK, ApprovalModes.ALWAYS_ASK_CACHED, ApprovalModes.WRITE),
            ApprovalModes.allowedBy(info("write", "always-ask-cached", "always-ask")),
        )
        assertEquals(listOf(ApprovalModes.ALWAYS_ASK), ApprovalModes.allowedBy(info("always-ask")))
    }

    @Test
    fun aDefaultThePcForbidsFallsBackToTheStrictestAllowedMode() {
        val noYolo = info("always-ask", "always-ask-cached", "write")
        assertEquals(ApprovalModes.YOLO, ApprovalModes.orStrictest(ApprovalModes.YOLO, null))
        assertEquals(ApprovalModes.ALWAYS_ASK, ApprovalModes.orStrictest(ApprovalModes.YOLO, noYolo))
        assertEquals(ApprovalModes.WRITE, ApprovalModes.orStrictest(ApprovalModes.WRITE, noYolo))
        // An unrecognised stored value is not honoured either.
        assertEquals(ApprovalModes.ALWAYS_ASK, ApprovalModes.orStrictest("future-mode", noYolo))
        // A PC that allows nothing we recognise still yields a safe answer instead of crashing.
        assertEquals(ApprovalModes.ALWAYS_ASK, ApprovalModes.orStrictest(ApprovalModes.YOLO, info("future-mode")))
    }

    @Test
    fun hostInfoDecodesWithAndWithoutTheField() {
        val json = Json { ignoreUnknownKeys = true }
        val with = json.decodeFromString(HostInfo.serializer(), """{"proto":1,"hostId":"h","approvalModes":["always-ask","write"],"now":1}""")
        assertEquals(listOf("always-ask", "write"), with.approvalModes)
        val without = json.decodeFromString(HostInfo.serializer(), """{"proto":1,"hostId":"h","now":1}""")
        assertEquals(null, without.approvalModes)
    }
}
