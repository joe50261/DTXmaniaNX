package com.dtxmania.quest.app

import android.util.Log
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity

/**
 * Root spatial scene. Phase 4 scope: bring up an empty MR environment
 * so the device cold-boots into passthrough with the user's real room
 * visible. No content, no panels, no playfield yet — those land in
 * Phases 5–7.
 *
 * Passthrough strategy:
 *
 *   - [MainActivity.onCreate] calls `scene.enablePassthrough(true)` —
 *     the SDK's default scene clear is opaque black; passthrough has
 *     to be explicitly enabled.
 *   - We deliberately do NOT call `scene.updateIBLEnvironment(...)`
 *     and do NOT spawn a skybox mesh: with passthrough on, every
 *     pixel the scene doesn't draw shows the real room.
 *   - `setReferenceSpace(LOCAL_FLOOR)` lets the user recenter; without
 *     it, the headset's pose is unbounded.
 *
 * Subsequent phases wire children in:
 *
 *   - Phase 5: Playfield entity (canvas-textured plane at (0, 1.6, -2.0))
 *   - Phase 6: TitlePanel + SongSelectPanel entities
 *   - Phase 7: controller aim-pose entities + GLTF meshes
 */
class Stage(private val activity: AppSystemActivity) {

    fun bootstrap() {
        Log.i(TAG, "bootstrap() — setting reference space + lighting")
        val scene = activity.scene
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        // Modest ambient + sun fill so any future placed meshes don't
        // render as flat black against the passthrough background.
        // Values mirror the StarterSample's environment except the
        // sun is dimmer (we expect mostly-2D canvas planes, not 3D
        // PBR meshes).
        //
        // No `scene.updateIBLEnvironment(...)` here: that requires a
        // baked `.env` cubemap asset which we don't ship in v1, and
        // calling it without one crashes the renderer.
        scene.setLightingEnvironment(
            ambientColor = Vector3(0.5f, 0.5f, 0.5f),
            sunColor = Vector3(1f, 1f, 1f),
            sunDirection = -Vector3(1f, 3f, -2f),
            environmentIntensity = 0.5f,
        )
    }

    companion object {
        const val TAG = "dtxmania.stage"
    }
}
