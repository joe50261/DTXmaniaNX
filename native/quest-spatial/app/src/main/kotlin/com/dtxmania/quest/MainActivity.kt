package com.dtxmania.quest

import android.app.Activity
import android.os.Bundle
import com.dtxmania.quest.app.Stage

/**
 * Phase 0 stub. Currently extends a vanilla [Activity] so the build
 * does not depend on the Meta Spatial SDK before its Maven coordinates
 * are verified against Meta's official sample project. Once verified,
 * swap the base class to the SDK's `AppSystemActivity` and move the
 * Stage handoff into `onSceneReady()`.
 */
class MainActivity : Activity() {

    private lateinit var stage: Stage

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        stage = Stage().also { it.bootstrap() }
    }
}
