package com.dtxmania.quest.dtxcore.timing

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.model.Chip
import com.dtxmania.quest.dtxcore.model.MEASURE_TICKS
import com.dtxmania.quest.dtxcore.model.Song

/**
 * Fills in `chip.playbackTimeMs` for every chip in the song, sorts chips
 * chronologically, and sets `song.durationMs`.
 *
 * Algorithm: walk chips in (measure, tick) order with a running
 * `currentBpm`. Each tick advanced adds
 * `(deltaTicks / MEASURE_TICKS) * measureDurationMs(currentBpm)` to the
 * accumulated time. BPM changes apply *after* the chip that triggered
 * them is scheduled, so a chip at the same tick as a BPM change is still
 * timed with the previous BPM (matching DTXMania's behaviour).
 *
 * 4/4 is assumed. BarLength (#MMM02: N) is ignored in v1 (rare in drum
 * charts).
 *
 * Ported from `web/packages/dtx-core/src/timing/timing.ts`.
 */
fun computeTiming(song: Song): Song {
    val chips = song.chips
    chips.sortWith(::compareChipsByPosition)

    if (chips.isEmpty()) {
        song.durationMs = 0.0
        return song
    }

    var currentBpm = if (song.baseBpm > 0) song.baseBpm else 120.0
    var currentMeasure = 0
    var lastTickInMeasure = 0
    var lastTickTimeMs = 0.0

    for (chip in chips) {
        // Close out intermediate measures at whatever BPM is currently running.
        while (currentMeasure < chip.measure) {
            val remTicks = MEASURE_TICKS - lastTickInMeasure
            val remMs = (remTicks.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
            lastTickTimeMs += remMs
            currentMeasure += 1
            lastTickInMeasure = 0
        }

        // Advance to chip.tick within the current measure.
        val tickDelta = chip.tick - lastTickInMeasure
        val msDelta = (tickDelta.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
        chip.playbackTimeMs = lastTickTimeMs + msDelta
        lastTickInMeasure = chip.tick
        lastTickTimeMs = chip.playbackTimeMs

        // Apply BPM change *after* scheduling this chip.
        when {
            chip.channel == Channel.BPM_CHANGE_EXTENDED && chip.bpmId != null -> {
                val next = song.bpmTable[chip.bpmId]
                if (next != null && next > 0) currentBpm = next
            }
            chip.channel == Channel.BPM_CHANGE && chip.rawBpm != null -> {
                // Channel 0x03: bpm = BASEBPM + hexValue (CDTX.cs:3799).
                val next = song.basebpmOffset + chip.rawBpm!!
                if (next > 0) currentBpm = next
            }
        }
    }

    // Duration = last chip + remainder of its measure at the current BPM.
    val lastChip = chips.last()
    val remTicks = MEASURE_TICKS - lastChip.tick
    val remMs = (remTicks.toDouble() / MEASURE_TICKS) * measureDurationMs(currentBpm)
    song.durationMs = lastChip.playbackTimeMs + remMs

    chips.sortBy { it.playbackTimeMs }
    return song
}

private fun compareChipsByPosition(a: Chip, b: Chip): Int {
    if (a.measure != b.measure) return a.measure - b.measure
    if (a.tick != b.tick) return a.tick - b.tick
    // Stable within a tick; control channels first keeps semantics explicit.
    return controlRank(a.channel) - controlRank(b.channel)
}

private fun controlRank(channel: Int): Int = when (channel) {
    Channel.BPM_CHANGE, Channel.BPM_CHANGE_EXTENDED -> 0
    Channel.BAR_LENGTH -> 1
    else -> 2
}

fun measureDurationMs(bpm: Double): Double = (60.0 / bpm) * 4 * 1000
