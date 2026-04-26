package com.dtxmania.quest.dtxcore.scoring

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Ported from the remaining describe blocks of
 * `web/packages/dtx-core/tests/scoring.test.ts`. The `classifyDeltaMs`
 * block lives in [JudgmentTest].
 */
class ScoreTest {

    private fun snap(
        totalNotes: Int,
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
            totalNotes = totalNotes,
            counts = full,
            combo = combo,
            maxCombo = maxCombo,
            score = score,
            autoCount = autoCount,
        )
    }

    // ---- ScoreTracker ---------------------------------------------------

    @Test fun `all perfect gives 1,000,000`() {
        val t = ScoreTracker(10)
        repeat(10) { t.record(Judgment.PERFECT) }
        val s = t.snapshot()
        assertEquals(1_000_000, s.score)
        assertEquals(10, s.maxCombo)
    }

    @Test fun `combo breaks on MISS and POOR`() {
        val t = ScoreTracker(5)
        t.record(Judgment.PERFECT)
        t.record(Judgment.GREAT)
        t.record(Judgment.MISS)
        t.record(Judgment.PERFECT)
        t.record(Judgment.POOR)
        val s = t.snapshot()
        assertEquals(2, s.maxCombo)
        assertEquals(0, s.combo)
        assertEquals(2, s.counts[Judgment.PERFECT])
        assertEquals(1, s.counts[Judgment.GREAT])
        assertEquals(1, s.counts[Judgment.POOR])
        assertEquals(1, s.counts[Judgment.MISS])
    }

    @Test fun `empty song returns 0 score without dividing by zero`() {
        val t = ScoreTracker(0)
        assertEquals(0, t.snapshot().score)
    }

    @Test fun `weighted score - 5 greats out of 10 notes is 350,000`() {
        val t = ScoreTracker(10)
        repeat(5) { t.record(Judgment.GREAT) }
        repeat(5) { t.record(Judgment.MISS) }
        assertEquals(350_000, t.snapshot().score)
    }

    // ---- computeAchievementRate ----------------------------------------

    @Test fun `all-perfect plus full combo caps at 100`() {
        val rate = computeAchievementRate(
            snap(totalNotes = 100, counts = mapOf(Judgment.PERFECT to 100), maxCombo = 100)
        )
        // 100*0.85 + 0 + 100*0.15 = 100
        assertEquals(100.0, rate, 1e-10)
    }

    @Test fun `zero total notes returns 0, no divide-by-zero`() {
        assertEquals(0.0, computeAchievementRate(snap(totalNotes = 0)), 0.0)
    }

    @Test fun `mixed run`() {
        val rate = computeAchievementRate(
            snap(
                totalNotes = 100,
                counts = mapOf(
                    Judgment.PERFECT to 50,
                    Judgment.GREAT to 30,
                    Judgment.GOOD to 10,
                    Judgment.POOR to 5,
                    Judgment.MISS to 5,
                ),
                maxCombo = 95,
            )
        )
        // 50*0.85 + 30*0.35 + 95*0.15 = 42.5 + 10.5 + 14.25 = 67.25
        assertEquals(67.25, rate, 0.0001)
    }

    // ---- computeRank ---------------------------------------------------

    @Test fun `DTXMania thresholds at exact boundaries (inclusive)`() {
        // CScoreIni.cs:1587-1611
        assertEquals(Rank.SS, computeRank(95.0, 100))
        assertEquals(Rank.S, computeRank(94.999, 100))
        assertEquals(Rank.S, computeRank(80.0, 100))
        assertEquals(Rank.A, computeRank(79.999, 100))
        assertEquals(Rank.A, computeRank(73.0, 100))
        assertEquals(Rank.B, computeRank(72.999, 100))
        assertEquals(Rank.B, computeRank(63.0, 100))
        assertEquals(Rank.C, computeRank(62.999, 100))
        assertEquals(Rank.C, computeRank(53.0, 100))
        assertEquals(Rank.D, computeRank(52.999, 100))
        assertEquals(Rank.D, computeRank(45.0, 100))
        assertEquals(Rank.E, computeRank(44.999, 100))
        assertEquals(Rank.E, computeRank(0.0, 100))
    }

    @Test fun `empty chart collapses to E regardless of rate`() {
        assertEquals(Rank.E, computeRank(100.0, 0))
        assertEquals(Rank.E, computeRank(0.0, 0))
    }

    // ---- isFullCombo / isExcellent -------------------------------------

    @Test fun `full combo - no POOR, no MISS, at least one note`() {
        assertTrue(
            isFullCombo(
                snap(
                    totalNotes = 10,
                    counts = mapOf(Judgment.PERFECT to 5, Judgment.GREAT to 3, Judgment.GOOD to 2)
                )
            )
        )
        assertFalse(
            isFullCombo(snap(totalNotes = 10, counts = mapOf(Judgment.PERFECT to 9, Judgment.POOR to 1)))
        )
        assertFalse(
            isFullCombo(snap(totalNotes = 10, counts = mapOf(Judgment.PERFECT to 9, Judgment.MISS to 1)))
        )
        assertFalse(isFullCombo(snap(totalNotes = 0)))
    }

    @Test fun `excellent requires every note PERFECT`() {
        assertTrue(isExcellent(snap(totalNotes = 10, counts = mapOf(Judgment.PERFECT to 10))))
        assertFalse(
            isExcellent(snap(totalNotes = 10, counts = mapOf(Judgment.PERFECT to 9, Judgment.GREAT to 1)))
        )
        assertFalse(isExcellent(snap(totalNotes = 0)))
    }

    // ---- auto-play exclusion -------------------------------------------

    @Test fun `recordAuto increments autoCount and nothing else`() {
        val t = ScoreTracker(10)
        t.record(Judgment.PERFECT)
        t.recordAuto()
        t.recordAuto()
        val s = t.snapshot()
        assertEquals(2, s.autoCount)
        assertEquals(1, s.counts[Judgment.PERFECT])
        assertEquals(1, s.combo)
    }

    @Test fun `score denominator excludes auto - 5 PERFECT plus 5 auto = 1,000,000`() {
        val t = ScoreTracker(10)
        repeat(5) { t.record(Judgment.PERFECT) }
        repeat(5) { t.recordAuto() }
        // effective = 10 - 5 = 5; weightSum = 5*1.0 = 5 → 5/5 = 1.0 → 1_000_000
        assertEquals(1_000_000, t.snapshot().score)
    }

    @Test fun `all-auto chart has score 0 (effective denominator 0)`() {
        val t = ScoreTracker(3)
        t.recordAuto(); t.recordAuto(); t.recordAuto()
        assertEquals(0, t.snapshot().score)
    }

    @Test fun `computeAchievementRate uses (totalNotes - autoCount)`() {
        // 5 PERFECT + 5 auto, no combo tracked → rate = 100*5/5*0.85 = 85
        val rate = computeAchievementRate(
            snap(totalNotes = 10, counts = mapOf(Judgment.PERFECT to 5), autoCount = 5, maxCombo = 0)
        )
        assertEquals(85.0, rate, 0.0001)
    }

    @Test fun `totalNotes equals autoCount collapses to E`() {
        val rate = computeAchievementRate(snap(totalNotes = 10, autoCount = 10))
        assertEquals(0.0, rate, 0.0)
        assertEquals(Rank.E, computeRank(rate, 10))
    }
}
