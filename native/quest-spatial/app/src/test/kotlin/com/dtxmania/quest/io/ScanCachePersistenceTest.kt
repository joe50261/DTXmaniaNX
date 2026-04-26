package com.dtxmania.quest.io

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.dtxmania.quest.dtxcore.scanner.INDEX_CACHE_VERSION
import com.dtxmania.quest.dtxcore.scanner.ScanOptions
import com.dtxmania.quest.dtxcore.scanner.SongScanner
import com.dtxmania.quest.dtxcore.scanner.makeFs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ScanCachePersistenceTest {

    private lateinit var context: Context
    private lateinit var store: ScanCachePersistence

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        store = ScanCachePersistence(context)
        store.clear()
    }

    @Test
    fun `load returns null when no cache file exists`() {
        assertNull(store.load())
    }

    @Test
    fun `save then load round-trips a real scan`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to "#TITLE Foo\n#ARTIST Band\n#BPM 145",
            "Songs/Pop/a.dtx" to "#TITLE A",
            "Songs/Pop/b.dtx" to "#TITLE B",
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = true)).scan("Songs")
        store.save(live)

        val loaded = store.load()
        assertNotNull(loaded)
        assertEquals(live.songs, loaded!!.songs)
    }

    @Test
    fun `load returns null when cache file is corrupt JSON`() {
        File(context.filesDir, ScanCachePersistence.FILE_NAME)
            .writeText("garbage{{{{ not json")
        assertNull(store.load())
    }

    @Test
    fun `load returns null when schema version is in the future`() {
        // Force a cache with a future version so the next reader treats it
        // as stale rather than blowing up on shape changes the new code
        // doesn't understand.
        val futureVersion = INDEX_CACHE_VERSION + 99
        File(context.filesDir, ScanCachePersistence.FILE_NAME).writeText(
            """
            {
              "version": $futureVersion,
              "rootPath": "Songs",
              "root": {"kind":"box","name":"/","path":"Songs","children":[],"explicit":false},
              "errors": [],
              "scannedAtMs": 0
            }
            """.trimIndent()
        )
        assertNull(store.load())
    }

    @Test
    fun `clear deletes the cache file`() {
        val fs = makeFs(mapOf("Songs/song.dtx" to "#TITLE A"))
        store.save(SongScanner(fs).scan("Songs"))
        store.clear()
        assertNull(store.load())
        assertFalse(File(context.filesDir, ScanCachePersistence.FILE_NAME).exists())
    }
}
