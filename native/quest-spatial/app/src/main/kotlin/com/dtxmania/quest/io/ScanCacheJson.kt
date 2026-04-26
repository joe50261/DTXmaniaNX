package com.dtxmania.quest.io

import com.dtxmania.quest.dtxcore.scanner.ChartEntry
import com.dtxmania.quest.dtxcore.scanner.ScanError
import com.dtxmania.quest.dtxcore.scanner.SerializedBox
import com.dtxmania.quest.dtxcore.scanner.SerializedIndex
import com.dtxmania.quest.dtxcore.scanner.SerializedNode
import com.dtxmania.quest.dtxcore.scanner.SerializedSong
import com.dtxmania.quest.dtxcore.scanner.SongEntry
import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON encoder / decoder for the scan-cache shape produced by
 * [com.dtxmania.quest.dtxcore.scanner.serializeIndex]. Lives at the I/O
 * boundary so the dtx-core package itself stays free of Android-only
 * dependencies (`org.json` is provided by the platform but not the JVM
 * stdlib; pure Kotlin / dtx-core unit tests would have to pull
 * Robolectric just to round-trip these data classes if encoding lived
 * inside the package).
 *
 * The on-disk format mirrors the data class hierarchy exactly:
 *
 * - top-level object has `version`, `rootPath`, `root`,
 *   `errors`, `scannedAtMs`.
 * - each node is tagged via `"kind": "box" | "song"`.
 * - nullable string / int / double fields are simply *omitted* when
 *   null rather than written as `null`. The decoder treats absent and
 *   present-but-null identically.
 *
 * `ChartEntry.record` is **deliberately not encoded** — play records
 * live in a separate persistence layer (see Phase 7 plan note) and
 * round-tripping them through the scan cache would produce stale data.
 */
object ScanCacheJson {

    fun encode(index: SerializedIndex): String =
        JSONObject().apply {
            put("version", index.version)
            put("rootPath", index.rootPath)
            put("root", encodeBox(index.root))
            put("errors", JSONArray().apply {
                for (e in index.errors) put(encodeError(e))
            })
            put("scannedAtMs", index.scannedAtMs)
        }.toString()

    fun decode(json: String): SerializedIndex {
        val obj = JSONObject(json)
        return SerializedIndex(
            version = obj.getInt("version"),
            rootPath = obj.getString("rootPath"),
            root = decodeBox(obj.getJSONObject("root")),
            errors = decodeArray(obj.getJSONArray("errors")) { decodeError(it) },
            scannedAtMs = obj.getLong("scannedAtMs"),
        )
    }

    // -- nodes -----------------------------------------------------------

    private fun encodeNode(node: SerializedNode): JSONObject = when (node) {
        is SerializedBox -> encodeBox(node)
        is SerializedSong -> encodeSong(node)
    }

    private fun decodeNode(obj: JSONObject): SerializedNode = when (obj.getString("kind")) {
        "box" -> decodeBox(obj)
        "song" -> decodeSong(obj)
        else -> throw IllegalArgumentException("unknown kind: ${obj.optString("kind")}")
    }

    // -- box -------------------------------------------------------------

    private fun encodeBox(box: SerializedBox): JSONObject =
        JSONObject().apply {
            put("kind", "box")
            put("name", box.name)
            put("path", box.path)
            put("children", JSONArray().apply {
                for (c in box.children) put(encodeNode(c))
            })
            putOpt(this, "fontColor", box.fontColor)
            putOpt(this, "comment", box.comment)
            putOpt(this, "preimage", box.preimage)
            put("explicit", box.explicit)
        }

    private fun decodeBox(obj: JSONObject): SerializedBox =
        SerializedBox(
            name = obj.getString("name"),
            path = obj.getString("path"),
            children = decodeArray(obj.getJSONArray("children")) { decodeNode(it) },
            fontColor = optStr(obj, "fontColor"),
            comment = optStr(obj, "comment"),
            preimage = optStr(obj, "preimage"),
            explicit = obj.optBoolean("explicit", false),
        )

    // -- song ------------------------------------------------------------

    private fun encodeSong(song: SerializedSong): JSONObject =
        JSONObject().apply {
            put("kind", "song")
            put("entry", encodeSongEntry(song.entry))
        }

    private fun decodeSong(obj: JSONObject): SerializedSong =
        SerializedSong(entry = decodeSongEntry(obj.getJSONObject("entry")))

    private fun encodeSongEntry(e: SongEntry): JSONObject =
        JSONObject().apply {
            put("title", e.title)
            put("folderPath", e.folderPath)
            put("fromSetDef", e.fromSetDef)
            putOpt(this, "fontColor", e.fontColor)
            put("charts", JSONArray().apply {
                for (c in e.charts) put(encodeChart(c))
            })
            putOpt(this, "artist", e.artist)
            putOpt(this, "genre", e.genre)
            putOptDouble(this, "bpm", e.bpm)
            putOpt(this, "preview", e.preview)
            putOpt(this, "preimage", e.preimage)
            putOpt(this, "comment", e.comment)
        }

    private fun decodeSongEntry(obj: JSONObject): SongEntry {
        val charts = decodeArray(obj.getJSONArray("charts")) { decodeChart(it) }
        return SongEntry(
            title = obj.getString("title"),
            folderPath = obj.getString("folderPath"),
            fromSetDef = obj.getBoolean("fromSetDef"),
            fontColor = optStr(obj, "fontColor"),
            charts = charts.toMutableList(),
            artist = optStr(obj, "artist"),
            genre = optStr(obj, "genre"),
            bpm = optDouble(obj, "bpm"),
            preview = optStr(obj, "preview"),
            preimage = optStr(obj, "preimage"),
            comment = optStr(obj, "comment"),
        )
    }

    // -- chart -----------------------------------------------------------

    private fun encodeChart(c: ChartEntry): JSONObject =
        JSONObject().apply {
            put("slot", c.slot)
            put("label", c.label)
            put("chartPath", c.chartPath)
            putOptInt(this, "drumLevel", c.drumLevel)
            putOptDouble(this, "bpm", c.bpm)
            // ChartEntry.record is intentionally not persisted.
        }

    private fun decodeChart(obj: JSONObject): ChartEntry =
        ChartEntry(
            slot = obj.getInt("slot"),
            label = obj.getString("label"),
            chartPath = obj.getString("chartPath"),
            drumLevel = optInt(obj, "drumLevel"),
            bpm = optDouble(obj, "bpm"),
        )

    // -- error -----------------------------------------------------------

    private fun encodeError(e: ScanError): JSONObject =
        JSONObject().apply {
            put("path", e.path)
            put("message", e.message)
        }

    private fun decodeError(obj: JSONObject): ScanError =
        ScanError(path = obj.getString("path"), message = obj.getString("message"))

    // -- helpers ---------------------------------------------------------

    private fun putOpt(obj: JSONObject, key: String, value: String?) {
        if (value != null) obj.put(key, value)
    }

    private fun putOptInt(obj: JSONObject, key: String, value: Int?) {
        if (value != null) obj.put(key, value)
    }

    private fun putOptDouble(obj: JSONObject, key: String, value: Double?) {
        if (value != null) obj.put(key, value)
    }

    private fun optStr(obj: JSONObject, key: String): String? =
        if (obj.has(key) && !obj.isNull(key)) obj.getString(key) else null

    private fun optInt(obj: JSONObject, key: String): Int? =
        if (obj.has(key) && !obj.isNull(key)) obj.getInt(key) else null

    private fun optDouble(obj: JSONObject, key: String): Double? =
        if (obj.has(key) && !obj.isNull(key)) obj.getDouble(key) else null

    private inline fun <T> decodeArray(arr: JSONArray, decode: (JSONObject) -> T): List<T> {
        val out = ArrayList<T>(arr.length())
        for (i in 0 until arr.length()) out.add(decode(arr.getJSONObject(i)))
        return out
    }
}
