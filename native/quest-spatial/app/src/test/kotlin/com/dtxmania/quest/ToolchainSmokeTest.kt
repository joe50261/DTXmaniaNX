package com.dtxmania.quest

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Confirms the Gradle + Kotlin + JUnit 5 toolchain works end to end.
 * The dtx-core Kotlin port (Phase 1) will use this same test path,
 * with one JUnit case per Vitest case in `web/packages/dtx-core/test`.
 */
class ToolchainSmokeTest {
    @Test
    fun toolchainBoots() {
        assertEquals(4, 2 + 2)
    }
}
