package com.dtxmania.quest.io

import android.content.Context
import android.net.Uri

/**
 * Stores / restores the SAF tree URI the user picked once via
 * [SafBrowser]. Backed by app-private [android.content.SharedPreferences].
 *
 * Survives `adb install -r` updates and reboots. Does **not** survive an
 * uninstall — Android revokes the persistable URI grant when the app is
 * removed, so the cached URI would be useless anyway. On a clean
 * reinstall the user has to re-pick the Songs folder; the diff-scan
 * cache (separate file) makes that cheap because the metadata index is
 * the thing that takes time to rebuild, not the picker.
 */
class RootUriPersistence(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Persist the tree URI that the user picked. */
    fun save(uri: Uri) {
        prefs.edit().putString(KEY_ROOT_URI, uri.toString()).apply()
    }

    /** Retrieve the previously-saved tree URI, or null if unset / cleared. */
    fun load(): Uri? = prefs.getString(KEY_ROOT_URI, null)?.let(Uri::parse)

    /** Clear the saved URI (used after the user explicitly resets). */
    fun clear() {
        prefs.edit().remove(KEY_ROOT_URI).apply()
    }

    companion object {
        const val PREFS_NAME = "dtxmania_quest_prefs"
        const val KEY_ROOT_URI = "saf_root_tree_uri"
    }
}
