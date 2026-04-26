package com.dtxmania.quest.io

import android.content.Context
import com.dtxmania.quest.dtxcore.scanner.INDEX_CACHE_VERSION
import com.dtxmania.quest.dtxcore.scanner.SerializedIndex
import com.dtxmania.quest.dtxcore.scanner.SongIndex
import com.dtxmania.quest.dtxcore.scanner.deserializeIndex
import com.dtxmania.quest.dtxcore.scanner.serializeIndex
import java.io.File
import java.io.IOException

/**
 * App-private file store for the SAF scan cache.
 *
 * Lives at `<app filesDir>/scan-cache.json`. Caller flow:
 *
 *   - On scanner success: [save] writes the serialised index to disk.
 *   - On app start with a saved root URI: [load] returns the previously-
 *     persisted [SongIndex] if the on-disk version matches
 *     [INDEX_CACHE_VERSION]; otherwise it returns null and the caller
 *     does a fresh scan.
 *
 * I/O is blocking and is expected to be invoked from `Dispatchers.IO`.
 * [load] tolerates a missing or corrupt cache file by returning null
 * (corrupt = throws during JSON decode); a stale schema version raises
 * [IllegalArgumentException] from [deserializeIndex] which we catch
 * and treat the same as missing.
 */
class ScanCachePersistence(context: Context) {

    private val cacheFile: File =
        File(context.applicationContext.filesDir, FILE_NAME)

    fun save(index: SongIndex, nowMs: Long = System.currentTimeMillis()) {
        val serialized = serializeIndex(index, nowMs = nowMs)
        cacheFile.writeText(ScanCacheJson.encode(serialized), Charsets.UTF_8)
    }

    /**
     * Read the cache file from disk and decode it into a live
     * [SongIndex]. Returns null if:
     *
     *   - the file does not exist,
     *   - the file is unreadable,
     *   - the JSON is malformed,
     *   - the schema [SerializedIndex.version] doesn't match the
     *     current [INDEX_CACHE_VERSION].
     */
    fun load(): SongIndex? {
        if (!cacheFile.exists()) return null
        return try {
            val json = cacheFile.readText(Charsets.UTF_8)
            val serialized: SerializedIndex = ScanCacheJson.decode(json)
            deserializeIndex(serialized)
        } catch (_: IOException) {
            null
        } catch (_: IllegalArgumentException) {
            // version mismatch (from deserializeIndex) or malformed JSON
            // → drop the cache, force a fresh scan.
            null
        } catch (_: org.json.JSONException) {
            null
        }
    }

    /** Delete the cache file. Used after a clean reinstall or when the
     *  user explicitly resets. */
    fun clear() {
        cacheFile.delete()
    }

    companion object {
        const val FILE_NAME = "scan-cache.json"
    }
}
