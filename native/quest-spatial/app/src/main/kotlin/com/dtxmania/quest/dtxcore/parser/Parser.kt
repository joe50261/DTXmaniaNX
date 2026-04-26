package com.dtxmania.quest.dtxcore.parser

import com.dtxmania.quest.dtxcore.model.Channel
import com.dtxmania.quest.dtxcore.model.Chip
import com.dtxmania.quest.dtxcore.model.MEASURE_TICKS
import com.dtxmania.quest.dtxcore.model.Song
import com.dtxmania.quest.dtxcore.model.WavDef
import com.dtxmania.quest.dtxcore.model.createEmptySong

/**
 * DTX text-file parser.
 *
 * The DTX format (DTXMania's own) is a superset/variant of BMS. Lines
 * either declare metadata (`#TITLE Foo`), declare indexed resources
 * (`#WAV0A file.wav`, `#BPM03 145`), or embed chip data for one
 * measure + channel (`#001_11: 01000200` = measure 0, channel 0x11,
 * eight half-sixteenth slots).
 *
 * Ported from `web/packages/dtx-core/src/parser/parser.ts`, which is
 * itself a v1-scoped port of CDTX.cs:4789-6569 (DTX + drums only).
 */

data class ParseOptions(
    /** If true, channels this parser does not recognise are silently dropped. */
    val ignoreUnknownChannels: Boolean = true,
)

/** Regex for `#MMMCC:DATA` chip lines. MMM=3 digits 0-9, CC=2 hex chars. */
private val CHIP_LINE = Regex("""^#(\d{3})([0-9A-Fa-f]{2}):?\s*([^;]*?)(?:;.*)?$""")

/** Regex for metadata/resource commands, e.g. `#TITLE value` or `#WAV0A path`. */
private val COMMAND_LINE = Regex("""^#([A-Za-z_][A-Za-z0-9_]*?)(?:\s+|:\s*)(.*?)(?:\s*;.*)?$""")

private val WHITESPACE = Regex("""\s+""")
private val PAYLOAD_OK = Regex("""^[0-9A-Za-z]*$""")
private val WAV_NAME = Regex("""^WAV([0-9A-Za-z]{2})$""")
private val VOL_NAME = Regex("""^(?:WAVVOL|VOLUME)([0-9A-Za-z]{2})$""")
private val PAN_NAME = Regex("""^(?:WAVPAN|PAN)([0-9A-Za-z]{2})$""")
private val BPM_NAME = Regex("""^BPM([0-9A-Za-z]{2})$""")

fun parseDtx(text: String, options: ParseOptions = ParseOptions()): Song {
    val song = createEmptySong()

    for (rawLine in text.split(Regex("\r?\n"))) {
        val line = stripBom(rawLine).trim()
        if (line.isEmpty() || !line.startsWith("#")) continue

        val chipMatch = CHIP_LINE.matchEntire(line)
        if (chipMatch != null) {
            val payload = chipMatch.groupValues[3].replace(WHITESPACE, "")
            if (PAYLOAD_OK.matches(payload)) {
                ingestChipLine(song, chipMatch, options)
                continue
            }
        }

        val cmdMatch = COMMAND_LINE.matchEntire(line)
        if (cmdMatch != null) {
            ingestCommand(song, cmdMatch.groupValues[1].uppercase(), cmdMatch.groupValues[2])
        }
    }

    return song
}

private fun stripBom(s: String): String =
    if (s.isNotEmpty() && s[0].code == 0xfeff) s.substring(1) else s

private fun ingestChipLine(song: Song, match: MatchResult, opts: ParseOptions) {
    val measure = match.groupValues[1].toInt(10)
    val channel = match.groupValues[2].toInt(16)
    val data = match.groupValues[3].replace(WHITESPACE, "")
    if (data.isEmpty() || data.length % 2 != 0) return

    val knownChannel = channel in KNOWN_CHANNELS
    if (!knownChannel && opts.ignoreUnknownChannels) return

    val slots = data.length / 2
    val tickStep = MEASURE_TICKS.toDouble() / slots

    // Channel 0x03 (direct BPM change) is parsed as 2-digit *hex* (0..255).
    // Every other channel is parsed as 2-digit base-36 (zz id 0..1295).
    // See CDTX.cs:6856-6865.
    val parsePair: (String) -> Int =
        if (channel == Channel.BPM_CHANGE) ::parseHexPair else ::decodeZz

    for (i in 0 until slots) {
        val pair = data.substring(i * 2, i * 2 + 2)
        if (pair == "00") continue
        val value = parsePair(pair)

        val chip = Chip(
            channel = channel,
            measure = measure,
            tick = Math.round(i * tickStep).toInt(),
        )

        when (channel) {
            Channel.BPM_CHANGE_EXTENDED -> chip.bpmId = value
            Channel.BPM_CHANGE -> chip.rawBpm = value.toDouble()
            else -> chip.wavId = value
        }

        song.chips.add(chip)
    }
}

private fun parseHexPair(pair: String): Int =
    pair.toIntOrNull(16)
        ?: throw IllegalArgumentException("invalid hex pair: \"$pair\"")

private val KNOWN_CHANNELS: Set<Int> = setOf(
    Channel.BGM,
    Channel.BAR_LENGTH,
    Channel.BPM_CHANGE,
    Channel.BPM_CHANGE_EXTENDED,
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
    Channel.BAR_LINE,
    Channel.BEAT_LINE,
)

private fun ingestCommand(song: Song, name: String, value: String) {
    val trimmed = value.trim()

    when (name) {
        "TITLE" -> { song.title = trimmed; return }
        "ARTIST" -> { song.artist = trimmed; return }
        "GENRE" -> { song.genre = trimmed; return }
        "COMMENT" -> { song.comment = trimmed; return }
        "PANEL" -> { song.panel = trimmed; return }
        "PREVIEW" -> { song.preview = trimmed; return }
        "PREIMAGE" -> { song.preimage = trimmed; return }
        "STAGEFILE" -> { song.stageFile = trimmed; return }
        "BACKGROUND", "WALL" -> { song.background = trimmed; return }
        "BPM" -> {
            trimmed.toDoubleOrNull()?.takeIf { it > 0 }?.let { song.baseBpm = it }
            return
        }
        "BASEBPM" -> {
            trimmed.toDoubleOrNull()?.let { song.basebpmOffset = it }
            return
        }
        "DLEVEL" -> {
            trimmed.toIntOrNull()?.let { song.drumLevel = it }
            return
        }
    }

    WAV_NAME.matchEntire(name)?.let {
        val id = decodeZz(it.groupValues[1])
        upsertWav(song, id, path = trimmed)
        return
    }

    VOL_NAME.matchEntire(name)?.let {
        val id = decodeZz(it.groupValues[1])
        val vol = trimmed.toIntOrNull()?.coerceIn(0, 100) ?: 0
        upsertWav(song, id, volume = vol)
        return
    }

    PAN_NAME.matchEntire(name)?.let {
        val id = decodeZz(it.groupValues[1])
        val pan = trimmed.toIntOrNull()?.coerceIn(-100, 100) ?: -100
        upsertWav(song, id, pan = pan)
        return
    }

    BPM_NAME.matchEntire(name)?.let {
        val id = decodeZz(it.groupValues[1])
        trimmed.toDoubleOrNull()?.takeIf { v -> v > 0 }?.let { v -> song.bpmTable[id] = v }
        return
    }
}

private fun upsertWav(
    song: Song,
    id: Int,
    path: String? = null,
    volume: Int? = null,
    pan: Int? = null,
) {
    val existing = song.wavTable[id]
    if (existing != null) {
        song.wavTable[id] = existing.copy(
            path = path ?: existing.path,
            volume = volume ?: existing.volume,
            pan = pan ?: existing.pan,
        )
    } else {
        song.wavTable[id] = WavDef(
            id = id,
            path = path ?: "",
            volume = volume ?: 100,
            pan = pan ?: 0,
        )
    }
}
