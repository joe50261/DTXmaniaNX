package com.dtxmania.quest.app

/**
 * Root spatial scene. Phase 0 stub — once the Meta Spatial SDK
 * dependency is wired in (see gradle/libs.versions.toml), this class
 * will:
 *
 *   - hold a reference to the SDK's scene/activity handle,
 *   - enable the passthrough environment layer so the user's real
 *     room is visible behind the playfield (rhythm gameplay involves
 *     arm movement; passthrough is a safety requirement, not an
 *     optional feature),
 *   - host child entities for the playfield (Phase 5), title /
 *     song-select panels (Phase 6), and controllers (Phase 7).
 *
 * Until then, [bootstrap] is a no-op so the toolchain (Gradle / Kotlin
 * / JUnit / AGP) can be exercised in CI without the SDK present.
 */
class Stage {
    fun bootstrap() {
        // TODO(spatial-sdk): enable passthrough + register scene systems
        //                    once SDK coordinates are pinned.
    }
}
