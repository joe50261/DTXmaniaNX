package com.dtxmania.quest.dtxcore.scanner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.fail

/**
 * Ported from `web/packages/dtx-core/tests/scanner.test.ts`. Splits
 * roughly along the three describe-blocks in the TS source: the basic
 * SongScanner cases here, plus the explicit-box / integration cases in
 * [ScannerExplicitBoxTest] for readability.
 */
class ScannerTest {

    // ------------------------------------------------------------------
    // SongScanner — basic walk + grouping
    // ------------------------------------------------------------------

    @Test fun `returns a single song for a lone dtx file`() {
        val fs = makeFs(mapOf("Songs/Rock/song.dtx" to "#TITLE Foo"))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        assertEquals("song", index.songs[0].title)
        assertFalse(index.songs[0].fromSetDef)
        assertEquals(1, index.songs[0].charts.size)
        assertEquals("Songs/Rock/song.dtx", index.songs[0].charts[0].chartPath)
    }

    @Test fun `groups difficulties via set def`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/set.def" to listOf(
                "#TITLE My Song",
                "#L1FILE nov.dtx",
                "#L2FILE reg.dtx",
            ).joinToString("\n"),
            "Songs/Rock/nov.dtx" to "#TITLE My Song",
            "Songs/Rock/reg.dtx" to "#TITLE My Song",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        assertEquals("My Song", index.songs[0].title)
        assertTrue(index.songs[0].fromSetDef)
        assertEquals(listOf(0, 1), index.songs[0].charts.map { it.slot })
        assertEquals(listOf("NOVICE", "REGULAR"), index.songs[0].charts.map { it.label })
    }

    @Test fun `drops set def entries whose files are missing on disk`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/set.def" to listOf(
                "#TITLE My Song",
                "#L1FILE missing.dtx",
                "#L2FILE reg.dtx",
            ).joinToString("\n"),
            "Songs/Rock/reg.dtx" to "#TITLE My Song",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs[0].charts.size)
        assertEquals(1, index.songs[0].charts[0].slot)
    }

    @Test fun `recurses into subdirectories`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/a.dtx" to "#TITLE A",
            "Songs/Pop/b.dtx" to "#TITLE B",
            "Songs/Pop/sub/c.dtx" to "#TITLE C",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(listOf("a", "b", "c"), index.songs.map { it.title }.sorted())
    }

    @Test fun `when both set def and bare dtx exist, set def wins (no dupes)`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/set.def" to "#TITLE My Song\n#L1FILE master.dtx",
            "Songs/Rock/master.dtx" to "#TITLE My Song",
            "Songs/Rock/stray.dtx" to "#TITLE Stray", // ignored because set.def present
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        assertEquals("My Song", index.songs[0].title)
    }

    @Test fun `skips system, recycle bin, node_modules by default`() {
        val fs = makeFs(mapOf(
            "Songs/Real/a.dtx" to "#TITLE A",
            "Songs/System/x.dtx" to "#TITLE X",
            "Songs/node_modules/y.dtx" to "#TITLE Y",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(listOf("a"), index.songs.map { it.title }.sorted())
    }

    @Test fun `reports errors instead of throwing when a directory is unreadable`() {
        val fs = makeFs(mapOf("Songs/Rock/a.dtx" to "#TITLE A"))
        // Inject a synthetic listDir failure on Songs/Rock.
        fs.listDirOverride = { p ->
            if (p == "Songs/Rock") throw RuntimeException("EACCES")
            else fs.listDirImpl(p)
        }
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.errors.size)
        assertEquals("Songs/Rock", index.errors[0].path)
        assertEquals(0, index.songs.size)
    }

    @Test fun `parses a UTF-16 LE BOM-prefixed set def (DTXCreator Windows output)`() {
        // Seen in the wild: SET.def saved as UTF-16 LE with BOM.
        // Before BOM detection it decoded as Shift_JIS garbage → 0 blocks
        // → the whole folder fell through to per-.dtx rows instead of grouping.
        fun utf16leWithBom(s: String): ByteArray {
            val body = s.toByteArray(Charsets.UTF_16LE)
            return byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + body
        }
        val fs = MemoryFs()
        fs.setFile(
            "Songs/Rock/SET.def",
            utf16leWithBom(
                listOf(
                    "#TITLE 天ノ弱",
                    "#L1LABEL BASIC",
                    "#L1FILE bsc.dtx",
                    "#L2LABEL ADVANCED",
                    "#L2FILE adv.dtx",
                    "#L3LABEL EXTREME",
                    "#L3FILE ext.dtx",
                    "#L4LABEL MASTER",
                    "#L4FILE mstr.dtx",
                    "",
                ).joinToString("\r\n")
            )
        )
        fs.setFile("Songs/Rock/bsc.dtx", "#TITLE 天ノ弱")
        fs.setFile("Songs/Rock/adv.dtx", "#TITLE 天ノ弱")
        fs.setFile("Songs/Rock/ext.dtx", "#TITLE 天ノ弱")
        fs.setFile("Songs/Rock/mstr.dtx", "#TITLE 天ノ弱")
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        assertEquals("天ノ弱", index.songs[0].title)
        assertTrue(index.songs[0].fromSetDef)
        assertEquals(
            listOf("BASIC", "ADVANCED", "EXTREME", "MASTER"),
            index.songs[0].charts.map { it.label },
        )
    }

    @Test fun `falls back to dtx scan when set def yields zero surviving songs`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/SET.def" to listOf(
                "#TITLE My Song",
                "#L1FILE nonexistent.dtx",
            ).joinToString("\n"),
            "Songs/Rock/bsc.dtx" to "#TITLE B",
            "Songs/Rock/adv.dtx" to "#TITLE A",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(listOf("adv", "bsc"), index.songs.map { it.title }.sorted())
        assertTrue(index.songs.all { !it.fromSetDef })
    }

    @Test fun `fills chart drumLevel and song artist from each dtx header when parseMeta is on`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to listOf(
                "#TITLE Tricky Song",
                "#ARTIST The Band",
                "#GENRE Rock",
                "#BPM 172",
                "#DLEVEL 562",
            ).joinToString("\n"),
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        val song = index.songs[0]
        assertEquals("The Band", song.artist)
        assertEquals("Rock", song.genre)
        assertEquals(172.0, song.bpm)
        assertEquals(562, song.charts[0].drumLevel)
        assertEquals(172.0, song.charts[0].bpm)
    }

    @Test fun `skips header parse when parseMeta is disabled`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to "#TITLE X\n#ARTIST Y\n#DLEVEL 300",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        assertNull(index.songs[0].artist)
        assertNull(index.songs[0].charts[0].drumLevel)
    }

    @Test fun `only picks up dtx (not gda or bms or bme) in v1`() {
        val fs = makeFs(mapOf(
            "Songs/A/a.dtx" to "#TITLE A",
            "Songs/A/b.gda" to "#TITLE B",
            "Songs/A/c.bms" to "#TITLE C",
        ))
        val index = SongScanner(fs).scan("Songs")
        assertEquals(1, index.songs.size)
        assertEquals("a", index.songs[0].title)
    }

    @Test fun `exposes a folder tree - root box with nested box plus song children`() {
        // Each directory has ≥2 songs so the single-child hoist doesn't kick in.
        val fs = makeFs(mapOf(
            "Songs/Rock/a1.dtx" to "#TITLE A1",
            "Songs/Rock/a2.dtx" to "#TITLE A2",
            "Songs/Pop/Bubblegum/b1.dtx" to "#TITLE B1",
            "Songs/Pop/Bubblegum/b2.dtx" to "#TITLE B2",
            "Songs/Pop/Ballads/c1.dtx" to "#TITLE C1",
            "Songs/Pop/Ballads/c2.dtx" to "#TITLE C2",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        // Flat list still preserved.
        assertEquals(index.songs, flattenSongs(index.root))
        // Root has two child boxes - Rock + Pop.
        val rootBoxes = index.root.children.filterIsInstance<BoxNode>()
        assertEquals(listOf("Pop", "Rock"), rootBoxes.map { it.name }.sorted())
        val pop = rootBoxes.first { it.name == "Pop" }
        assertEquals(2, pop.children.size)
        for (sub in pop.children) {
            val box = sub as? BoxNode ?: fail("expected box")
            assertEquals(2, box.children.size)
            assertTrue(box.children[0] is SongNode)
            assertEquals(pop, box.parent)
        }
    }

    @Test fun `prunes empty boxes so dead folders do not clutter the tree`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/a.dtx" to "#TITLE A",
            "Songs/EmptyDir/placeholder.txt" to "not a chart",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val boxes = index.root.children.filterIsInstance<BoxNode>()
        // Rock has exactly one song → hoisted, so Rock the box disappears.
        assertEquals(0, boxes.size)
        assertEquals(1, index.root.children.size)
        assertTrue(index.root.children[0] is SongNode)
    }

    @Test fun `hoists single-child folders so set def packs do not get a redundant wrapper box`() {
        val fs = makeFs(mapOf(
            "Songs/Pack/set.def" to listOf(
                "#TITLE My Song",
                "#L1FILE easy.dtx",
                "#L2FILE hard.dtx",
            ).joinToString("\n"),
            "Songs/Pack/easy.dtx" to "#TITLE ignored",
            "Songs/Pack/hard.dtx" to "#TITLE ignored",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        assertEquals(1, index.root.children.size)
        val only = index.root.children[0] as? SongNode ?: fail("expected song")
        assertEquals("My Song", only.entry.title)
        assertEquals(index.root, only.parent)
    }

    @Test fun `keeps multi-child folders as boxes (pack with two standalone songs)`() {
        val fs = makeFs(mapOf(
            "Songs/Pack/a.dtx" to "#TITLE A",
            "Songs/Pack/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        assertEquals(1, index.root.children.size)
        val pack = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Pack", pack.name)
        assertEquals(2, pack.children.size)
    }

    @Test fun `cascades - plain folder wrapping another plain folder with one song collapses both`() {
        val fs = makeFs(mapOf(
            "Songs/Outer/Inner/set.def" to listOf(
                "#TITLE Deep Song",
                "#L1FILE only.dtx",
            ).joinToString("\n"),
            "Songs/Outer/Inner/only.dtx" to "",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        // Inner has 1 song → hoisted into Outer; Outer then has 1 child (that
        // song) → hoisted into root. Both wrappers disappear.
        assertEquals(1, index.root.children.size)
        val only = index.root.children[0] as? SongNode ?: fail("expected song")
        assertEquals("Deep Song", only.entry.title)
    }

    @Test fun `fills preview, preimage, comment metadata when parseMeta is on`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/song.dtx" to listOf(
                "#TITLE Foo",
                "#ARTIST Someone",
                "#PREVIEW pv.wav",
                "#PREIMAGE cover.png",
                "#COMMENT A short blurb",
            ).joinToString("\n"),
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = true)).scan("Songs")
        assertEquals("pv.wav", index.songs[0].preview)
        assertEquals("cover.png", index.songs[0].preimage)
        assertEquals("A short blurb", index.songs[0].comment)
    }

    // ------------------------------------------------------------------
    // serialize / deserialize scan cache
    // ------------------------------------------------------------------

    @Test fun `serialize and deserialize round-trips a scanned tree, rebuilding parent refs`() {
        val fs = makeFs(mapOf(
            "Songs/Rock/a1.dtx" to "#TITLE A1\n#ARTIST Band",
            "Songs/Rock/a2.dtx" to "#TITLE A2",
            "Songs/Pop/set.def" to listOf(
                "#TITLE Pop Pack Song",
                "#L1FILE easy.dtx",
                "#L2FILE hard.dtx",
            ).joinToString("\n"),
            "Songs/Pop/easy.dtx" to "#TITLE ignored",
            "Songs/Pop/hard.dtx" to "#TITLE ignored",
            "Songs/Pop/filler.dtx" to "#TITLE keeps Pop multi-entry",
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = true)).scan("Songs")
        val serialized = serializeIndex(live)
        assertEquals(INDEX_CACHE_VERSION, serialized.version)
        // Round-trip: serialize → deserialize. The TS source does this
        // via JSON.parse(JSON.stringify(...)); our data classes have value
        // semantics, so going straight serialized → deserialize is equivalent.
        val restored = deserializeIndex(serialized)

        // Songs list identical (order + content).
        assertEquals(live.songs, restored.songs)

        // Every node's parent must be the box that contains it.
        fun visit(node: LibraryNode) {
            when (node) {
                is SongNode -> { /* leaf */ }
                is BoxNode -> {
                    for (child in node.children) {
                        when (child) {
                            is SongNode -> assertEquals(node, child.parent)
                            is BoxNode -> {
                                assertEquals(node, child.parent)
                                visit(child)
                            }
                        }
                    }
                }
            }
        }
        visit(restored.root)
        assertNull(restored.root.parent)
    }

    @Test fun `deserialize throws on mismatched cache version`() {
        val stale = SerializedIndex(
            version = INDEX_CACHE_VERSION + 99,
            rootPath = "Songs",
            root = SerializedBox(name = "/", path = "Songs", children = emptyList()),
            errors = emptyList(),
            scannedAtMs = 0L,
        )
        val ex = assertThrows(IllegalArgumentException::class.java) {
            deserializeIndex(stale)
        }
        assertNotNull(ex.message)
        assertTrue(ex.message!!.contains("version"))
    }
}
