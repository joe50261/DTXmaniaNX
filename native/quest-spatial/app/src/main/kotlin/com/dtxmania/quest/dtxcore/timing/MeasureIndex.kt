package com.dtxmania.quest.dtxcore.timing

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.model.Chip
import com.dtxmania.quest.dtxcore.model.MEASURE_TICKS
import com.dtxmania.quest.dtxcore.model.Song

/**
 * Builds a lookup `out[measureIndex] = songMs` covering every measure
 * from 0 to `maxMeasure + 1`. The trailing `maxMeasure + 1` entry is a
 * sentinel for "end of last measure" so loop-end = maxMeasure+1
 * resolves cleanly to `song.durationMs`.
 *
 * Walks chips in (measure, tick) order with a running BPM, mirroring
 * [computeTiming]: BPM changes apply *after* the chip that triggered
 * them, so mid-measure BPM changes correctly influence the tail of that
 * measure.
 *
 * Ported from `web/packages/dtx-core/src/timing/measure-index.ts`.
 */
fun buildMeasureStartMsIndex(song: Song): DoubleArray {
    val ordered = song.chips.sortedWith(::comparePosition)

    val maxMeasure = ordered.lastOrNull()?.measure ?: 0
    val out = DoubleArray(maxMeasure + 2)
    out[0] = 0.0

    var currentBpm = if (song.baseBpm > 0) song.baseBpm else 120.0
    var currentMeasure = 0
    var lastTickInMeasure = 0
    var lastTickTimeMs = 0.0

    for (chip in ordered) {
        while (currentMeasure < chip.measure) {
            val remTicks = MEASURE_TICKS - lastTickInMeasure
            lastTickTimeMs += (remTicks.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
            currentMeasure += 1
            lastTickInMeasure = 0
            out[currentMeasure] = lastTickTimeMs
        }

        val tickDelta = chip.tick - lastTickInMeasure
        lastTickTimeMs += (tickDelta.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
        lastTickInMeasure = chip.tick

        when {
            chip.channel == Channel.BPM_CHANGE_EXTENDED && chip.bpmId != null -> {
                val next = song.bpmTable[chip.bpmId]
                if (next != null && next > 0) currentBpm = next
            }
            chip.channel == Channel.BPM_CHANGE && chip.rawBpm != null -> {
                val next = song.basebpmOffset + chip.rawBpm!!
                if (next > 0) currentBpm = next
            }
        }
    }

    val remTicks = MEASURE_TICKS - lastTickInMeasure
    lastTickTimeMs += (remTicks.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
    out[maxMeasure + 1] = lastTickTimeMs

    return out
}

private fun comparePosition(a: Chip, b: Chip): Int {
    if (a.measure != b.measure) return a.measure - b.measure
    if (a.tick != b.tick) return a.tick - b.tick
    return controlRank(a.channel) - controlRank(b.channel)
}

private fun controlRank(channel: Int): Int = when (channel) {
    Channel.BPM_CHANGE, Channel.BPM_CHANGE_EXTENDED -> 0
    Channel.BAR_LENGTH -> 1
    else -> 2
}
