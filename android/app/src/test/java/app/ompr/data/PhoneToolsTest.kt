package app.ompr.data

import app.ompr.net.HostToolResult
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneToolsTest {
    private fun spec(id: String) = PhoneTools.spec(id)!!

    @Test
    fun everyToolIsOffUntilTheUserChooses() {
        for (s in PhoneTools.all) {
            for (visible in listOf(true, false)) assertEquals(ToolGate.Disabled, PhoneToolPolicy.gate(ToolMode.OFF, s, visible))
        }
        assertTrue(PhoneTools.capsFor(emptyMap()).isEmpty())
        // A stored value from a newer or older app that this build does not understand must fail closed, not open.
        assertEquals(ToolMode.OFF, ToolMode.parse("always"))
        assertEquals(ToolMode.OFF, ToolMode.parse(null))
    }

    @Test
    fun askAlwaysNeedsAConfirmation() {
        for (s in PhoneTools.all.filter { ToolMode.ASK in it.allowedModes }) {
            for (visible in listOf(true, false)) {
                assertEquals(ToolGate.WaitForUser(consent = true), PhoneToolPolicy.gate(ToolMode.ASK, s, visible))
            }
        }
    }

    @Test
    fun allowedForegroundToolsWaitForTheAppToOpen() {
        for (id in listOf(PhoneTools.LOCATION, PhoneTools.CLIPBOARD_GET, PhoneTools.CAMERA)) {
            assertEquals(ToolGate.WaitForUser(consent = false), PhoneToolPolicy.gate(ToolMode.ALLOW, spec(id), appVisible = false))
            assertEquals(ToolGate.RunNow, PhoneToolPolicy.gate(ToolMode.ALLOW, spec(id), appVisible = true))
        }
    }

    @Test
    fun allowedBackgroundToolsRunWithoutOpeningTheApp() {
        for (id in listOf(PhoneTools.CLIPBOARD_SET, PhoneTools.NOTIFY)) {
            assertEquals(ToolGate.RunNow, PhoneToolPolicy.gate(ToolMode.ALLOW, spec(id), appVisible = false))
        }
    }

    @Test
    fun aModeTheToolDoesNotOfferIsRefused() {
        // Notifications have no per-call confirmation; a stale "ask" must not turn into "run".
        assertEquals(ToolGate.Disabled, PhoneToolPolicy.gate(ToolMode.ASK, spec(PhoneTools.NOTIFY), appVisible = true))
    }

    @Test
    fun advertisedCapabilitiesFollowTheSwitches() {
        val off = PhoneTools.all.associate { it.id to ToolMode.OFF }
        assertEquals(listOf("clipboard"), PhoneTools.capsFor(off + (PhoneTools.CLIPBOARD_GET to ToolMode.ASK)))
        // Two clipboard tools are still one capability.
        assertEquals(
            listOf("clipboard"),
            PhoneTools.capsFor(off + (PhoneTools.CLIPBOARD_GET to ToolMode.ASK) + (PhoneTools.CLIPBOARD_SET to ToolMode.ALLOW)),
        )
        assertEquals(
            listOf("location", "camera"),
            PhoneTools.capsFor(off + (PhoneTools.CAMERA to ToolMode.ASK) + (PhoneTools.LOCATION to ToolMode.ALLOW)),
        )
    }

    @Test
    fun capabilitiesMatchWhatTheBridgeKnows() {
        // The bridge only registers tools for these capability names (bridge/src/channel.ts KNOWN_CAPS).
        val known = setOf("location", "clipboard", "notify", "camera", "voice")
        assertTrue(PhoneTools.all.all { it.cap in known })
        assertEquals(PhoneTools.all.map { it.id }.toSet(), setOf("phone_location", "phone_clipboard_get", "phone_clipboard_set", "phone_notify", "phone_camera_photo"))
    }

    @Test
    fun photoFitTriesSmallerEncodingsUntilOneFits() {
        val tried = ArrayList<Pair<Int, Int>>()
        val out = PhotoFit.fit(maxBytes = 1000) { side, quality ->
            tried += side to quality
            ByteArray(if (tried.size < 3) 5000 else 900)
        }
        assertEquals(3, tried.size)
        assertEquals(PhotoFit.STEPS.take(3), tried)
        assertEquals(900, out!!.size)
    }

    @Test
    fun photoFitGivesUpInsteadOfSendingAFrameThatIsTooBig() {
        var calls = 0
        assertNull(PhotoFit.fit(maxBytes = 10) { _, _ -> calls++; ByteArray(11) })
        assertEquals(PhotoFit.STEPS.size, calls)
        // 300 KB of JPEG is about 400 KB of base64, which must stay under the 512 KiB plaintext frame limit with room for JSON.
        assertTrue(PhotoFit.MAX_BYTES * 4 / 3 + 1024 < 512 * 1024)
    }

    @Test
    fun resultsSerialiseTheWayTheBridgeExpects() {
        val failure = HostToolResult.failure("nope").toArgs("c1")
        assertEquals(JsonPrimitive("c1"), failure["callId"])
        assertEquals(JsonPrimitive(false), failure["ok"])
        assertEquals(JsonPrimitive("nope"), failure["error"])
        assertNull(failure["content"])

        val image = HostToolResult.image("QUJD", "image/jpeg").toArgs("c2")
        assertEquals(JsonPrimitive(true), image["ok"])
        val part = (image["content"] as JsonArray).single() as JsonObject
        assertEquals(JsonPrimitive("image"), part["type"])
        assertEquals(JsonPrimitive("image/jpeg"), part["mimeType"])
        assertNotNull(part["data"])
        assertFalse(image.containsKey("error"))
    }
}
