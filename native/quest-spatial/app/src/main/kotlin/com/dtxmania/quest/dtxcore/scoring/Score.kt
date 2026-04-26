package com.dtxmania.quest.dtxcore.scoring

/**
 * Simplified score state tracker for v1.
 *
 * The final formula is intended to match DTXMania's 1,000,000-point
 * scale (CStagePerfCommonScreen.cs:1675-1827), but the precise
 * combo-based multiplier is deferred until we can A/B against the C#
 * reference.
 *
 * v1 scoring:
 *   base_weight = { PERFECT: 1.0, GREAT: 0.7, GOOD: 0.5, POOR: 0.2, MISS: 0 }
 *   score = (sum of weights / effective) * 1_000_000
 *   effective = totalNotes - autoCount
 *
 * Combo breaks on POOR/MISS. Max combo is tracked separately.
 *
 * Ported from `web/packages/dtx-core/src/scoring/score.ts`.
 */

data class ScoreSnapshot(
    val totalNotes: Int,
    val counts: Map<Judgment, Int>,
    val combo: Int,
    val maxCombo: Int,
    val score: Int,
    /**
     * Number of chips consumed by auto-play (e.g. auto-kick). Excluded
     * from both the 1,000,000-scale score and the rank formula, matching
     * DTXmania (CScoreIni.cs:1571 — `nAuto = nTotal - (P+Gr+Gd+Po+Mi)`).
     */
    val autoCount: Int,
)

/** Letter grade awarded on the result screen. Order mirrors DTXMania's
 *  ERANK enum (SS is best, E is worst). */
enum class Rank { SS, S, A, B, C, D, E }

private val WEIGHTS: Map<Judgment, Double> = mapOf(
    Judgment.PERFECT to 1.0,
    Judgment.GREAT to 0.7,
    Judgment.GOOD to 0.5,
    Judgment.POOR to 0.2,
    Judgment.MISS to 0.0,
)

class ScoreTracker(private val totalNotes: Int) {
    init {
        require(totalNotes >= 0) { "totalNotes must be non-negative" }
    }

    private val counts: MutableMap<Judgment, Int> = mutableMapOf(
        Judgment.PERFECT to 0,
        Judgment.GREAT to 0,
        Judgment.GOOD to 0,
        Judgment.POOR to 0,
        Judgment.MISS to 0,
    )
    private var weightSum = 0.0
    private var combo = 0
    private var maxCombo = 0
    private var autoCount = 0

    fun record(j: Judgment) {
        counts[j] = (counts[j] ?: 0) + 1
        weightSum += WEIGHTS.getValue(j)
        if (j == Judgment.PERFECT || j == Judgment.GREAT || j == Judgment.GOOD) {
            combo += 1
            if (combo > maxCombo) maxCombo = combo
        } else {
            combo = 0
        }
    }

    /**
     * Record an auto-played chip (e.g. a BD chip fired by auto-kick).
     * Does not advance combo, add to any judgment count, or contribute
     * weight — it just removes the chip from the score / rank
     * denominator so the player isn't penalised for notes they didn't
     * play. Mirrors DTXmania's EJudgement.Auto path
     * (CStagePerfCommonScreen.cs:1509-1546).
     */
    fun recordAuto() {
        autoCount += 1
    }

    fun snapshot(): ScoreSnapshot {
        val effective = maxOf(0, totalNotes - autoCount)
        val score = if (effective == 0) {
            0
        } else {
            Math.round((weightSum / effective) * 1_000_000.0).toInt()
        }
        return ScoreSnapshot(
            totalNotes = totalNotes,
            counts = counts.toMap(),
            combo = combo,
            maxCombo = maxCombo,
            score = score,
            autoCount = autoCount,
        )
    }
}

/**
 * DTXMania's achievement rate (0..100), ported from
 * `CScoreIni.tCalculateRank` (CScoreIni.cs:1565-1612). Formula:
 *
 *   rate = 100*P/T * 0.85 + 100*Gr/T * 0.35 + 100*maxCombo/T * 0.15
 *
 * where T = totalNotes - autoCount (auto-played chips are subtracted
 * from the denominator so auto-play doesn't dilute nor inflate the
 * rate). The rate is independent of the 0..1,000,000 display score.
 */
fun computeAchievementRate(snap: ScoreSnapshot): Double {
    val effective = snap.totalNotes - snap.autoCount
    if (effective <= 0) return 0.0
    val p = (countOf(snap, Judgment.PERFECT).toDouble() / effective) * 100
    val g = (countOf(snap, Judgment.GREAT).toDouble() / effective) * 100
    val c = (snap.maxCombo.toDouble() / effective) * 100
    return p * 0.85 + g * 0.35 + c * 0.15
}

/**
 * Rank from achievement rate. Thresholds match CScoreIni.cs:1587-1611.
 * `totalNotes == 0` collapses to E to mirror CActResultRank.cs:140's
 * rankE fallback for empty charts.
 */
fun computeRank(rate: Double, totalNotes: Int): Rank {
    if (totalNotes == 0) return Rank.E
    return when {
        rate >= 95 -> Rank.SS
        rate >= 80 -> Rank.S
        rate >= 73 -> Rank.A
        rate >= 63 -> Rank.B
        rate >= 53 -> Rank.C
        rate >= 45 -> Rank.D
        else -> Rank.E
    }
}

/** All chips hit without POOR or MISS. GOOD counts as still-comboing in DTXMania. */
fun isFullCombo(snap: ScoreSnapshot): Boolean =
    snap.totalNotes > 0 &&
        countOf(snap, Judgment.POOR) == 0 &&
        countOf(snap, Judgment.MISS) == 0

/** Every chip PERFECT. Supersedes full-combo on the result banner. */
fun isExcellent(snap: ScoreSnapshot): Boolean =
    snap.totalNotes > 0 && countOf(snap, Judgment.PERFECT) == snap.totalNotes

private fun countOf(snap: ScoreSnapshot, j: Judgment): Int = snap.counts[j] ?: 0
