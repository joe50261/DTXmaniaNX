package com.dtxmania.quest.dtxcore.scanner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.fail

/**
 * Ports the `explicit box markers` and `integration: compound library
 * trees` describe-blocks from
 * `web/packages/dtx-core/tests/scanner.test.ts`. Split out from
 * [ScannerTest] so neither file gets impossible to scroll.
 */
class ScannerExplicitBoxTest {

    // ------------------------------------------------------------------
    // explicit box markers (dtxfiles. + box.def)
    // ------------------------------------------------------------------

    @Test fun `dtxfiles prefix auto-boxes the folder and strips the prefix from the title`() {
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.Rock/a.dtx" to "#TITLE A",
            "Songs/dtxfiles.Rock/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val boxes = index.root.children.filterIsInstance<BoxNode>()
        assertEquals(1, boxes.size)
        val box = boxes[0]
        assertEquals("Rock", box.name)
        assertTrue(box.explicit)
    }

    @Test fun `box def TITLE, FONTCOLOR, PREIMAGE override defaults and mark the box explicit`() {
        val fs = makeFs(mapOf(
            "Songs/Jazz/box.def" to listOf(
                "#TITLE Modern Jazz",
                "#FONTCOLOR #0099FF",
                "#PREIMAGE cover.png",
                "#COMMENT Smooth",
            ).joinToString("\n"),
            "Songs/Jazz/a.dtx" to "#TITLE A",
            "Songs/Jazz/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val box = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Modern Jazz", box.name)
        assertEquals("#0099FF", box.fontColor)
        assertEquals("cover.png", box.preimage)
        assertEquals("Smooth", box.comment)
        assertTrue(box.explicit)
    }

    @Test fun `explicit boxes survive the single-child hoist rule even with only one song`() {
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.Pack/only.dtx" to "#TITLE Single",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        // A plain folder with one song would hoist away; the explicit
        // dtxfiles. marker protects this one.
        assertEquals(1, index.root.children.size)
        val box = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Pack", box.name)
        assertEquals(1, box.children.size)
        assertTrue(box.children[0] is SongNode)
    }

    @Test fun `box def title wins over the dtxfiles prefix when both are present`() {
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.OldName/box.def" to "#TITLE Pretty Name",
            "Songs/dtxfiles.OldName/a.dtx" to "#TITLE A",
            "Songs/dtxfiles.OldName/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val box = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Pretty Name", box.name)
        assertTrue(box.explicit)
    }

    @Test fun `serialisation round-trips the new box metadata`() {
        val fs = makeFs(mapOf(
            // MemoryFs decodes as Shift-JIS by default; restrict the
            // fixture to ASCII (the production Shift_JIS path is already
            // covered by the other scanner tests).
            "Songs/dtxfiles.Pop/box.def" to "#TITLE Pop Songs\n#FONTCOLOR #FFAA00",
            "Songs/dtxfiles.Pop/a.dtx" to "#TITLE A",
            "Songs/dtxfiles.Pop/b.dtx" to "#TITLE B",
        ))
        val live = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val restored = deserializeIndex(serializeIndex(live))
        val box = restored.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Pop Songs", box.name)
        assertEquals("#FFAA00", box.fontColor)
        assertTrue(box.explicit)
    }

    // ------------------------------------------------------------------
    // integration: compound library trees
    // ------------------------------------------------------------------

    @Test fun `realistic tree mixing dtxfiles, box def, set def, bare dtx, lone root song`() {
        // Reflects what a real Songs/ folder looks like when a player
        // has authored packs (dtxfiles. prefix, box.def metadata),
        // bought a set.def pack, dragged in a lone chart, and stuffed a
        // stray .dtx at the root.
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.Rock/box.def" to "#TITLE Rock Anthems\n#FONTCOLOR #FF2244",
            "Songs/dtxfiles.Rock/riff1.dtx" to "#TITLE Riff One",
            "Songs/dtxfiles.Rock/riff2.dtx" to "#TITLE Riff Two",
            "Songs/dtxfiles.Rock/Ballads/set.def" to listOf(
                "#TITLE Slow Burn",
                "#L1FILE easy.dtx",
                "#L2FILE hard.dtx",
            ).joinToString("\n"),
            "Songs/dtxfiles.Rock/Ballads/easy.dtx" to "#TITLE ignored",
            "Songs/dtxfiles.Rock/Ballads/hard.dtx" to "#TITLE ignored",
            "Songs/dtxfiles.Pop/Pack/set.def" to "#TITLE Pop Hit\n#L1FILE m.dtx",
            "Songs/dtxfiles.Pop/Pack/m.dtx" to "",
            "Songs/Jazz/box.def" to "#TITLE Smooth Jazz",
            "Songs/Jazz/a.dtx" to "#TITLE Coffeehouse",
            "Songs/Jazz/b.dtx" to "#TITLE Lounge",
            "Songs/stray.dtx" to "#TITLE Stray",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")

        // -- Top-level inventory --------------------------------------
        val rootBoxes = index.root.children.filterIsInstance<BoxNode>()
        val rootSongs = index.root.children.filterIsInstance<SongNode>()
        assertEquals(
            listOf("Pop", "Rock Anthems", "Smooth Jazz").sorted(),
            rootBoxes.map { it.name }.sorted(),
        )
        assertEquals(listOf("stray"), rootSongs.map { it.entry.title })

        // -- Rock Anthems box -----------------------------------------
        val rock = rootBoxes.first { it.name == "Rock Anthems" }
        assertTrue(rock.explicit)
        assertEquals("#FF2244", rock.fontColor)
        val rockSongs = rock.children.filterIsInstance<SongNode>()
            .map { it.entry.title }
            .sorted()
        // riff1 / riff2 from filename stems (parseMeta off); "Slow Burn" is
        // the set.def #TITLE — unaffected by parseMeta.
        assertEquals(listOf("Slow Burn", "riff1", "riff2").sorted(), rockSongs)
        for (child in rock.children) {
            val parent = when (child) {
                is BoxNode -> child.parent
                is SongNode -> child.parent
            }
            assertEquals(rock, parent)
        }

        // -- dtxfiles.Pop box -----------------------------------------
        val pop = rootBoxes.first { it.name == "Pop" }
        assertTrue(pop.explicit)
        assertEquals(1, pop.children.size)
        val popOnly = pop.children[0] as? SongNode ?: fail("expected song")
        assertEquals("Pop Hit", popOnly.entry.title)
        assertEquals(pop, popOnly.parent)

        // -- Smooth Jazz box ------------------------------------------
        val jazz = rootBoxes.first { it.name == "Smooth Jazz" }
        assertTrue(jazz.explicit)
        assertEquals(2, jazz.children.size)

        // -- Flat songs list parity -----------------------------------
        assertEquals(
            listOf("Pop Hit", "Slow Burn", "a", "b", "riff1", "riff2", "stray").sorted(),
            index.songs.map { it.title }.sorted(),
        )
    }

    @Test fun `empty box def folder (no dtx) is still pruned`() {
        val fs = makeFs(mapOf(
            "Songs/Placeholder/box.def" to "#TITLE Coming Soon",
            "Songs/Real/a.dtx" to "#TITLE A",
            "Songs/Real/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        val names = index.root.children.filterIsInstance<BoxNode>().map { it.name }
        assertEquals(listOf("Real"), names)
    }

    @Test fun `box def plus set def in same folder - box metadata applies, set def groups charts`() {
        val fs = makeFs(mapOf(
            "Songs/dtxfiles.Pack/box.def" to listOf(
                "#TITLE Custom Pack",
                "#FONTCOLOR #33CC99",
                "#COMMENT Hand-picked",
            ).joinToString("\n"),
            "Songs/dtxfiles.Pack/set.def" to listOf(
                "#TITLE The Headliner",
                "#L1FILE bsc.dtx",
                "#L2FILE adv.dtx",
                "#L3FILE ext.dtx",
            ).joinToString("\n"),
            "Songs/dtxfiles.Pack/bsc.dtx" to "",
            "Songs/dtxfiles.Pack/adv.dtx" to "",
            "Songs/dtxfiles.Pack/ext.dtx" to "",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        // Box survives because explicit; set.def gave it exactly one song.
        assertEquals(1, index.root.children.size)
        val pack = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Custom Pack", pack.name)
        assertEquals("#33CC99", pack.fontColor)
        assertEquals("Hand-picked", pack.comment)
        assertTrue(pack.explicit)
        assertEquals(1, pack.children.size)
        val song = pack.children[0] as? SongNode ?: fail("expected song")
        assertEquals("The Headliner", song.entry.title)
        assertTrue(song.entry.fromSetDef)
        assertEquals(listOf(0, 1, 2), song.entry.charts.map { it.slot })
    }

    @Test fun `plain single-child wrapper containing an explicit box hoists only itself`() {
        // PlainOuter has 1 child (dtxfiles.Inner). PlainOuter is not
        // explicit, so it collapses into root; Inner is explicit with 1
        // song and must survive its own single-child hoist.
        val fs = makeFs(mapOf(
            "Songs/PlainOuter/dtxfiles.Inner/only.dtx" to "#TITLE Just One",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        assertEquals(1, index.root.children.size)
        val inner = index.root.children[0] as? BoxNode ?: fail("expected box")
        assertEquals("Inner", inner.name)
        assertTrue(inner.explicit)
        assertEquals(index.root, inner.parent)
        assertEquals(1, inner.children.size)
        val song = inner.children[0] as? SongNode ?: fail("expected song")
        // parseMeta:false → title is the filename stem, not #TITLE.
        assertEquals("only", song.entry.title)
        assertEquals(inner, song.parent)
    }

    @Test fun `malformed box def still parses, folder still shows up - resilience`() {
        // parseBoxDef is directive-by-directive and skips unknowns, so a
        // garbage box.def produces an empty meta object rather than
        // throwing. The folder still appears with the default folder-name
        // title.
        val fs = makeFs(mapOf(
            "Songs/Weird/box.def" to "this is not a box def file\n!!!\nrandom: stuff\n",
            "Songs/Weird/a.dtx" to "#TITLE A",
            "Songs/Weird/b.dtx" to "#TITLE B",
        ))
        val index = SongScanner(fs, ScanOptions(parseMeta = false)).scan("Songs")
        assertEquals(1, index.root.children.size)
        val box = index.root.children[0] as? BoxNode ?: fail("expected box")
        // Lenient parse → explicit is still set even though the file had
        // no usable directives. Title defaults to folder name.
        assertTrue(box.explicit)
        assertEquals("Weird", box.name)
        assertNull(box.fontColor)
        assertEquals(2, box.children.size)
        assertEquals(0, index.errors.size)
    }
}
