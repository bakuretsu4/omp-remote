package app.ompr.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionReducerTest {
    private val snapshotJson = """
    {"summary":{"sid":"m_1","kind":"managed","title":"T","cwd":"/tmp/x","status":"working","lastActivity":1,"pendingUi":1,"caps":["prompt","abort"],"futureField":1},
     "state":{"isStreaming":true,"isCompacting":false,"model":{"provider":"p","id":"m"}},
     "messages":[{"id":"a","role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1},
                 {"id":"b","role":"assistant","content":[{"type":"text","text":"ok"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"echo hi"}},{"type":"mystery","x":1}],"timestamp":2},
                 {"id":"c","role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"hi\n","truncated":true}],"timestamp":3}],
     "hasMore":true,"queue":{"steering":[],"followUp":["later"]},"todos":[],"goal":null,
     "pendingUi":[{"reqId":"r1","kind":"approval","tool":"bash","detail":"echo hi","options":["Approve","Deny"],"title":"Allow tool: bash","createdAt":5},{"reqId":"r2","kind":"newkind","createdAt":6}],
     "subagents":[],"runningTools":[{"callId":"c2","tool":"read","args":{"path":"a"},"startedAt":4}]}
    """

    @Test
    fun decodesSnapshotAndIgnoresUnknowns() {
        val s = WireJson.decodeFromString(SessionSnapshot.serializer(), snapshotJson)
        assertEquals(3, s.messages.size)
        assertTrue(s.messages[1].content[2] is Block.Unknown)
        assertTrue(s.pendingUi[0] is UiRequest.Approval)
        assertTrue(s.pendingUi[1] is UiRequest.Unknown)
        val v = SessionReducer.fromSnapshot(SessionView("m_1"), s)
        assertTrue(v.phase is SessionPhase.Ready)
        assertTrue(v.can(Cap.ABORT))
        assertFalse(v.can(Cap.MODEL))
        assertEquals("hi\n", v.tools["c1"]!!.output)
        assertTrue(v.tools["c1"]!!.truncated)
        assertFalse(v.tools["c1"]!!.running)
        assertTrue(v.tools["c2"]!!.running)
        assertTrue(v.busy)
    }

    @Test
    fun appliesEvents() {
        var v = SessionReducer.fromSnapshot(SessionView("m_1"), WireJson.decodeFromString(SessionSnapshot.serializer(), snapshotJson))
        fun ev(j: String) = WireJson.decodeFromString(SessionEvent.serializer(), j)
        v = SessionReducer.apply(v, ev("""{"k":"ui.end","reqId":"r1"}"""))
        assertEquals(listOf("r2"), v.pendingUi.map { it.reqId })
        v = SessionReducer.apply(v, ev("""{"k":"tool.end","callId":"c2","output":"x","isError":true}"""))
        assertTrue(v.tools["c2"]!!.isError)
        assertFalse(v.tools["c2"]!!.running)
        v = SessionReducer.apply(v, ev("""{"k":"msg","final":false,"message":{"id":"d","role":"assistant","content":[{"type":"text","text":"par"}],"timestamp":9}}"""))
        v = SessionReducer.apply(v, ev("""{"k":"msg","final":true,"message":{"id":"d","role":"assistant","content":[{"type":"text","text":"partial"}],"timestamp":9}}"""))
        assertEquals(4, v.messages.size)
        assertEquals("partial", v.messages.last().text)
        v = SessionReducer.apply(v, ev("""{"k":"agent.end","yielded":true,"settled":true}"""))
        assertFalse(v.busy)
        v = SessionReducer.apply(v, ev("""{"k":"something.new","a":1}"""))
        v = SessionReducer.apply(v, ev("""{"k":"closed","reason":"exit"}"""))
        assertTrue(v.closed)
        assertNull(v.goal)
    }

    @Test
    fun decodesHostEvents() {
        val e = WireJson.decodeFromString(HostEvent.serializer(), """{"k":"attention","item":{"id":"i","ts":3,"sid":"m_1","sessionTitle":"T","kind":"approval","summary":"s","resolved":false}}""")
        assertTrue(e is HostEvent.Attention)
        assertTrue(WireJson.decodeFromString(HostEvent.serializer(), """{"k":"zzz"}""") is HostEvent.Unknown)
    }

    @Test
    fun toleratesFloatTimestamps() {
        val l = WireJson.decodeFromString(SessionsListResult.serializer(), """{"sessions":[{"sid":"r_1","kind":"recent","title":"t","cwd":"/x","status":"offline","lastActivity":1793691772049.516,"pendingUi":0,"caps":[]}]}""")
        assertEquals(1793691772049L, l.sessions[0].lastActivity)
        val m = WireJson.decodeFromString(Message.serializer(), """{"id":"a","role":"user","content":[],"timestamp":1.7e12}""")
        assertEquals(1_700_000_000_000L, m.timestamp)
    }

    @Test
    fun approvalModeOrdering() {
        assertTrue(ApprovalModes.isWeaker("always-ask", "write"))
        assertTrue(ApprovalModes.isWeaker("always-ask-cached", "yolo"))
        assertFalse(ApprovalModes.isWeaker("yolo", "always-ask"))
        assertFalse(ApprovalModes.isWeaker("write", "write"))
        assertTrue(ApprovalModes.isWeaker(null, "write"))
        assertTrue(ApprovalModes.isWeaker("always-ask", "future-mode"))
        assertTrue(ApprovalModes.skipsPrompts("yolo"))
        assertTrue(ApprovalModes.skipsPrompts("write"))
        assertFalse(ApprovalModes.skipsPrompts("always-ask"))
        assertFalse(ApprovalModes.skipsPrompts("always-ask-cached"))
    }

    @Test
    fun absorbsToolResultImagesInEitherOrder() {
        fun ev(j: String) = WireJson.decodeFromString(SessionEvent.serializer(), j)
        var v = SessionView("m_1")
        v = SessionReducer.apply(v, ev("""{"k":"tool.start","callId":"c9","tool":"read","args":{"path":"x.png"}}"""))
        v = SessionReducer.apply(
            v,
            ev("""{"k":"msg","final":true,"message":{"id":"tr1","role":"toolResult","toolCallId":"c9","toolName":"read","content":[{"type":"text","text":"Read image"},{"type":"image","ref":"b_1","mimeType":"image/png","bytes":42}],"timestamp":10}}"""),
        )
        v = SessionReducer.apply(v, ev("""{"k":"tool.end","callId":"c9","output":"Read image\n[image: image/png]","isError":false}"""))
        assertEquals(1, v.tools["c9"]!!.images.size)
        assertEquals("b_1", v.tools["c9"]!!.images[0].ref)
        assertFalse(v.tools["c9"]!!.running)
    }
}
