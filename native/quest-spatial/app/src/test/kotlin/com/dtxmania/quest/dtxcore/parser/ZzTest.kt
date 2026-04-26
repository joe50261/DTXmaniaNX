package com.dtxmania.quest.dtxcore.parser

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Test

/**
 * Ported 1:1 from `web/packages/dtx-core/tests/zz.test.ts`. Each `it(...)`
 * block in the Vitest source maps to one [Test] here with the same
 * fixture values.
 */
class ZzTest {
    @Test fun `decodes 00 as 0`() {
        assertEquals(0, decodeZz("00"))
    }

    @Test fun `decodes 01 as 1`() {
        assertEquals(1, decodeZz("01"))
    }

    @Test fun `decodes 0A as 10`() {
        assertEquals(10, decodeZz("0A"))
    }

    @Test fun `decodes 10 as 36`() {
        assertEquals(36, decodeZz("10"))
    }

    @Test fun `decodes ZZ as 36 squared minus 1`() {
        assertEquals(35 * 36 + 35, decodeZz("ZZ"))
    }

    @Test fun `tolerates lowercase`() {
        assertEquals(decodeZz("AB"), decodeZz("ab"))
    }

    @Test fun `throws on non-base36`() {
        assertThrows<IllegalArgumentException> { decodeZz("!!") }
    }

    @Test fun `throws on wrong length`() {
        assertThrows<IllegalArgumentException> { decodeZz("0") }
        assertThrows<IllegalArgumentException> { decodeZz("000") }
    }
}
