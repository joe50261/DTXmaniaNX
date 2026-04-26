package com.dtxmania.quest

import com.dtxmania.quest.app.Stage
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.vr.VRFeature

/**
 * App entry point. Extends the Spatial SDK's [AppSystemActivity], which
 * itself extends `androidx.activity.ComponentActivity` (so the
 * Phase 2 SAF launcher in [com.dtxmania.quest.io.SafBrowser]
 * `registerForActivityResult` continues to work once we wire it in).
 *
 * Lifecycle ordering, per the Spatial SDK contract:
 *   1. [registerFeatures] is called before scene init; we plug VRFeature.
 *   2. `onCreate` runs after super, so any Activity-Result-API
 *      registration must happen there if we add it.
 *   3. [onSceneReady] fires once the OpenXR session + scene graph are
 *      live; that's where [Stage.bootstrap] does its scene setup.
 */
class MainActivity : AppSystemActivity() {

    private lateinit var stage: Stage

    override fun registerFeatures(): List<SpatialFeature> = listOf(
        VRFeature(this),
        // Phase 5+ will add ComposeFeature() once we render UI panels;
        // Phase 7 will add ISDK / castinputforward for controllers.
    )

    override fun onSceneReady() {
        super.onSceneReady()
        stage = Stage(this).also { it.bootstrap() }
    }
}
