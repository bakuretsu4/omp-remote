package app.ompr.net

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WantConnectedTest {
    @Test
    fun navigationFlapInsideGraceDoesNotReEmit() = runTest {
        val holders = MutableStateFlow(1)
        val seen = mutableListOf<Boolean>()
        val job = launch { holders.wantConnected(4_000).collect { seen += it } }
        advanceTimeBy(100)

        // Dashboard releases, the session screen acquires 500 ms later: the socket must stay up untouched.
        holders.value = 0
        advanceTimeBy(500)
        holders.value = 1
        advanceTimeBy(10_000)

        assertEquals(listOf(true), seen)
        job.cancel()
    }

    @Test
    fun releaseOnlyEmitsFalseAfterGrace() = runTest {
        val holders = MutableStateFlow(1)
        val seen = mutableListOf<Boolean>()
        val job = launch { holders.wantConnected(4_000).collect { seen += it } }
        advanceTimeBy(100)

        holders.value = 0
        advanceTimeBy(3_900)
        assertEquals(listOf(true), seen)
        advanceTimeBy(200)
        assertEquals(listOf(true, false), seen)

        holders.value = 1
        advanceTimeBy(1)
        assertEquals(listOf(true, false, true), seen)
        job.cancel()
    }
}
