package com.dtxmania.quest.dtxcore.scoring

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Ported from the `describe('classifyDeltaMs')` block of
 * `web/packages/dtx-core/tests/scoring.test.ts`. The remaining blocks
 * (`ScoreTracker`, `computeAchievementRate`, `computeRank`,
 * `isFullCombo / isExcellent`, `auto-play exclusion`) will land with
 * the score / record port.
 */
class JudgmentTest {
    @Test fun `classifies exact hit as PERFECT`() {
        assertEquals(Judgment.PERFECT, classifyDeltaMs(0.0))
    }

    @Test fun `edge of PERFECT is PERFECT, +1ms over is GREAT`() {
        assertEquals(Judgment.PERFECT, classifyDeltaMs(HitRangesMs.PERFECT.toDouble()))
        assertEquals(Judgment.GREAT, classifyDeltaMs(HitRangesMs.PERFECT + 1.0))
    }

    @Test fun `treats negative and positive deltas symmetrically`() {
        assertEquals(classifyDeltaMs(50.0), classifyDeltaMs(-50.0))
    }

    @Test fun `beyond POOR is MISS`() {
        assertEquals(Judgment.MISS, classifyDeltaMs(HitRangesMs.POOR + 1.0))
        assertEquals(Judgment.MISS, classifyDeltaMs(500.0))
    }
}
