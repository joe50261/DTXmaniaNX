package com.dtxmania.quest

import com.dtxmania.quest.app.Stage

// Spatial SDK base activity. The exact import path / lifecycle hook names
// must be verified against the version pinned in gradle/libs.versions.toml
// before the first on-device build — the SDK API has shifted between
// minor versions. The canonical entry point in 0.5.x is the toolkit's
// AppSystemActivity; if the pinned version differs, swap to the matching
// base class but keep the Stage handoff identical.
import com.meta.spatial.toolkit.AppSystemActivity

class MainActivity : AppSystemActivity() {

    private lateinit var stage: Stage

    override fun registerExtraComponents() {
        // Phase 0: no custom ECS components yet. Phase 5 (playfield) will
        // register a LaneCanvas component here that wraps the Bitmap-backed
        // surface texture described in the plan.
    }

    override fun onSceneReady() {
        super.onSceneReady()
        stage = Stage(this).also { it.bootstrap() }
    }
}
