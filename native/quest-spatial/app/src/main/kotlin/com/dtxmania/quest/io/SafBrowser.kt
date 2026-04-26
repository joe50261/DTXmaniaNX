package com.dtxmania.quest.io

import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Wraps Android's Storage Access Framework "open document tree"
 * launcher.
 *
 * Owning [ComponentActivity] must register the launcher during its
 * `onCreate` (Activity Result API restriction). The picked tree URI's
 * persistable read permission is taken before [onPicked] is invoked, so
 * the caller can save the URI and later re-open it after a process
 * restart without re-asking the user.
 *
 * The launcher itself is only invoked from the UI thread; this class is
 * intentionally thin. Building the [com.dtxmania.quest.dtxcore.scanner.FileSystemBackend]
 * from the picked URI happens via [SafSource] and is the caller's job
 * (typically inside a coroutine on `Dispatchers.IO`).
 */
class SafBrowser(
    activity: ComponentActivity,
    private val rootUriStore: RootUriPersistence,
    private val onPicked: (Uri) -> Unit,
) {
    private val launcher: ActivityResultLauncher<Uri?> =
        activity.registerForActivityResult(
            ActivityResultContracts.OpenDocumentTree()
        ) { uri ->
            if (uri != null) {
                activity.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
                rootUriStore.save(uri)
                onPicked(uri)
            }
        }

    /**
     * Show the system's directory picker. [initial] is an optional
     * suggested starting tree URI (e.g. the previously-picked one);
     * pass null to let the system pick a default.
     */
    fun launch(initial: Uri? = null) {
        launcher.launch(initial)
    }
}
