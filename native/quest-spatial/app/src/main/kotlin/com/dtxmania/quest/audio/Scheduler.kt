package com.dtxmania.quest.audio

import com.dtxmania.quest.dtxcore.model.Chip
import kotlin.math.roundToLong

/**
 * Pure-Kotlin scheduler that converts DTX chip times to AAudio DSP
 * frame numbers and selects the chips that should be enqueued in the
 * next [scheduleAhead] tick.
 *
 * Algorithm (matches the plan §Phase 3 outline):
 *
 *   targetFrame = currentDspFrame + (chip.playbackTimeMs - currentTimeMs)
 *                                    * sampleRate / 1000
 *
 * The scheduler is intentionally stateless — it doesn't track which
 * chips have already been emitted. Callers (the gameplay loop) maintain
 * a running "next chip index" cursor and feed the scheduler the
 * still-unscheduled tail each tick.
 *
 * No I/O, no AAudio dependency, no Android types — fully unit-testable.
 */
class Scheduler(private val sampleRate: Int) {

    init {
        require(sampleRate > 0) { "sampleRate must be positive (got $sampleRate)" }
    }

    /**
     * Convert one chip-time-ms into a target DSP frame.
     *
     * @param chipTimeMs  chip's `playbackTimeMs` from the timing pass
     * @param currentDspFrame  AAudio engine's running frame counter
     * @param currentTimeMs  the song time corresponding to [currentDspFrame]
     */
    fun targetFrameFor(
        chipTimeMs: Double,
        currentDspFrame: Long,
        currentTimeMs: Double,
    ): Long {
        val deltaMs = chipTimeMs - currentTimeMs
        val deltaFrames = deltaMs * sampleRate / 1000.0
        return currentDspFrame + deltaFrames.roundToLong()
    }

    /**
     * Decide which chips to enqueue this tick. Filters [chips] to
     * those whose `playbackTimeMs` falls in
     * `(currentTimeMs, currentTimeMs + lookaheadMs]` and converts each
     * to a [ScheduledEvent] with the absolute DSP frame.
     *
     * The lookahead window is open at the lower bound to keep "already
     * fired this tick" chips from re-firing if the loop runs slightly
     * faster than the frame counter.
     */
    fun scheduleAhead(
        chips: List<Chip>,
        currentDspFrame: Long,
        currentTimeMs: Double,
        lookaheadMs: Double,
    ): List<ScheduledEvent> {
        require(lookaheadMs >= 0) { "lookaheadMs must be non-negative (got $lookaheadMs)" }
        val cutoffMs = currentTimeMs + lookaheadMs
        val out = ArrayList<ScheduledEvent>(0)
        for (chip in chips) {
            val t = chip.playbackTimeMs
            if (t <= currentTimeMs || t > cutoffMs) continue
            val sampleId = chip.wavId ?: continue
            out.add(
                ScheduledEvent(
                    sampleId = sampleId,
                    targetFrame = targetFrameFor(t, currentDspFrame, currentTimeMs),
                    gain = 1f,
                    pan = 0f,
                )
            )
        }
        return out
    }
}

/**
 * One sample-playback event ready to push into the AAudio engine.
 * Mirrors the C++ `dtxmania_audio::ScheduledEvent` struct.
 */
data class ScheduledEvent(
    val sampleId: Int,
    val targetFrame: Long,
    val gain: Float,
    val pan: Float,
)
