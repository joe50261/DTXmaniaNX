package com.dtxmania.quest.dtxcore.scoring

import kotlin.math.abs

/**
 * Judgment windows in milliseconds (absolute delta between hit time and
 * target chip time). Ported from STHitRanges.cs:43-49 default values.
 *
 * A hit qualifies for the tightest window it fits; anything beyond POOR
 * is MISS.
 */
object HitRangesMs {
    const val PERFECT = 34
    const val GREAT = 67
    const val GOOD = 84
    const val POOR = 117
}

enum class Judgment { PERFECT, GREAT, GOOD, POOR, MISS }

fun classifyDeltaMs(deltaMs: Double): Judgment {
    val d = abs(deltaMs)
    return when {
        d <= HitRangesMs.PERFECT -> Judgment.PERFECT
        d <= HitRangesMs.GREAT -> Judgment.GREAT
        d <= HitRangesMs.GOOD -> Judgment.GOOD
        d <= HitRangesMs.POOR -> Judgment.POOR
        else -> Judgment.MISS
    }
}
