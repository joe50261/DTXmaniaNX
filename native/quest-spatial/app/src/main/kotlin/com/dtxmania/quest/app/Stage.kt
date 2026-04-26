package com.dtxmania.quest.app

import android.util.Log
import androidx.core.net.toUri
import com.dtxmania.quest.R
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.MeshCollision
import com.meta.spatial.toolkit.Transform

/**
 * Root spatial scene. Phase 4 + verification quad: bring up MR
 * passthrough and put one small cyan cube 1.5 m in front of the user
 * so we can confirm the Spatial SDK actually renders the scene we
 * configure.
 *
 * Passthrough strategy is unchanged from the previous Phase 4 commit:
 *
 *   - [com.dtxmania.quest.MainActivity.onCreate] calls
 *     `scene.enablePassthrough(true)` (the SDK's default scene clear
 *     is opaque black; passthrough has to be explicitly enabled).
 *   - We deliberately do NOT call `scene.updateIBLEnvironment(...)`
 *     and do NOT spawn a skybox mesh: with passthrough on, every
 *     pixel the scene doesn't draw shows the real room. The cyan
 *     cube only covers a tiny fraction of the FOV, so the rest
 *     stays passthrough.
 *   - `setReferenceSpace(LOCAL_FLOOR)` lets the user recenter; without
 *     it, the headset's pose is unbounded.
 *
 * Subsequent phases wire children in:
 *
 *   - Phase 5: Playfield entity (canvas-textured plane at (0, 1.6, -2.0))
 *     replaces the verification quad below.
 *   - Phase 6: TitlePanel + SongSelectPanel entities.
 *   - Phase 7: controller aim-pose entities + GLTF meshes.
 */
class Stage(private val activity: AppSystemActivity) {

    fun bootstrap() {
        Log.i(TAG, "bootstrap() — setting reference space + lighting + test quad")
        val scene = activity.scene
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        scene.setLightingEnvironment(
            ambientColor = Vector3(0.5f, 0.5f, 0.5f),
            sunColor = Vector3(1f, 1f, 1f),
            sunDirection = -Vector3(1f, 3f, -2f),
            environmentIntensity = 0.5f,
        )
        spawnVerificationQuad()
    }

    /**
     * Place a small cyan cube 1.5 m in front of the user, slightly
     * below eye level (LOCAL_FLOOR puts y=0 at the floor; a typical
     * adult eye height is ~1.6 m, so y=1.4 is roughly chest level).
     *
     * The mesh URI `mesh://box` is one of the Spatial SDK toolkit's
     * built-in primitive shapes; the Material gets a cyan drawable
     * as a texture (Material.baseColor isn't a documented field on
     * 0.12 — using a textured approach matches what the SDK samples
     * use for solid colours).
     */
    private fun spawnVerificationQuad() {
        Entity.create(
            listOf(
                Mesh("mesh://box".toUri(), hittable = MeshCollision.NoCollision),
                Material().apply {
                    baseTextureAndroidResourceId = R.drawable.test_quad
                    unlit = true
                },
                Transform(Pose(Vector3(x = 0f, y = 1.4f, z = -1.5f))),
            )
        )
    }

    companion object {
        const val TAG = "dtxmania.stage"
    }
}
