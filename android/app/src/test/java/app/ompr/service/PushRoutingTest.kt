package app.ompr.service

import app.ompr.data.HostInfo
import app.ompr.ui.settings.unifiedPushStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRoutingTest {
    private fun host(push: Boolean = false, features: List<String>? = null) = HostInfo(hostId = "h1", push = push, features = features)

    @Test
    fun unifiedPushIsChosenOnlyWhenOnHasAnEndpointAndTheHostSupportsIt() {
        val up = host(features = listOf("unifiedpush"))
        assertEquals(PushChoice.UnifiedPush("https://ntfy.sh/up1"), PushRouting.choose(up, true, "https://ntfy.sh/up1", null))
        assertNull("switched off", PushRouting.choose(up, false, "https://ntfy.sh/up1", null))
        assertNull("no endpoint yet", PushRouting.choose(up, true, null, null))
        assertNull("empty endpoint", PushRouting.choose(up, true, "", null))
        assertNull("an older bridge advertises no features", PushRouting.choose(host(features = null), true, "https://ntfy.sh/up1", null))
        assertNull("a bridge with other features only", PushRouting.choose(host(features = listOf("usage")), true, "https://ntfy.sh/up1", null))
    }

    @Test
    fun fcmIsTheFallbackAndNeedsBothTheHostAndAToken() {
        assertEquals(PushChoice.Fcm("tok"), PushRouting.choose(host(push = true), false, null, "tok"))
        assertNull("host cannot send FCM", PushRouting.choose(host(push = false), false, null, "tok"))
        assertNull("no token", PushRouting.choose(host(push = true), false, null, null))
        val both = host(push = true, features = listOf("unifiedpush"))
        assertEquals("UnifiedPush wins when it is on and ready", PushChoice.UnifiedPush("https://x.example/u"), PushRouting.choose(both, true, "https://x.example/u", "tok"))
        assertEquals("FCM again when UnifiedPush has no endpoint", PushChoice.Fcm("tok"), PushRouting.choose(both, true, null, "tok"))
        assertNull(PushRouting.choose(null, true, "https://x.example/u", "tok"))
    }

    @Test
    fun theStoredKeyChangesWhenTheTokenOrEndpointDoes() {
        assertTrue(PushChoice.Fcm("a").key != PushChoice.Fcm("b").key)
        assertTrue(PushChoice.UnifiedPush("https://a/x").key != PushChoice.UnifiedPush("https://b/x").key)
        assertTrue("a token and an endpoint never collide", PushChoice.Fcm("https://a/x").key != PushChoice.UnifiedPush("https://a/x").key)
    }

    @Test
    fun parseWakeAcceptsOurPayloadAndNothingElse() {
        assertEquals(Wake("HOST1"), PushRouting.parseWake("""{"w":"1","h":"HOST1"}""".toByteArray()))
        assertEquals("no host named: sync with all", Wake(null), PushRouting.parseWake("""{"w":"1"}""".toByteArray()))
        assertEquals(Wake(null), PushRouting.parseWake("""{"w":"1","h":""}""".toByteArray()))
        assertNull(PushRouting.parseWake("""{"w":"2","h":"HOST1"}""".toByteArray()))
        assertNull("a distributor's plain test message", PushRouting.parseWake("Test notification".toByteArray()))
        assertNull(PushRouting.parseWake(ByteArray(0)))
        assertNull("a JSON array is not an object", PushRouting.parseWake("[1]".toByteArray()))
        assertNull("oversized payloads are ignored", PushRouting.parseWake(("""{"w":"1","h":"""" + "x".repeat(2000) + """"}""").toByteArray()))
        assertEquals("a long host id is dropped, the wake still counts", Wake(null), PushRouting.parseWake("""{"w":"1","h":"${"x".repeat(65)}"}""".toByteArray()))
    }

    @Test
    fun settingsStatusExplainsEachState() {
        assertTrue(unifiedPushStatus(false, null, null).contains("without Google"))
        assertTrue(unifiedPushStatus(true, null, null).startsWith("Waiting"))
        assertEquals("On. Your PCs wake this phone through ntfy.sh.", unifiedPushStatus(true, "https://ntfy.sh/up1", null))
        assertTrue(unifiedPushStatus(true, null, "NETWORK").contains("no network"))
        assertTrue(unifiedPushStatus(true, null, "ACTION_REQUIRED").contains("open the push app"))
        assertTrue("an error beats a stale endpoint", unifiedPushStatus(true, "https://ntfy.sh/up1", "NETWORK").startsWith("The push app could not register"))
    }
}
