package com.dtxmania.quest.dtxcore.model

/**
 * DTX channel codes. Values match the decimal equivalents of the two-character
 * hex channel codes used in `#MMMCC:...` data lines (e.g. "11" hex = 17 dec
 * = HI_HAT_CLOSE).
 *
 * Ported from `web/packages/dtx-core/src/model/channel.ts`, which itself
 * traces back to `DTXMania/Code/Score,Song/EChannel.cs`. Only the channels
 * that v1 actually handles are named; everything else is left as a numeric
 * literal if encountered by the parser.
 */
object Channel {
    const val INVALID = -1
    const val NIL = 0

    // Control channels
    const val BGM = 1
    const val BAR_LENGTH = 2
    const val BPM_CHANGE = 3
    const val BPM_CHANGE_EXTENDED = 8

    // Drum lanes (0x11..0x1C)
    const val HI_HAT_CLOSE = 0x11
    const val SNARE = 0x12
    const val BASS_DRUM = 0x13
    const val HIGH_TOM = 0x14
    const val LOW_TOM = 0x15
    const val CYMBAL = 0x16
    const val FLOOR_TOM = 0x17
    const val HI_HAT_OPEN = 0x18
    const val RIDE_CYMBAL = 0x19
    const val LEFT_CYMBAL = 0x1a
    const val LEFT_PEDAL = 0x1b
    const val LEFT_BASS_DRUM = 0x1c

    // Visual-only channels v1 tolerates but does not render
    const val BAR_LINE = 0x50
    const val BEAT_LINE = 0x51
    const val MOVIE = 0x54
}

private val DRUM_LANES: Set<Int> = setOf(
    Channel.HI_HAT_CLOSE,
    Channel.SNARE,
    Channel.BASS_DRUM,
    Channel.HIGH_TOM,
    Channel.LOW_TOM,
    Channel.CYMBAL,
    Channel.FLOOR_TOM,
    Channel.HI_HAT_OPEN,
    Channel.RIDE_CYMBAL,
    Channel.LEFT_CYMBAL,
    Channel.LEFT_PEDAL,
    Channel.LEFT_BASS_DRUM,
)

fun isDrumLane(channel: Int): Boolean = channel in DRUM_LANES

fun isBpmChange(channel: Int): Boolean =
    channel == Channel.BPM_CHANGE || channel == Channel.BPM_CHANGE_EXTENDED
