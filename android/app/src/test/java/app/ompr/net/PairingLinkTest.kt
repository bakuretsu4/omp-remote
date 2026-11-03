package app.ompr.net

import app.ompr.crypto.Crypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairingLinkTest {
    private val bpk = Crypto.unhex("0489ad8c38f41316b7009b2a3ec0d6c19546a3607256400089bbbe504e16f9ad7e837898272801245c5001961efba757ef699ed2b43aa182f75714d4d342a1374e")
    private val rid = "dYrTkwxXLhxhf8LvgO5_Qn"
    private val pt = Crypto.unhex("353c931594c2e88c97a08e8fa032d02d176289571f107802ac74739f4d2c0c7e")

    private fun link(vararg relays: String, name: String = "My%20PC", extra: String = "") =
        "ompr://pair?v=2&name=$name&rid=$rid&bpk=${Crypto.b64u(bpk)}&pt=${Crypto.b64u(pt)}" +
            relays.joinToString("") { "&r=" + java.net.URLEncoder.encode(it, "UTF-8") } + extra

    @Test
    fun parsesValidLink() {
        val l = PairingLink.parse(link("ws://10.0.2.2:7466", "wss://relay.example.com"))
        assertEquals("My PC", l.name)
        assertEquals(listOf("ws://10.0.2.2:7466", "wss://relay.example.com"), l.relays)
        assertEquals("sYcXZiHXgmb", l.hostId)
        assertEquals("dYrTkwxXLhxhf8LvgO5_Qn", l.roomId)
    }

    @Test
    fun toleratesSurroundingText() {
        val l = PairingLink.parse("Pair link:\n  " + link("wss://r.example.com") + "\n")
        assertEquals(1, l.relays.size)
    }

    @Test
    fun rejectsPublicCleartextRelay() {
        try {
            PairingLink.parse(link("ws://relay.example.com"))
            fail()
        } catch (e: PairingLink.Companion.ParseException) {
            assertTrue(e.message!!.contains("wss"))
        }
    }

    @Test
    fun rejectsMalformedLinks() {
        for (bad in listOf("hello", "ompr://pair?v=2", "ompr://other?v=2", link("wss://a.b").replace(Crypto.b64u(pt), "AAAA"), link("wss://a.b").replace(rid, "short"))) {
            try {
                PairingLink.parse(bad)
                fail("accepted $bad")
            } catch (_: PairingLink.Companion.ParseException) {
            }
        }
    }

    @Test
    fun rejectsV1AndRoomSecretLinks() {
        val v1 = link("wss://r.example.com").replace("v=2", "v=1")
        try {
            PairingLink.parse(v1)
            fail()
        } catch (e: PairingLink.Companion.ParseException) {
            assertTrue(e.message!!.contains("older"))
        }
        try {
            PairingLink.parse(link("wss://r.example.com", extra = "&rs=AAAA"))
            fail()
        } catch (e: PairingLink.Companion.ParseException) {
            assertTrue(e.message!!.contains("room secret"))
        }
    }

    @Test
    fun badPercentEscapesAreParseErrorsNotCrashes() {
        for (name in listOf("100%", "%zz", "%2")) {
            try {
                PairingLink.parse(link("wss://r.example.com", name = name))
                fail("accepted $name")
            } catch (e: PairingLink.Companion.ParseException) {
                assertTrue(e.message!!.contains("malformed"))
            }
        }
    }

    @Test
    fun namesKeepPercentAndPlus() {
        assertEquals("a+b% c", PairingLink.parse(link("wss://r.example.com", name = "a%2Bb%25%20c")).name)
    }

    @Test
    fun relayHostsFlagCleartext() {
        val hosts = PairingLink.parse(link("ws://192.168.1.5:7470", "wss://relay.example.com")).relayHosts
        assertEquals("192.168.1.5:7470", hosts[0].host)
        assertTrue(hosts[0].cleartext)
        assertEquals("relay.example.com", hosts[1].host)
        assertFalse(hosts[1].cleartext)
    }

    @Test
    fun relayUrlPolicy() {
        for (ok in listOf("ws://10.0.2.2:7466", "ws://192.168.1.5:7470", "ws://127.0.0.1:7466", "ws://172.16.0.1", "ws://100.100.1.1:80", "ws://169.254.1.1", "ws://[fd00::1]:7470", "ws://[::1]:7470", "wss://relay.example.com", "wss://mypc.local", "wss://relay.example.com/prefix")) {
            assertNull("should allow $ok", RelayUrls.validate(ok))
        }
        for (bad in listOf("ws://relay.example.com", "ws://8.8.8.8", "http://10.0.0.1", "relay.example.com", "ws://172.32.0.1", "ws://100.128.0.1",
            "ws://mypc.local:7470", "ws://nas.lan", "ws://host.ts.net", "ws://localhost:7466", "ws://010.0.0.1", "ws://[::ffff:8.8.8.8]", "ws://[2001:db8::1]", "ws://10.0.0.1.evil.com")) {
            assertTrue("should reject $bad", RelayUrls.validate(bad) != null)
        }
        assertEquals("ws://10.0.2.2:7466/r/abc?role=guest", RelayUrls.roomUrl("ws://10.0.2.2:7466/", "abc"))
        assertTrue(RelayUrls.isLan("ws://192.168.0.2:7470"))
        assertFalse(RelayUrls.isLan("wss://relay.example.com"))
    }
}
