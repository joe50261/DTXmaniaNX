package com.dtxmania.quest.dtxcore.scanner

/**
 * Minimal parser for DTXmania's `box.def` file. Lives at the root of a
 * folder that the author wants surfaced as a browsable box in the
 * song-select wheel. Matches the small subset of directives our
 * song-select UI can actually render:
 *
 *   - `#TITLE`     display name (overrides the folder name)
 *   - `#ARTIST`    box-level artist credit
 *   - `#GENRE`     box-level genre tag
 *   - `#COMMENT`   tooltip / comment
 *   - `#FONTCOLOR` hex colour (e.g. `#FFAA00`) used to tint the row
 *   - `#PREIMAGE`  cover art path, relative to the box folder
 *
 * Reference: DTXMania `Code/Score,Song/CBoxDef.cs`. Unknown directives,
 * blank lines, and `;`-prefixed comments are silently skipped.
 *
 * Input is expected to be already-decoded text (the scanner reads it
 * via `backend.readText(path, "Shift_JIS")`).
 *
 * Ported from `web/packages/dtx-core/src/scanner/boxdef.ts`.
 */

data class BoxDefMeta(
    var title: String? = null,
    var artist: String? = null,
    var genre: String? = null,
    var comment: String? = null,
    /** Hex colour string as authored — no normalisation. Caller should
     *  treat empty / obviously-invalid values as missing. */
    var fontColor: String? = null,
    /** Path to the cover image, relative to the box's own folder. */
    var preimage: String? = null,
)

private val COMMAND = Regex("""^#\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:=\s]\s*(.*?)\s*$""")

fun parseBoxDef(text: String): BoxDefMeta {
    val out = BoxDefMeta()
    for (raw in text.split(Regex("""\r?\n"""))) {
        val line = stripBom(raw).trim()
        if (line.isEmpty()) continue
        if (line.startsWith(';')) continue
        if (!line.startsWith('#')) continue
        val m = COMMAND.matchEntire(line) ?: continue
        val key = m.groupValues[1].uppercase()
        val value = m.groupValues[2].trim()
        if (value.isEmpty()) continue
        when (key) {
            "TITLE" -> out.title = value
            "ARTIST" -> out.artist = value
            "GENRE" -> out.genre = value
            "COMMENT" -> out.comment = value
            "FONTCOLOR", "COLOR" -> out.fontColor = value
            "PREIMAGE" -> out.preimage = value
            // intentionally ignore everything else (SKINPATH, hit ranges,
            // PREMOVIE, etc.) — not consumed by our UI.
        }
    }
    return out
}

private fun stripBom(s: String): String =
    if (s.isNotEmpty() && s[0].code == 0xfeff) s.substring(1) else s
