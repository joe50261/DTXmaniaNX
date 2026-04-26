package com.dtxmania.quest.app

import com.meta.spatial.toolkit.AppSystemActivity

/**
 * Root spatial scene. Phase 0: bring up an empty passthrough environment
 * so the device cold-boots into MR with the user's real room visible.
 *
 * Subsequent phases wire children in:
 *   - Phase 5: Playfield entity (canvas-textured plane at (0, 1.6, -2.0))
 *   - Phase 6: TitlePanel + SongSelectPanel entities
 *   - Phase 7: controller aim-pose entities + GLTF meshes
 */
class Stage(private val activity: AppSystemActivity) {

    fun bootstrap() {
        enablePassthrough()
        // Phase 5+ scene wiring lands here. Intentionally empty for Phase 0
        // so the smoke test is "boots cleanly into passthrough with no
        // content" — confirms the OpenXR session + manifest flags are
        // correctly wired before any rendering work begins.
    }

    private fun enablePassthrough() {
        // Spatial SDK exposes passthrough as a scene-environment toggle.
        // The exact API name varies across SDK minor versions; verify
        // against the pinned version in libs.versions.toml. Common forms:
        //   activity.scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        //   activity.scene.enablePassthrough(true)
        // The transparent clear color is set so real-world video shows
        // through wherever the scene has not drawn anything.
        // TODO(phase-0-verify): wire this up against the pinned SDK.
    }
}
