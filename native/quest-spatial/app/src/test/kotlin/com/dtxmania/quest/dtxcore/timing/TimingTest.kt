package com.dtxmania.quest.dtxcore.timing

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.parser.parseDtx
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/timing.test.ts`.
 * `toBeCloseTo(value, 3)` (3 decimal digits) maps to JUnit's
 * `assertEquals(expected, actual, 0.001)`.
 */
class TimingTest {
    @Test fun `at 120 BPM one measure equals 2000ms - snare at tick 0 of measure 1 lands at 2000ms`() {
        val dtx = listOf("#BPM 120", "#WAV01 s.wav", "#00112:01000000").joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val snare = song.chips.first { it.channel == Channel.SNARE }
        assertEquals(2000.0, snare.playbackTimeMs, 0.001)
    }

    @Test fun `four quarter-notes in measure 0 at 120 BPM land on 0, 500, 1000, 1500ms`() {
        val dtx = listOf("#BPM 120", "#WAV01 s.wav", "#00012:01010101").joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val times = song.chips.filter { it.channel == Channel.SNARE }.map { it.playbackTimeMs }
        assertEquals(0.0, times[0], 0.001)
        assertEquals(500.0, times[1], 0.001)
        assertEquals(1000.0, times[2], 0.001)
        assertEquals(1500.0, times[3], 0.001)
    }

    @Test fun `applies BPMChangeExtended mid-song`() {
        // measure 0 at 120 BPM (2000ms), BPM change at tick 0 of measure 1 to 240 BPM,
        // then a snare at tick 0 of measure 2 which should be at 2000 + 1000 = 3000ms.
        val dtx = listOf(
            "#BPM 120",
            "#BPM01 240",
            "#WAV01 s.wav",
            "#00012:01000000",
            "#00108:01000000",
            "#00212:01000000",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val snares = song.chips.filter { it.channel == Channel.SNARE }
        assertEquals(2, snares.size)
        assertEquals(0.0, snares[0].playbackTimeMs, 0.001)
        assertEquals(3000.0, snares[1].playbackTimeMs, 0.001)
    }

    @Test fun `BPM change mid-measure affects only subsequent ticks`() {
        // 120 BPM: tick 192 = 1000ms. BPM doubles at tick 192.
        // tick 288 (3/4 of measure) without change = 1500ms.
        // With doubling: 192 ticks at 120 BPM = 1000ms, next 96 ticks at 240 BPM = 250ms,
        // total = 1250ms.
        val dtx = listOf(
            "#BPM 120",
            "#BPM01 240",
            "#WAV01 s.wav",
            "#00008:00000100",
            "#00012:00000001",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val snare = song.chips.first { it.channel == Channel.SNARE }
        assertEquals(1250.0, snare.playbackTimeMs, 0.001)
    }

    @Test fun `sorts chips chronologically after timing`() {
        val dtx = listOf(
            "#BPM 120",
            "#WAV01 s.wav",
            "#00212:01000000",
            "#00012:01000000",
            "#00112:01000000",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val times = song.chips.map { it.playbackTimeMs }
        for (i in 1 until times.size) {
            assertTrue(times[i] >= times[i - 1]) { "chip $i not chronological: ${times[i]} < ${times[i - 1]}" }
        }
    }

    @Test fun `durationMs equals last-chip-time plus measure remainder`() {
        val dtx = listOf("#BPM 120", "#WAV01 s.wav", "#00212:01000000").joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        // Chip at measure 2 tick 0 = 4000ms; remainder of measure = 2000ms → 6000ms.
        assertEquals(6000.0, song.durationMs, 0.001)
    }
}
