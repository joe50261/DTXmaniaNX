package com.dtxmania.quest.dtxcore.scanner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/setdef.test.ts`.
 */
class SetDefTest {
    @Test fun `parses a single block with all 5 difficulties`() {
        val txt = listOf(
            "#TITLE My Song",
            "#L1FILE nov.dtx",
            "#L2FILE reg.dtx",
            "#L3FILE exp.dtx",
            "#L4FILE mas.dtx",
            "#L5FILE dtx.dtx",
        ).joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals(1, blocks.size)
        assertEquals("My Song", blocks[0].title)
        assertEquals(
            listOf("nov.dtx", "reg.dtx", "exp.dtx", "mas.dtx", "dtx.dtx"),
            blocks[0].files,
        )
        assertEquals(SET_DEF_DEFAULT_LABELS, blocks[0].labels)
    }

    @Test fun `parses multiple blocks separated by TITLE`() {
        val txt = listOf(
            "#TITLE A",
            "#L1FILE a.dtx",
            "#TITLE B",
            "#L1FILE b.dtx",
        ).joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals(2, blocks.size)
        assertEquals("A", blocks[0].title)
        assertEquals("B", blocks[1].title)
    }

    @Test fun `respects custom labels`() {
        val txt = listOf("#TITLE Foo", "#L1LABEL EASY", "#L1FILE foo.dtx").joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals("EASY", blocks[0].labels[0])
    }

    @Test fun `drops labels that have no file`() {
        val txt = listOf(
            "#TITLE Foo",
            "#L1LABEL NOVICE",  // no file -> label dropped
            "#L2LABEL REGULAR",
            "#L2FILE reg.dtx",
        ).joinToString("\n")
        val blocks = parseSetDef(txt)
        assertNull(blocks[0].labels[0])
        assertEquals("REGULAR", blocks[0].labels[1])
        assertEquals("reg.dtx", blocks[0].files[1])
    }

    @Test fun `skips comments and blank lines`() {
        val txt = listOf(
            "; comment",
            "",
            "#TITLE Foo   ; trailing",
            "#L1FILE foo.dtx",
        ).joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals("Foo", blocks[0].title)
    }

    @Test fun `accepts colon-separated syntax`() {
        val txt = listOf("#TITLE: Colon Syntax", "#L1FILE: foo.dtx").joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals("Colon Syntax", blocks[0].title)
        assertEquals("foo.dtx", blocks[0].files[0])
    }

    @Test fun `parses FONTCOLOR`() {
        val txt = listOf("#TITLE Foo", "#FONTCOLOR FF0000", "#L1FILE foo.dtx").joinToString("\n")
        val blocks = parseSetDef(txt)
        assertEquals("#FF0000", blocks[0].fontColor)
    }
}
