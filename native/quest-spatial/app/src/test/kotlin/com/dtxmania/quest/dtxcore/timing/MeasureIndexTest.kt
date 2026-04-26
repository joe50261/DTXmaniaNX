package com.dtxmania.quest.dtxcore.timing

import com.dtxmania.quest.dtxcore.model.createEmptySong
import com.dtxmania.quest.dtxcore.parser.parseDtx
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/measure-index.test.ts`.
 */
class MeasureIndexTest {
    @Test fun `returns single sentinel for empty song`() {
        val song = createEmptySong().also { it.baseBpm = 120.0 }
        computeTiming(song)
        val idx = buildMeasureStartMsIndex(song)
        // No chips → maxMeasure = 0, one measure at 0ms + sentinel at 2000ms.
        assertEquals(2, idx.size)
        assertEquals(0.0, idx[0], 0.001)
        assertEquals(2000.0, idx[1], 0.001)
    }

    @Test fun `constant 120 BPM, out i is i times 2000`() {
        val dtx = listOf(
            "#BPM 120",
            "#WAV01 s.wav",
            "#00012:01000000",
            "#00112:01000000",
            "#00212:01000000",
            "#00312:01000000",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val idx = buildMeasureStartMsIndex(song)
        // measures 0..3 + sentinel 4 → length 5
        assertEquals(5, idx.size)
        assertEquals(0.0, idx[0], 0.001)
        assertEquals(2000.0, idx[1], 0.001)
        assertEquals(4000.0, idx[2], 0.001)
        assertEquals(6000.0, idx[3], 0.001)
        assertEquals(8000.0, idx[4], 0.001)
    }

    @Test fun `BPM change at start of measure 1 applies to measure 1 onward`() {
        val dtx = listOf(
            "#BPM 120",
            "#BPM01 240",
            "#WAV01 s.wav",
            "#00012:01000000",
            "#00108:01000000",
            "#00212:01000000",
            "#00312:01000000",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val idx = buildMeasureStartMsIndex(song)
        assertEquals(0.0, idx[0], 0.001)
        assertEquals(2000.0, idx[1], 0.001)
        assertEquals(3000.0, idx[2], 0.001)
        assertEquals(4000.0, idx[3], 0.001)
        assertEquals(5000.0, idx[4], 0.001)
    }

    @Test fun `mid-measure BPM change affects tail of that measure`() {
        // 120 BPM: first 192 ticks = 1000ms. BPM doubles at tick 192 → next 192 ticks = 500ms.
        // Measure 0 = 1500ms; measure 1 starts at 1500ms.
        val dtx = listOf(
            "#BPM 120",
            "#BPM01 240",
            "#WAV01 s.wav",
            "#00008:00000100",
            "#00112:01000000",
        ).joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val idx = buildMeasureStartMsIndex(song)
        assertEquals(0.0, idx[0], 0.001)
        assertEquals(1500.0, idx[1], 0.001)
    }

    @Test fun `empty measures between chips are filled in`() {
        val dtx = listOf("#BPM 120", "#WAV01 s.wav", "#00012:01000000", "#00512:01000000")
            .joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val idx = buildMeasureStartMsIndex(song)
        assertEquals(7, idx.size)
        for (i in 0 until idx.size - 1) {
            assertTrue(idx[i + 1] > idx[i]) { "idx[${i + 1}]=${idx[i + 1]} not > idx[$i]=${idx[i]}" }
        }
        assertEquals(10000.0, idx[5], 0.001)
    }

    @Test fun `trailing sentinel matches song durationMs`() {
        val dtx = listOf("#BPM 150", "#WAV01 s.wav", "#00012:01000000", "#00112:01000000")
            .joinToString("\n")
        val song = computeTiming(parseDtx(dtx))
        val idx = buildMeasureStartMsIndex(song)
        assertEquals(song.durationMs, idx.last(), 0.001)
    }
}
