package com.dtxmania.quest.dtxcore.parser

import com.dtxmania.quest.dtxcore.model.Channel
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/parser.test.ts`.
 */
class ParserTest {
    @Test fun `parses metadata`() {
        val dtx = listOf(
            "#TITLE Test Song",
            "#ARTIST Some Artist",
            "#GENRE Rock",
            "#BPM 145",
            "#DLEVEL 550",
        ).joinToString("\n")

        val song = parseDtx(dtx)
        assertEquals("Test Song", song.title)
        assertEquals("Some Artist", song.artist)
        assertEquals("Rock", song.genre)
        assertEquals(145.0, song.baseBpm, 0.0)
        assertEquals(550, song.drumLevel)
    }

    @Test fun `parses WAV definitions with volume and pan`() {
        val dtx = listOf(
            "#WAV01 kick.wav",
            "#WAVVOL01 80",
            "#WAVPAN01 -20",
            "#WAV02 snare.wav",
            "#VOLUME02 90",
            "#PAN02 10",
        ).joinToString("\n")

        val song = parseDtx(dtx)
        val w1 = song.wavTable[1]!!
        assertEquals("kick.wav", w1.path)
        assertEquals(80, w1.volume)
        assertEquals(-20, w1.pan)
        val w2 = song.wavTable[2]!!
        assertEquals("snare.wav", w2.path)
        assertEquals(90, w2.volume)
        assertEquals(10, w2.pan)
    }

    @Test fun `parses BPM table`() {
        val dtx = listOf("#BPM01 145", "#BPM02 90.5").joinToString("\n")
        val song = parseDtx(dtx)
        assertEquals(145.0, song.bpmTable[1]!!, 0.0)
        assertEquals(90.5, song.bpmTable[2]!!, 0.0)
    }

    @Test fun `parses chip line with four slots of snare`() {
        // Snare (0x12) at four equal positions (each 1/4 of the measure).
        val dtx = listOf("#BPM 120", "#WAV01 s.wav", "#00012:01010101").joinToString("\n")
        val song = parseDtx(dtx)

        val snare = song.chips.filter { it.channel == Channel.SNARE }
        assertEquals(4, snare.size)
        assertEquals(listOf(0, 96, 192, 288), snare.map { it.tick })
        assertTrue(snare.all { it.wavId == 1 })
    }

    @Test fun `skips 00 slots`() {
        val dtx = "#00013:00010002"
        val song = parseDtx(dtx)
        val bd = song.chips.filter { it.channel == Channel.BASS_DRUM }
        assertEquals(2, bd.size)
        assertEquals(listOf(96, 288), bd.map { it.tick }.sorted())
        assertEquals(listOf(1, 2), bd.mapNotNull { it.wavId }.sorted())
    }

    @Test fun `parses BPMChangeExtended chips (channel 0x08)`() {
        val dtx = listOf("#BPM 120", "#BPM01 180", "#00108:01000000").joinToString("\n")
        val song = parseDtx(dtx)
        val bpmChips = song.chips.filter { it.channel == Channel.BPM_CHANGE_EXTENDED }
        assertEquals(1, bpmChips.size)
        assertEquals(1, bpmChips[0].bpmId)
        assertEquals(1, bpmChips[0].measure)
    }

    @Test fun `ignores comments and blank lines`() {
        val dtx = listOf(
            "; a comment",
            "",
            "#TITLE Foo   ; inline",
            "  ",
        ).joinToString("\n")
        val song = parseDtx(dtx)
        assertEquals("Foo", song.title)
    }

    @Test fun `strips UTF-8 BOM`() {
        val dtx = "\uFEFF#TITLE BomSong"
        val song = parseDtx(dtx)
        assertEquals("BomSong", song.title)
    }
}
