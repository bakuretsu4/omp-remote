package app.ompr.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InsightsTest {
    @Test
    fun featuresAreOffUnlessTheBridgeListsThem() {
        assertFalse(null.supports(Features.USAGE))
        assertFalse(HostInfo().supports(Features.FILES)) // an older bridge sends no `features`
        val info = HostInfo(features = listOf("files", "git"))
        assertTrue(info.supports(Features.FILES))
        assertTrue(info.supports(Features.GIT))
        assertFalse(info.supports(Features.USAGE))
    }

    @Test
    fun decodesUsageResultsWithNullsAndUnknownFields() {
        val json = """{"generatedAt":1790000000000,"future":1,"accounts":[
            {"provider":"anthropic","email":"a@example.invalid","org":"Org","limits":[
              {"id":"5h","label":"5 Hour","status":"warning","usedFraction":0.96,"resetsAt":1790100000000},
              {"id":"extra","label":"Extra","status":"unknown","usedFraction":null,"resetsAt":null}]},
            {"provider":"openai-codex","limits":[]}]}"""
        val r = WireJson.decodeFromString(UsageResult.serializer(), json)
        assertEquals(1790000000000L, r.generatedAt)
        assertEquals(2, r.accounts.size)
        val l = r.accounts[0].limits
        assertEquals(0.96, l[0].usedFraction!!, 1e-9)
        assertEquals(1790100000000L, l[0].resetsAt)
        assertNull(l[1].usedFraction)
        assertNull(l[1].resetsAt)
        assertNull(r.accounts[1].email)
    }

    @Test
    fun decodesFileAndGitResults() {
        val read = WireJson.decodeFromString(FsReadResult.serializer(), """{"path":"/p/a.bin","size":4,"truncated":false,"binary":true}""")
        assertTrue(read.binary)
        assertNull(read.text)
        val text = WireJson.decodeFromString(FsReadResult.serializer(), """{"path":"/p/a.txt","size":9.0,"truncated":true,"binary":false,"text":"hi"}""")
        assertEquals(9L, text.size)
        assertEquals("hi", text.text)

        val st = WireJson.decodeFromString(GitStatusResult.serializer(), """{"root":"/p","branch":null,"files":[{"path":"a b.txt","status":" M"}]}""")
        assertNull(st.branch)
        assertFalse(st.truncated)
        assertEquals(" M", st.files.single().status)
        assertTrue(WireJson.decodeFromString(GitDiffResult.serializer(), """{"diff":"x","truncated":true}""").truncated)
    }
}
