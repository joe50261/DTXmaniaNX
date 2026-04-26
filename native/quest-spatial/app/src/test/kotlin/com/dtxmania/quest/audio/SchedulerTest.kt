package com.dtxmania.quest.audio

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.model.Chip
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Test

/**
 * Unit tests for the pure-Kotlin [Scheduler]. The conversion is
 * deliberately a one-liner (`deltaMs * sampleRate / 1000`) but the
 * filtering rules (lookahead window boundaries, missing wavId,
 * already-past chips) deserve explicit coverage.
 */
class SchedulerTest {

    private val sched = Scheduler(sampleRate = 48000)

    private fun chip(timeMs: Double, wavId: Int? = 1, channel: Int = Channel.SNARE) =
        Chip(channel = channel, measure = 0, tick = 0, wavId = wavId,
            playbackTimeMs = timeMs)

    // -----------------------------------------------------------------
    // targetFrameFor
    // -----------------------------------------------------------------

    @Test fun `chip exactly at currentTime maps to currentDspFrame`() {
        val frame = sched.targetFrameFor(
            chipTimeMs = 1000.0, currentDspFrame = 100_000L, currentTimeMs = 1000.0,
        )
        assertEquals(100_000L, frame)
    }

    @Test fun `chip 1 second ahead maps to currentDspFrame plus sampleRate frames`() {
        val frame = sched.targetFrameFor(
            chipTimeMs = 2000.0, currentDspFrame = 0L, currentTimeMs = 1000.0,
        )
        assertEquals(48_000L, frame)
    }

    @Test fun `chip in the past maps to a frame in the past`() {
        // Negative delta is allowed; the engine's ring buffer treats
        // "target frame already passed" the same as "fire immediately".
        val frame = sched.targetFrameFor(
            chipTimeMs = 500.0, currentDspFrame = 100_000L, currentTimeMs = 1000.0,
        )
        // -500ms at 48 kHz = -24,000 frames
        assertEquals(76_000L, frame)
    }

    @Test fun `targetFrameFor rounds half away from zero`() {
        // 0.5ms at 48 kHz = 24 frames exactly. Use 0.520833ms which is
        // 25.0001 frames → rounds to 25 (HALF_UP for positive halves).
        val frame = sched.targetFrameFor(
            chipTimeMs = 0.520833, currentDspFrame = 0L, currentTimeMs = 0.0,
        )
        assertEquals(25L, frame)
    }

    // -----------------------------------------------------------------
    // scheduleAhead — windowing
    // -----------------------------------------------------------------

    @Test fun `scheduleAhead picks only chips strictly after currentTime`() {
        val chips = listOf(
            chip(timeMs = 999.0),    // before the window — drop
            chip(timeMs = 1000.0),   // exactly at currentTime — drop (open lower bound)
            chip(timeMs = 1001.0),   // in window
            chip(timeMs = 1100.0),   // in window (at the cutoff)
            chip(timeMs = 1101.0),   // beyond cutoff — drop
        )
        val out = sched.scheduleAhead(
            chips = chips,
            currentDspFrame = 0L,
            currentTimeMs = 1000.0,
            lookaheadMs = 100.0,
        )
        assertEquals(2, out.size)
    }

    @Test fun `scheduleAhead skips chips with no wavId`() {
        // A BPM-change chip has bpmId / rawBpm set but no wavId — the
        // scheduler is sample-id-driven and must not emit an event for
        // those.
        val chips = listOf(
            chip(timeMs = 1010.0, wavId = null),  // no sample
            chip(timeMs = 1020.0, wavId = 5),
        )
        val out = sched.scheduleAhead(
            chips = chips,
            currentDspFrame = 0L,
            currentTimeMs = 1000.0,
            lookaheadMs = 50.0,
        )
        assertEquals(1, out.size)
        assertEquals(5, out[0].sampleId)
    }

    @Test fun `scheduleAhead computes targetFrame from currentDspFrame plus delta`() {
        val chips = listOf(chip(timeMs = 1050.0, wavId = 7))
        val out = sched.scheduleAhead(
            chips = chips,
            currentDspFrame = 1_000_000L,
            currentTimeMs = 1000.0,
            lookaheadMs = 100.0,
        )
        assertEquals(1, out.size)
        // delta = 50ms = 2400 frames at 48 kHz → 1_002_400
        assertEquals(1_002_400L, out[0].targetFrame)
    }

    @Test fun `scheduleAhead with empty chip list returns empty result`() {
        val out = sched.scheduleAhead(
            chips = emptyList(),
            currentDspFrame = 0L, currentTimeMs = 0.0, lookaheadMs = 50.0,
        )
        assertTrue(out.isEmpty())
    }

    @Test fun `scheduleAhead tolerates lookaheadMs equals 0 (drains nothing)`() {
        val chips = listOf(chip(timeMs = 1000.000001))
        val out = sched.scheduleAhead(
            chips = chips,
            currentDspFrame = 0L, currentTimeMs = 1000.0, lookaheadMs = 0.0,
        )
        assertTrue(out.isEmpty())
    }

    @Test fun `scheduleAhead emits gain 1 and pan 0 by default`() {
        val out = sched.scheduleAhead(
            chips = listOf(chip(timeMs = 1010.0, wavId = 3)),
            currentDspFrame = 0L, currentTimeMs = 1000.0, lookaheadMs = 50.0,
        )
        assertEquals(1f, out[0].gain)
        assertEquals(0f, out[0].pan)
    }

    @Test fun `scheduleAhead preserves chip order across the output`() {
        val chips = listOf(
            chip(timeMs = 1010.0, wavId = 1),
            chip(timeMs = 1030.0, wavId = 2),
            chip(timeMs = 1020.0, wavId = 3),
        )
        val out = sched.scheduleAhead(
            chips = chips,
            currentDspFrame = 0L, currentTimeMs = 1000.0, lookaheadMs = 100.0,
        )
        // Scheduler doesn't sort — it preserves the caller's order so
        // pre-sorted chip lists (post timing-pass) stay sorted.
        assertEquals(listOf(1, 2, 3), out.map { it.sampleId })
    }

    // -----------------------------------------------------------------
    // Argument validation
    // -----------------------------------------------------------------

    @Test fun `constructor rejects non-positive sampleRate`() {
        assertThrows<IllegalArgumentException> { Scheduler(sampleRate = 0) }
        assertThrows<IllegalArgumentException> { Scheduler(sampleRate = -48000) }
    }

    @Test fun `scheduleAhead rejects negative lookaheadMs`() {
        assertThrows<IllegalArgumentException> {
            sched.scheduleAhead(
                chips = emptyList(),
                currentDspFrame = 0L, currentTimeMs = 0.0, lookaheadMs = -1.0,
            )
        }
    }
}
