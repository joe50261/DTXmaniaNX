package com.dtxmania.quest

import android.os.Bundle
import androidx.activity.ComponentActivity
import com.dtxmania.quest.app.Stage

/**
 * Phase 0/2 stub. Currently extends [ComponentActivity] (rather than the
 * Spatial SDK's `AppSystemActivity`) so we can register
 * `ActivityResultContracts.OpenDocumentTree` for the Phase 2 SAF picker
 * without first wiring the real SDK base class. Once the Spatial SDK
 * coordinates are pinned, swap the base class to the SDK's
 * `AppSystemActivity` (which itself extends ComponentActivity, so the
 * SAF launcher continues to work).
 */
class MainActivity : ComponentActivity() {

    private lateinit var stage: Stage

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        stage = Stage().also { it.bootstrap() }
    }
}
