package com.dtxmania.quest

import android.os.Bundle
import android.util.Log
import com.dtxmania.quest.app.Stage
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature

/**
 * App entry point. Extends the Spatial SDK's [AppSystemActivity], which
 * itself extends `androidx.activity.ComponentActivity` (so the
 * Phase 2 SAF launcher in [com.dtxmania.quest.io.SafBrowser]
 * `registerForActivityResult` continues to work once we wire it in).
 *
 * Lifecycle, per the Spatial SDK contract:
 *
 *   1. [registerFeatures] is called before scene init; we plug VRFeature.
 *   2. [onCreate] runs after super; this is where we
 *        - disable locomotion (rhythm gameplay is stationary; teleport
 *          would interfere with arm movement),
 *        - turn on passthrough so the user's real room shows behind
 *          the (still empty) scene.
 *      Both calls match the order used by the SDK's MixedRealitySample.
 *   3. [onSceneReady] fires once the OpenXR session + scene graph are
 *      live; that's where [Stage.bootstrap] sets lighting.
 *
 * Logs are emitted with tag `dtxmania` so on-device debugging can
 * filter via `adb logcat -s dtxmania:* AndroidRuntime:*`.
 */
class MainActivity : AppSystemActivity() {

    private lateinit var stage: Stage

    override fun registerFeatures(): List<SpatialFeature> {
        Log.i(TAG, "registerFeatures()")
        return listOf(
            VRFeature(this),
            // Phase 5+ will add ComposeFeature() once we render UI panels;
            // Phase 7 will add ISDK / castinputforward for controllers.
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "onCreate() — enabling MR mode")
        // Match MixedRealitySample lines 96–97:
        //   systemManager.findSystem<LocomotionSystem>().enableLocomotion(false)
        //   scene.enablePassthrough(true)
        // The previous Phase 4 commit assumed "no skybox = OS draws
        // passthrough automatically"; that's wrong — the Spatial SDK's
        // default scene clear is opaque black. Explicit
        // enablePassthrough(true) is required for MR.
        systemManager.findSystem<LocomotionSystem>().enableLocomotion(false)
        scene.enablePassthrough(true)
    }

    override fun onSceneReady() {
        super.onSceneReady()
        Log.i(TAG, "onSceneReady() — bootstrapping Stage")
        stage = Stage(this).also { it.bootstrap() }
    }

    companion object {
        const val TAG = "dtxmania"
    }
}
