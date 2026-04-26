package com.dtxmania.quest.dtxcore.scoring

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/record.test.ts`.
 *
 * Note on time: the TS source calls `Date.now()` directly inside
 * [mergeChartRecord]; the Kotlin port adds an explicit `nowMs`
 * parameter (default `System.currentTimeMillis()`) so the test can
 * inject a deterministic value when it asserts on `lastPlayedMs`.
 */
class RecordTest {

    private fun snap(
        counts: Map<Judgment, Int> = emptyMap(),
        combo: Int = 0,
        maxCombo: Int = 0,
        score: Int = 0,
        autoCount: Int = 0,
    ): ScoreSnapshot {
        val full = mutableMapOf(
            Judgment.PERFECT to 0,
            Judgment.GREAT to 0,
            Judgment.GOOD to 0,
            Judgment.POOR to 0,
            Judgment.MISS to 0,
        )
        full.putAll(counts)
        return ScoreSnapshot(
            totalNotes = 100,
            counts = full,
            combo = combo,
            maxCombo = maxCombo,
            score = score,
            autoCount = autoCount,
        )
    }

    @Test fun `first play produces a record with plays equals 1`() {
        val rec = mergeChartRecord(
            "Songs/a.dtx",
            null,
            snap(score = 500_000, maxCombo = 80, counts = mapOf(Judgment.PERFECT to 80)),
            nowMs = 12345L,
        )
        assertEquals("Songs/a.dtx", rec.chartPath)
        assertEquals(1, rec.plays)
        assertEquals(500_000, rec.bestScore)
        assertTrue(rec.lastPlayedMs > 0)
    }

    @Test fun `score, achievement, rank take max across plays`() {
        val first = mergeChartRecord(
            "x.dtx", null,
            snap(score = 400_000, counts = mapOf(Judgment.PERFECT to 60), maxCombo = 60),
        )
        val second = mergeChartRecord(
            "x.dtx", first,
            snap(score = 700_000, counts = mapOf(Judgment.PERFECT to 90), maxCombo = 90),
        )
        assertEquals(700_000, second.bestScore)
        assertEquals(2, second.plays)
        // Going backwards doesn't erase the best.
        val third = mergeChartRecord(
            "x.dtx", second,
            snap(score = 100_000, counts = mapOf(Judgment.PERFECT to 20), maxCombo = 20),
        )
        assertEquals(700_000, third.bestScore)
        assertEquals(3, third.plays)
    }

    @Test fun `full-combo flag is sticky - once true, stays true`() {
        val pristine = mergeChartRecord(
            "x.dtx", null,
            snap(counts = mapOf(Judgment.PERFECT to 80, Judgment.GREAT to 20), maxCombo = 100),
        )
        assertTrue(pristine.fullCombo)
        // Play again and drop combo; flag should persist.
        val after = mergeChartRecord(
            "x.dtx", pristine,
            snap(counts = mapOf(Judgment.PERFECT to 50, Judgment.MISS to 50), maxCombo = 40),
        )
        assertTrue(after.fullCombo)
    }

    @Test fun `excellent flag is sticky and implies full-combo on that play`() {
        val perfect = mergeChartRecord(
            "x.dtx", null,
            snap(counts = mapOf(Judgment.PERFECT to 100), maxCombo = 100),
        )
        assertTrue(perfect.excellent)
        assertTrue(perfect.fullCombo)
        val worse = mergeChartRecord(
            "x.dtx", perfect,
            snap(counts = mapOf(Judgment.PERFECT to 90, Judgment.GREAT to 10), maxCombo = 100),
        )
        assertTrue(worse.excellent)
    }

    @Test fun `rank only moves up, never down`() {
        val b = mergeChartRecord(
            "x.dtx", null,
            snap(
                counts = mapOf(Judgment.PERFECT to 70, Judgment.GREAT to 20, Judgment.MISS to 10),
                maxCombo = 70,
            ),
        )
        val rankB = b.bestRank
        val e = mergeChartRecord(
            "x.dtx", b,
            snap(counts = mapOf(Judgment.MISS to 100), maxCombo = 0),
        )
        assertEquals(rankB, e.bestRank)
    }
}
