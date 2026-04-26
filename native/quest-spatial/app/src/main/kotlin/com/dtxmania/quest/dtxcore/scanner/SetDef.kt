package com.dtxmania.quest.dtxcore.scanner

/**
 * `set.def` parser. Ported from
 * `web/packages/dtx-core/src/scanner/setdef.ts`, which is itself a port
 * of `DTXMania/Code/Score,Song/CSetDef.cs`.
 *
 * A set.def groups up to 5 difficulty charts for one song. One file may
 * contain multiple blocks (each starting with a fresh `#TITLE`).
 *
 * Example:
 *
 *     #TITLE My Song
 *     #L1LABEL NOVICE
 *     #L1FILE  nov.dtx
 *     #L2LABEL REGULAR
 *     #L2FILE  reg.dtx
 */

val SET_DEF_DEFAULT_LABELS: List<String> =
    listOf("NOVICE", "REGULAR", "EXPERT", "MASTER", "DTXMania")

data class SetDefBlock(
    var title: String = "",
    /** Hex color like "#RRGGBB" (set.def's FONTCOLOR). Null if not specified. */
    var fontColor: String? = null,
    /** 5 slots; null means "no chart at this difficulty". */
    val files: MutableList<String?> = mutableListOf(null, null, null, null, null),
    val labels: MutableList<String?> = mutableListOf(null, null, null, null, null),
)

private val FILE_LINE = Regex("""^#L([1-5])FILE""", RegexOption.IGNORE_CASE)
private val LABEL_LINE = Regex("""^#L([1-5])LABEL""", RegexOption.IGNORE_CASE)
private val LEADING_WS = Regex("""^\s+""")
private val LEADING_COLON_OR_WS = Regex("""^[\s:]+""")

fun parseSetDef(text: String): List<SetDefBlock> {
    val blocks = mutableListOf<SetDefBlock>()
    var current = SetDefBlock()
    var currentInUse = false

    fun flush() {
        if (!currentInUse) return
        applyDefaultLabels(current)
        dropLabelsWithoutFiles(current)
        blocks.add(current)
        current = SetDefBlock()
        currentInUse = false
    }

    for (rawLine in text.split(Regex("""\r?\n"""))) {
        val stripped = stripCommentsAndBom(rawLine)
        val line = stripped.replace(LEADING_WS, "")
        if (line.isEmpty() || !line.startsWith("#")) continue

        val upper = line.uppercase()

        if (upper.startsWith("#TITLE")) {
            if (currentInUse) flush()
            current.title = extractValue(line, 6)
            currentInUse = true
            continue
        }
        if (upper.startsWith("#FONTCOLOR")) {
            val raw = extractValue(line, 10).trimStart('#')
            if (raw.isNotEmpty()) current.fontColor = "#$raw"
            currentInUse = true
            continue
        }

        val fileMatch = FILE_LINE.find(line)
        if (fileMatch != null) {
            val idx = fileMatch.groupValues[1].toInt() - 1
            current.files[idx] = extractValue(line, fileMatch.value.length)
            currentInUse = true
            continue
        }

        val labelMatch = LABEL_LINE.find(line)
        if (labelMatch != null) {
            val idx = labelMatch.groupValues[1].toInt() - 1
            current.labels[idx] = extractValue(line, labelMatch.value.length)
            currentInUse = true
        }
    }

    flush()
    return blocks
}

private fun stripCommentsAndBom(s: String): String {
    var out = if (s.isNotEmpty() && s[0].code == 0xfeff) s.substring(1) else s
    val ci = out.indexOf(';')
    if (ci >= 0) out = out.substring(0, ci)
    return out.trimEnd()
}

/** Strips the `:`, whitespace and optional colon that sit after the command keyword. */
private fun extractValue(line: String, keywordLength: Int): String =
    line.substring(keywordLength).replace(LEADING_COLON_OR_WS, "").trim()

private fun applyDefaultLabels(block: SetDefBlock) {
    for (i in 0 until 5) {
        val file = block.files[i]
        val label = block.labels[i]
        if (!file.isNullOrEmpty() && label.isNullOrEmpty()) {
            block.labels[i] = SET_DEF_DEFAULT_LABELS[i]
        }
    }
}

private fun dropLabelsWithoutFiles(block: SetDefBlock) {
    for (i in 0 until 5) {
        val file = block.files[i]
        val label = block.labels[i]
        if (!label.isNullOrEmpty() && file.isNullOrEmpty()) {
            block.labels[i] = null
        }
    }
}
