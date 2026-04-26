package com.dtxmania.quest.dtxcore.scanner

import com.dtxmania.quest.dtxcore.parser.parseDtx
import com.dtxmania.quest.dtxcore.scoring.ChartRecord

/**
 * Song library scanner. Walks a directory tree (v1: only `.dtx` +
 * `set.def`; `.gda` / `.bms` / `.bme` / `.g2d` are deliberately out of
 * scope) and produces a flat list of song entries, each with up to 5
 * difficulty charts.
 *
 * Ported from `web/packages/dtx-core/src/scanner/scanner.ts`. The TS
 * source returns `Promise<T>` for every FS call; the Kotlin port uses
 * blocking returns and expects callers to invoke [SongScanner.scan]
 * from `Dispatchers.IO` (Phase 2 SAF integration will do that).
 */

data class ChartEntry(
    /** One of 5 difficulty slots: 0=NOVICE, 1=REGULAR, 2=EXPERT, 3=MASTER, 4=DTXMania. */
    val slot: Int,
    val label: String,
    /** Path (relative to the backend root) of the .dtx file. */
    val chartPath: String,
    /** `#DLEVEL` from the .dtx header (0..1000). Null if meta parsing was skipped/failed. */
    var drumLevel: Int? = null,
    /** `#BPM` from the .dtx header. Populated alongside [drumLevel]. */
    var bpm: Double? = null,
    /** Best-of play record. Runtime-attached by the app layer after
     *  scan / cache hydration; **not** serialised into the scan cache
     *  (records live in a separate persistence keyed by [chartPath]).
     *  Excluded from `serializeIndex` by [SerializedSong] only carrying
     *  [SongEntry], not [ChartEntry.record]'s value. */
    var record: ChartRecord? = null,
)

data class SongEntry(
    /** Title from set.def or, if no set.def, the .dtx filename stem. */
    val title: String,
    /** Directory containing the chart(s). */
    val folderPath: String,
    /** True if this entry came from a set.def (vs. a single .dtx file). */
    val fromSetDef: Boolean,
    var fontColor: String? = null,
    var charts: MutableList<ChartEntry> = mutableListOf(),
    var artist: String? = null,
    var genre: String? = null,
    var bpm: Double? = null,
    /** `#PREVIEW` WAV path relative to [folderPath]. */
    var preview: String? = null,
    /** `#PREIMAGE` cover-art path relative to [folderPath]. */
    var preimage: String? = null,
    /** `#COMMENT` free-form text. */
    var comment: String? = null,
)

/**
 * DTXmania-style song-select tree node. The top-level [BoxNode] is a
 * virtual box wrapping the scanned root path; every directory containing
 * songs (or holding nested song directories) becomes a [BoxNode]. Back /
 * Random navigation entries are synthetic and added by the UI layer at
 * render time rather than baked into the tree here.
 */
sealed class LibraryNode

class BoxNode(
    /** Display name (`box.def #TITLE` if present, else the `dtxfiles.`
     *  suffix if present, else the raw folder-name segment; "/" for root). */
    var name: String,
    /** Path (relative to the backend root). Stable across re-scans. */
    val path: String,
    var parent: BoxNode? = null,
    val children: MutableList<LibraryNode> = mutableListOf(),
    var fontColor: String? = null,
    var comment: String? = null,
    var preimage: String? = null,
    /** True if this box was explicitly declared via a `dtxfiles.` folder
     *  prefix or a `box.def` file. Shields the box from the single-child
     *  hoist rule. */
    var explicit: Boolean = false,
) : LibraryNode()

class SongNode(
    val entry: SongEntry,
    var parent: BoxNode? = null,
) : LibraryNode()

data class ScanError(val path: String, val message: String)

data class SongIndex(
    val rootPath: String,
    /** Tree root. All boxes / songs reachable from here. */
    val root: BoxNode,
    /** Flat list of every [SongEntry], pre-order DFS of [root]. */
    val songs: List<SongEntry>,
    val errors: List<ScanError>,
)

data class ScanOptions(
    /** Subdirectory names to skip (case-insensitive). Default skips common noise. */
    val skipDirs: List<String>? = null,
    /** Max recursion depth (root = 0). */
    val maxDepth: Int = 12,
    /** When true (default), read each .dtx header after detection and
     *  fill in `chart.drumLevel` / `chart.bpm` and `song.artist` /
     *  `song.genre`. */
    val parseMeta: Boolean = true,
    /** Called during the meta-parse phase once per song with
     *  `(songsDone, songsTotal)`. */
    val onMetaProgress: ((done: Int, total: Int) -> Unit)? = null,
    /** Called during the directory-walk phase once per `listDir` call
     *  with `(dirsScanned, songsFoundSoFar)`. */
    val onWalkProgress: ((dirsScanned: Int, songsFound: Int) -> Unit)? = null,
)

private val DEFAULT_SKIP_DIRS = setOf("system", "${'$'}recycle.bin", "node_modules", ".git")

class SongScanner(
    private val fs: FileSystemBackend,
    options: ScanOptions = ScanOptions(),
) {
    private val skipDirs: Set<String> =
        (options.skipDirs ?: DEFAULT_SKIP_DIRS.toList())
            .map { it.lowercase() }
            .toSet()
    private val maxDepth: Int = options.maxDepth
    private val parseMeta: Boolean = options.parseMeta
    private val onMetaProgress: ((Int, Int) -> Unit)? = options.onMetaProgress
    private val onWalkProgress: ((Int, Int) -> Unit)? = options.onWalkProgress

    private var dirsScanned = 0
    private var songsFound = 0

    fun scan(rootPath: String): SongIndex {
        val errors = mutableListOf<ScanError>()
        val root = BoxNode(name = "/", path = rootPath, parent = null)
        // Reset walk counters so re-using one SongScanner for a second
        // scan doesn't accumulate numbers across calls.
        dirsScanned = 0
        songsFound = 0
        onWalkProgress?.invoke(0, 0)
        walk(root, 0, errors)
        val songs = flattenSongs(root)
        if (parseMeta) {
            val total = songs.size
            onMetaProgress?.invoke(0, total)
            for (i in songs.indices) {
                fillSongMeta(songs[i], errors)
                onMetaProgress?.invoke(i + 1, total)
            }
        }
        return SongIndex(rootPath = rootPath, root = root, songs = songs, errors = errors)
    }

    private fun fillSongMeta(song: SongEntry, errors: MutableList<ScanError>) {
        for (chart in song.charts) {
            try {
                val text = fs.readText(chart.chartPath)
                val parsed = parseDtx(text)
                chart.drumLevel = parsed.drumLevel
                chart.bpm = parsed.baseBpm
                if (song.artist == null && parsed.artist.isNotEmpty()) song.artist = parsed.artist
                if (song.genre == null && parsed.genre.isNotEmpty()) song.genre = parsed.genre
                if (song.bpm == null) song.bpm = parsed.baseBpm
                // Preview/preimage/comment are per-song; first chart wins.
                if (song.preview == null && parsed.preview.isNotEmpty()) song.preview = parsed.preview
                if (song.preimage == null && parsed.preimage.isNotEmpty()) song.preimage = parsed.preimage
                if (song.comment == null && parsed.comment.isNotEmpty()) song.comment = parsed.comment
            } catch (e: Exception) {
                errors.add(ScanError(path = chart.chartPath, message = errorMessage(e)))
            }
        }
    }

    private fun walk(box: BoxNode, depth: Int, errors: MutableList<ScanError>) {
        if (depth > maxDepth) return

        val entries: List<DirEntry> = try {
            fs.listDir(box.path)
        } catch (e: Exception) {
            errors.add(ScanError(path = box.path, message = errorMessage(e)))
            return
        }
        dirsScanned++
        onWalkProgress?.invoke(dirsScanned, songsFound)

        val setDefEntry = entries.firstOrNull { it.isFile && it.name.lowercase() == "set.def" }

        fun pushSong(entry: SongEntry) {
            box.children.add(SongNode(entry = entry, parent = box))
            songsFound++
        }

        if (setDefEntry != null) {
            var pushedFromSetDef = 0
            try {
                val text = fs.readText(setDefEntry.path, "Shift_JIS")
                val blocks = parseSetDef(text)
                for (block in blocks) {
                    val song = blockToSong(block, box.path)
                    // Only add if at least one referenced chart exists on disk.
                    val survivingCharts = song.charts.filter { fs.exists(it.chartPath) }
                    if (survivingCharts.isNotEmpty()) {
                        song.charts = survivingCharts.toMutableList()
                        pushSong(song)
                        pushedFromSetDef++
                    }
                }
            } catch (e: Exception) {
                errors.add(ScanError(path = setDefEntry.path, message = errorMessage(e)))
            }

            // If the set.def yielded nothing usable, fall through to a
            // plain .dtx scan so the folder still shows up.
            if (pushedFromSetDef == 0) {
                for (entry in entries) {
                    if (!entry.isFile) continue
                    if (extname(entry.name) != ".dtx") continue
                    pushSong(singleDtxToSong(entry, box.path))
                }
            }
        } else {
            // No set.def: collect .dtx files as individual songs.
            for (entry in entries) {
                if (!entry.isFile) continue
                if (extname(entry.name) != ".dtx") continue
                pushSong(singleDtxToSong(entry, box.path))
            }
        }

        // Recurse into subdirectories. Each becomes a candidate BoxNode
        // and is pruned three ways:
        //   - 0 descendants → drop (empty dir)
        //   - exactly 1 descendant → "hoist" into our own children,
        //     eliminating the pointless single-entry wrapper.
        //   - ≥2 descendants → keep the box.
        for (entry in entries) {
            if (!entry.isDirectory) continue
            if (entry.name.lowercase() in skipDirs) continue

            val subBox = BoxNode(name = entry.name, path = entry.path, parent = box)

            // Resolve the DTXmania "is this folder an explicit box?" rules
            // before descending.
            applyExplicitBoxMarkers(subBox, errors)

            walk(subBox, depth + 1, errors)
            if (subBox.children.isEmpty()) continue
            if (subBox.children.size == 1 && !subBox.explicit) {
                // Implicit single-child folders collapse into the parent.
                val only = subBox.children[0]
                when (only) {
                    is SongNode -> only.parent = box
                    is BoxNode -> only.parent = box
                }
                box.children.add(only)
            } else {
                box.children.add(subBox)
            }
        }
    }

    /**
     * Probe a candidate sub-box for DTXmania's explicit-box markers and
     * apply the resulting metadata in-place. No-op if neither marker is
     * present; the box still gets walked but is subject to the
     * single-child hoist.
     */
    private fun applyExplicitBoxMarkers(subBox: BoxNode, errors: MutableList<ScanError>) {
        // 1. Check for box.def inside the directory.
        var boxDefMeta: BoxDefMeta? = null
        try {
            val inside = fs.listDir(subBox.path)
            val boxDefEntry = inside.firstOrNull { it.isFile && it.name.lowercase() == "box.def" }
            if (boxDefEntry != null) {
                try {
                    val text = fs.readText(boxDefEntry.path, "Shift_JIS")
                    boxDefMeta = parseBoxDef(text)
                    subBox.explicit = true
                } catch (e: Exception) {
                    errors.add(ScanError(path = boxDefEntry.path, message = errorMessage(e)))
                }
            }
        } catch (_: Exception) {
            // listDir failure will be rediscovered by walk() and reported there.
        }

        // 2. `dtxfiles.` prefix — case-insensitive, independent of box.def.
        val prefix = "dtxfiles."
        val lower = subBox.name.lowercase()
        val hasDtxfilesPrefix = lower.startsWith(prefix)
        if (hasDtxfilesPrefix) {
            subBox.explicit = true
            // Default title: strip the prefix. box.def #TITLE wins below if set.
            val stripped = subBox.name.substring(prefix.length)
            subBox.name = stripped.ifEmpty { subBox.name }
        }

        // Apply box.def metadata last so authored values override defaults.
        if (boxDefMeta != null) {
            boxDefMeta.title?.let { subBox.name = it }
            boxDefMeta.fontColor?.let { subBox.fontColor = it }
            boxDefMeta.comment?.let { subBox.comment = it }
            boxDefMeta.preimage?.let { subBox.preimage = it }
        }
    }
}

/**
 * Pre-order DFS collecting every [SongEntry] under the given root.
 * Preserves filesystem-walk order.
 */
fun flattenSongs(root: BoxNode): List<SongEntry> {
    val out = mutableListOf<SongEntry>()
    val stack = ArrayDeque<LibraryNode>()
    stack.addLast(root)
    while (stack.isNotEmpty()) {
        val node = stack.removeLast()
        when (node) {
            is SongNode -> out.add(node.entry)
            is BoxNode -> {
                // Iterate children in reverse so pre-order LTR matches walk.
                for (i in node.children.indices.reversed()) {
                    stack.addLast(node.children[i])
                }
            }
        }
    }
    return out
}

private fun blockToSong(block: SetDefBlock, folderPath: String): SongEntry {
    val charts = mutableListOf<ChartEntry>()
    for (slot in 0 until 5) {
        val file = block.files[slot]
        val label = block.labels[slot]
        if (file.isNullOrEmpty() || label.isNullOrEmpty()) continue
        charts.add(ChartEntry(slot = slot, label = label, chartPath = joinPath(folderPath, file)))
    }
    return SongEntry(
        title = block.title,
        folderPath = folderPath,
        fromSetDef = true,
        fontColor = block.fontColor,
        charts = charts,
    )
}

private fun singleDtxToSong(entry: DirEntry, folderPath: String): SongEntry {
    val stem = entry.name.replace(Regex("""\.dtx$""", RegexOption.IGNORE_CASE), "")
    return SongEntry(
        title = stem,
        folderPath = folderPath,
        fromSetDef = false,
        charts = mutableListOf(
            ChartEntry(slot = 0, label = "DTX", chartPath = entry.path),
        ),
    )
}

private fun errorMessage(e: Throwable): String = e.message ?: e.toString()

// ---------------------------------------------------------------------
// Scan-cache serialisation
// ---------------------------------------------------------------------

/**
 * Persisted scan-cache schema version. Bumped whenever [SongEntry],
 * [ChartEntry], or [BoxNode] shape changes in a way that would make an
 * old cache produce wrong-looking rows. Consumers should throw away
 * caches whose version != [INDEX_CACHE_VERSION] instead of migrating.
 */
const val INDEX_CACHE_VERSION = 2

/** JSON-friendly mirror of the [BoxNode] / [SongNode] tree. Strips
 *  parent refs (they're reconstructed on load) so the shape is plain
 *  data without cycles.
 *
 *  The Kotlin port keeps this as a hierarchy of data classes. Encoding
 *  to JSON / IDB / SharedPreferences is the responsibility of the
 *  Phase 2 SAF integration layer. */
data class SerializedIndex(
    val version: Int,
    val rootPath: String,
    val root: SerializedBox,
    val errors: List<ScanError>,
    /** Wall-clock epoch ms when the scan completed. */
    val scannedAtMs: Long,
)

sealed class SerializedNode

data class SerializedBox(
    val name: String,
    val path: String,
    val children: List<SerializedNode>,
    val fontColor: String? = null,
    val comment: String? = null,
    val preimage: String? = null,
    val explicit: Boolean = false,
) : SerializedNode()

data class SerializedSong(val entry: SongEntry) : SerializedNode()

fun serializeIndex(index: SongIndex, nowMs: Long = System.currentTimeMillis()): SerializedIndex =
    SerializedIndex(
        version = INDEX_CACHE_VERSION,
        rootPath = index.rootPath,
        root = serializeBox(index.root),
        errors = index.errors,
        scannedAtMs = nowMs,
    )

private fun serializeBox(box: BoxNode): SerializedBox {
    val children = box.children.map { child ->
        when (child) {
            is SongNode -> SerializedSong(entry = child.entry)
            is BoxNode -> serializeBox(child)
        }
    }
    return SerializedBox(
        name = box.name,
        path = box.path,
        children = children,
        fontColor = box.fontColor,
        comment = box.comment,
        preimage = box.preimage,
        explicit = box.explicit,
    )
}

/**
 * Rebuild a live [SongIndex] (with parent refs) from a persisted
 * [SerializedIndex]. Throws if the version doesn't match the current
 * code's [INDEX_CACHE_VERSION] — caller should clear the cache and do
 * a fresh scan in that case.
 */
fun deserializeIndex(s: SerializedIndex): SongIndex {
    if (s.version != INDEX_CACHE_VERSION) {
        throw IllegalArgumentException(
            "scan cache version ${s.version} does not match current $INDEX_CACHE_VERSION"
        )
    }
    val root = deserializeBox(s.root, parent = null)
    return SongIndex(
        rootPath = s.rootPath,
        root = root,
        songs = flattenSongs(root),
        errors = s.errors,
    )
}

private fun deserializeBox(s: SerializedBox, parent: BoxNode?): BoxNode {
    val box = BoxNode(
        name = s.name,
        path = s.path,
        parent = parent,
        fontColor = s.fontColor,
        comment = s.comment,
        preimage = s.preimage,
        explicit = s.explicit,
    )
    for (child in s.children) {
        when (child) {
            is SerializedSong -> box.children.add(SongNode(entry = child.entry, parent = box))
            is SerializedBox -> box.children.add(deserializeBox(child, parent = box))
        }
    }
    return box
}
