package com.dtxmania.quest.dtxcore.scanner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/boxdef.test.ts`.
 */
class BoxDefTest {
    @Test fun `returns an empty meta for an empty file`() {
        assertEquals(BoxDefMeta(), parseBoxDef(""))
    }

    @Test fun `parses the common directive set`() {
        val text = listOf(
            "#TITLE    Modern Jazz",
            "#ARTIST   Various",
            "#GENRE    Jazz",
            "#COMMENT  A selection of smooth tracks",
            "#FONTCOLOR #0099FF",
            "#PREIMAGE cover.png",
        ).joinToString("\n")
        val meta = parseBoxDef(text)
        assertEquals("Modern Jazz", meta.title)
        assertEquals("Various", meta.artist)
        assertEquals("Jazz", meta.genre)
        assertEquals("A selection of smooth tracks", meta.comment)
        assertEquals("#0099FF", meta.fontColor)
        assertEquals("cover.png", meta.preimage)
    }

    @Test fun `is case-insensitive on directive names`() {
        val text = "#title Rock\n#FontColor #ff0000"
        val meta = parseBoxDef(text)
        assertEquals("Rock", meta.title)
        assertEquals("#ff0000", meta.fontColor)
    }

    @Test fun `silently skips unknown directives and semicolon comments`() {
        val text = listOf(
            "; author - somebody",
            "#TITLE Real",
            "#SKINPATH custom",      // ignored
            "#DRUMPERFECTRANGE 34",  // ignored
        ).joinToString("\n")
        val meta = parseBoxDef(text)
        assertEquals("Real", meta.title)
        assertNull(meta.fontColor)
    }

    @Test fun `strips a UTF-8 BOM on the first line`() {
        val text = "﻿#TITLE Beep"
        assertEquals("Beep", parseBoxDef(text).title)
    }

    @Test fun `ignores lines without a value`() {
        val text = "#TITLE \n#ARTIST "
        val meta = parseBoxDef(text)
        assertNull(meta.title)
        assertNull(meta.artist)
    }

    @Test fun `accepts COLOR as an alias for FONTCOLOR`() {
        assertEquals("#123456", parseBoxDef("#COLOR #123456").fontColor)
    }
}
