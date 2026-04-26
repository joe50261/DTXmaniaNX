package com.dtxmania.quest.io

import com.dtxmania.quest.dtxcore.scanner.BoxNode
import com.dtxmania.quest.dtxcore.scanner.LibraryNode
import com.dtxmania.quest.dtxcore.scanner.MemoryFs
import com.dtxmania.quest.dtxcore.scanner.ScanError
import com.dtxmania.quest.dtxcore.scanner.ScanOptions
import com.dtxmania.quest.dtxcore.scanner.SerializedBox
import com.dtxmania.quest.dtxcore.scanner.SerializedIndex
import com.dtxmania.quest.dtxcore.scanner.SerializedSong
import com.dtxmania.quest.dtxcore.scanner.SongScanner
import com.dtxmania.quest.dtxcore.scanner.deserializeIndex
import com.dtxmania.quest.dtxcore.scanner.makeFs
import com.dtxmania.quest.dtxcore.scanner.serializeIndex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Round-trips the serialised scan cache through JSON encoding +
 * decoding via [ScanCacheJson], using a real scan output produced by
 * [SongScanner] with a [MemoryFs].
 *
 * Robolectric is required because Android's `org.json` is provided as
 * a "Stub!" interface in the host JVM `android.jar`. Robolectric
 * supplies a real implementation at unit-test time. Pure JUnit 5 tests
 * outside of `io/` deliberately do not import `ScanCacheJson` to keep
 * `dtxcore/`'s tests Robolectric-free.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanCacheJsonTest {

    @Test
    fun `simple scan round-trips end to end`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to "#TITLE Foo\n#ARTIST Band\n#BPM 145",
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = true)).scan("Songs")

        val serialized = serializeIndex(live, nowMs = 1234567890L)
        val json = ScanCacheJson.encode(serialized)
        val restored = ScanCacheJson.decode(json)

        assertEquals(serialized, restored)
        // Going through deserializeIndex from the decoded SerializedIndex
        // also produces the same songs list as the live scan.
        val rebuilt = deserializeIndex(restored)
        assertEquals(live.songs, rebuilt.songs)
    }

    @Test
    fun `compound tree with explicit boxes and set def round-trips`() {
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.Pack/box.def" to "#TITLE Custom Pack\n#FONTCOLOR #33CC99",
            "Songs/dtxfiles.Pack/set.def" to listOf(
                "#TITLE The Headliner",
                "#L1FILE bsc.dtx",
                "#L2FILE adv.dtx",
            ).joinToString("\n"),
            "Songs/dtxfiles.Pack/bsc.dtx" to "",
            "Songs/dtxfiles.Pack/adv.dtx" to "",
            "Songs/Plain/a.dtx" to "#TITLE A",
            "Songs/Plain/b.dtx" to "#TITLE B",
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")

        val json = ScanCacheJson.encode(serializeIndex(live, nowMs = 99L))
        val restored = ScanCacheJson.decode(json)
        val rebuilt = deserializeIndex(restored)

        // Songs list parity (parent refs are reconstructed by deserializeIndex).
        assertEquals(live.songs, rebuilt.songs)

        // Explicit-box metadata survived the JSON round trip.
        val packBox = rebuilt.root.children
            .filterIsInstance<BoxNode>()
            .first { it.name == "Custom Pack" }
        assertEquals("#33CC99", packBox.fontColor)
        assertEquals(true, packBox.explicit)
    }

    @Test
    fun `nullable fields are omitted from JSON when null`() {
        val empty = SerializedIndex(
            version = com.dtxmania.quest.dtxcore.scanner.INDEX_CACHE_VERSION,
            rootPath = "Songs",
            root = SerializedBox(name = "/", path = "Songs", children = emptyList()),
            errors = emptyList(),
            scannedAtMs = 0L,
        )
        val json = ScanCacheJson.encode(empty)
        // The root box has no fontColor / comment / preimage and no
        // children, so those keys must not be in the output.
        assert(!json.contains("\"fontColor\"")) { json }
        assert(!json.contains("\"comment\"")) { json }
        assert(!json.contains("\"preimage\"")) { json }
        // Decode and verify the round trip preserves nulls / defaults.
        val decoded = ScanCacheJson.decode(json)
        assertEquals(empty, decoded)
    }

    @Test
    fun `decode rejects malformed JSON`() {
        // A non-JSON string surfaces an org.json.JSONException; callers
        // (ScanCachePersistence) catch it and treat the cache as missing.
        assertThrows(org.json.JSONException::class.java) {
            ScanCacheJson.decode("not valid json")
        }
    }

    @Test
    fun `errors list survives round trip`() {
        val withErrors = SerializedIndex(
            version = com.dtxmania.quest.dtxcore.scanner.INDEX_CACHE_VERSION,
            rootPath = "Songs",
            root = SerializedBox(name = "/", path = "Songs", children = emptyList()),
            errors = listOf(
                ScanError(path = "Songs/Bad", message = "EACCES"),
                ScanError(path = "Songs/Worse", message = "boom"),
            ),
            scannedAtMs = 42L,
        )
        val decoded = ScanCacheJson.decode(ScanCacheJson.encode(withErrors))
        assertEquals(withErrors, decoded)
    }

    @Test
    fun `nested song with chart drumLevel and bpm round trips through JSON`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to listOf(
                "#TITLE Tricky",
                "#ARTIST Whoever",
                "#GENRE Rock",
                "#BPM 168",
                "#DLEVEL 723",
            ).joinToString("\n"),
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = true)).scan("Songs")
        val rebuilt = deserializeIndex(
            ScanCacheJson.decode(ScanCacheJson.encode(serializeIndex(live)))
        )
        assertEquals(1, rebuilt.songs.size)
        val song = rebuilt.songs[0]
        assertEquals("Whoever", song.artist)
        assertEquals(168.0, song.bpm)
        assertNotNull(song.charts[0].drumLevel)
        assertEquals(723, song.charts[0].drumLevel)
        assertEquals(168.0, song.charts[0].bpm)
        // ChartEntry.record is intentionally not encoded.
        assertNull(song.charts[0].record)
    }
}
