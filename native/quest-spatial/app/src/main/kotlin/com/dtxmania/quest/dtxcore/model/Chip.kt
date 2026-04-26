package com.dtxmania.quest.dtxcore.model

/**
 * Resolution of one measure. Matches CDTX.cs `n小節の解像度 = 384`.
 * All tick offsets inside a measure are in the range [0, MEASURE_TICKS).
 */
const val MEASURE_TICKS = 384

/**
 * One DTX chip — a single sound-producing event, BPM change, or visual
 * marker pulled from a `#MMMCC:...` data line.
 *
 * `playbackTimeMs` starts at 0.0 and is filled in by the timing pass once
 * the BPM map has been resolved. `wavId`, `bpmId`, and `rawBpm` are
 * channel-dependent and null when not applicable.
 */
data class Chip(
    /** Raw channel number as it appears in the DTX file (decimal of the hex pair). */
    val channel: Int,
    /** 0-based measure index (DTX `#MMM` is zero-padded 3 digits). */
    val measure: Int,
    /** Tick offset inside the measure, 0..MEASURE_TICKS-1. */
    val tick: Int,
    /** wavId (1..36^2-1, zz-encoded). Set for sound-producing chips; null otherwise. */
    var wavId: Int? = null,
    /** BPM table id for BPMChangeExtended (channel 0x08) chips. */
    var bpmId: Int? = null,
    /** Direct BPM value for BPMChange (channel 0x03) chips. */
    var rawBpm: Double? = null,
    /** Absolute playback time in ms from song start, filled in by the timing pass. */
    var playbackTimeMs: Double = 0.0,
)

/** A `#WAVxx` definition: a hit-sample file plus per-sample volume / pan. */
data class WavDef(
    /** zz id, 1..(36^2)-1 */
    val id: Int,
    /** Relative path (resolved against the song directory). */
    val path: String,
    /** Volume 0..100. Defaults to 100. */
    val volume: Int = 100,
    /** Pan -100..+100. Defaults to 0. */
    val pan: Int = 0,
)

/**
 * A parsed DTX chart. The `chips`, `bpmTable`, and `wavTable` collections
 * are mutable because the parser builds them incrementally and the timing
 * pass mutates `chips` (sorts in place + assigns playbackTimeMs).
 */
class Song(
    var title: String = "",
    var artist: String = "",
    var genre: String = "",
    var comment: String = "",
    /** #BPM (main, starting BPM). */
    var baseBpm: Double = 120.0,
    /**
     * #BASEBPM, added to every channel-0x03 BPM-change value. Defaults to 0
     * (so channel 0x03 effectively sets absolute BPM 0..255).
     */
    var basebpmOffset: Double = 0.0,
    /** #BPMxx values keyed by xx id. */
    val bpmTable: MutableMap<Int, Double> = mutableMapOf(),
    /** #WAVxx definitions keyed by xx id. */
    val wavTable: MutableMap<Int, WavDef> = mutableMapOf(),
    /** #DLEVEL, 0..1000. */
    var drumLevel: Int = 0,
    var panel: String = "",
    var preview: String = "",
    var preimage: String = "",
    var stageFile: String = "",
    var background: String = "",
    /** All parsed chips, sorted by playbackTimeMs after the timing pass. */
    val chips: MutableList<Chip> = mutableListOf(),
    /** Total song duration in ms (last chip's time, or last measure end). */
    var durationMs: Double = 0.0,
)

fun createEmptySong(): Song = Song()
