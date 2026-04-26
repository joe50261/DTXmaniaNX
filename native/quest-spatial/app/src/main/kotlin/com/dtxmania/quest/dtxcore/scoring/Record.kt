package com.dtxmania.quest.dtxcore.scoring

/**
 * Persistent best-of record for a single chart. Stored per `chartPath`
 * (the scanner's relative path) because that's the one stable ID
 * between scans — `SongEntry.title` can change across re-rips and
 * `ChartEntry` itself is recreated each scan.
 *
 * `bestScore` / `bestRank` / `bestAchievement` are running maxima.
 * `fullCombo` / `excellent` are sticky flags (once true, stay true
 * across worse plays). `plays` and `lastPlayedMs` are always bumped.
 *
 * Per-judgment counts aren't persisted yet — if we start showing
 * detailed per-chart stats later (fastest play, best perfect %), those
 * would get added alongside rather than replacing the simple record
 * shape.
 *
 * Ported from `web/packages/dtx-core/src/scoring/record.ts`.
 */
data class ChartRecord(
    val chartPath: String,
    val bestScore: Int,
    val bestRank: Rank,
    /** DTXmania achievement rate (0..100). Persisted alongside the rank
     *  so the UI can show both without recomputing. */
    val bestAchievement: Double,
    val fullCombo: Boolean,
    val excellent: Boolean,
    val plays: Int,
    val lastPlayedMs: Long,
)

private val RANK_ORDER: Map<Rank, Int> = mapOf(
    Rank.SS to 6,
    Rank.S to 5,
    Rank.A to 4,
    Rank.B to 3,
    Rank.C to 2,
    Rank.D to 1,
    Rank.E to 0,
)

/**
 * Merge a just-finished play's snapshot into the previous record for
 * the same chart. `prev` may be null (first play).
 *
 * Always bumps `plays` and `lastPlayedMs`; score / rank / achievement
 * take the max; medals are OR-sticky so a single future full-combo play
 * is enough to light the lamp forever.
 */
fun mergeChartRecord(
    chartPath: String,
    prev: ChartRecord?,
    snap: ScoreSnapshot,
    nowMs: Long = System.currentTimeMillis(),
): ChartRecord {
    val rate = computeAchievementRate(snap)
    val rank = computeRank(rate, snap.totalNotes)
    val fc = isFullCombo(snap)
    val ex = isExcellent(snap)

    if (prev == null) {
        return ChartRecord(
            chartPath = chartPath,
            bestScore = snap.score,
            bestRank = rank,
            bestAchievement = rate,
            fullCombo = fc,
            excellent = ex,
            plays = 1,
            lastPlayedMs = nowMs,
        )
    }

    val bestScore = maxOf(prev.bestScore, snap.score)
    val bestAchievement = maxOf(prev.bestAchievement, rate)
    val bestRank = if ((RANK_ORDER[rank] ?: 0) > (RANK_ORDER[prev.bestRank] ?: 0)) rank else prev.bestRank
    return ChartRecord(
        chartPath = chartPath,
        bestScore = bestScore,
        bestRank = bestRank,
        bestAchievement = bestAchievement,
        fullCombo = prev.fullCombo || fc,
        excellent = prev.excellent || ex,
        plays = prev.plays + 1,
        lastPlayedMs = nowMs,
    )
}

/**
 * Utility for tests / UI — just to make the count-access pattern
 * explicit. Returns 0 for missing keys.
 *
 * Per-judgment persistence was deliberately omitted from the v1 record
 * shape; call sites that need this in the future should update
 * [mergeChartRecord] + bump the IDB / SharedPreferences schema version.
 */
@Suppress("UNUSED_PARAMETER")
fun recordJudgmentCount(rec: ChartRecord?, j: Judgment): Int = 0
