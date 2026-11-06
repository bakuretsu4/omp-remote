package app.ompr.data

import org.junit.Assert.assertEquals
import org.junit.Test

class SyncSummaryTest {
    @Test
    fun decodesWhatTheBridgeSendsIncludingExtraFieldsAndFloatDurations() {
        val s = WireJson.decodeFromString(
            SyncSummary.serializer(),
            """{"pushedSessions":1,"pulledSessions":2,"pushedProjects":3,"pulledProjects":0,"durationMs":1234.7,"future":true}""",
        )
        assertEquals(SyncSummary(1, 2, 3, 0, 1234), s)
        assertEquals(3, s.sessionsMoved)
    }

    @Test
    fun hostInfoWithoutFeaturesMeansNone() {
        val info = WireJson.decodeFromString(HostInfo.serializer(), """{"proto":1,"hostId":"h","name":"old"}""")
        assertEquals(emptyList<String>(), info.features.orEmpty())
    }
}
