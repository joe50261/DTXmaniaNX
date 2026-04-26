package com.dtxmania.quest.dtxcore.scanner

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Abstract filesystem backend. Different environments provide different
 * implementations:
 *
 *   - Local file: a [java.io.File]-based wrapper (used for the bundled
 *     demo chart in the app's assets).
 *   - SAF: a `DocumentFile` / `ContentResolver` wrapper (Phase 2). It
 *     simulates POSIX paths over the SAF tree by walking children.
 *   - Test: an in-memory backend (see `tests/MemoryFs.kt`).
 *
 * All paths are POSIX-style ("/") regardless of host OS; backends
 * translate.
 *
 * The TS source returns `Promise<T>` because of the underlying browser
 * FS Access API. Kotlin uses blocking returns instead — callers are
 * expected to invoke the scanner from `Dispatchers.IO` (Phase 2 Sca will
 * do this). Keeping the interface non-suspending avoids propagating
 * `suspend` through every helper inside [SongScanner].
 *
 * Ported from `web/packages/dtx-core/src/scanner/fs-backend.ts`.
 */

data class DirEntry(
    val name: String,
    /** Full path from the root the backend was opened against. */
    val path: String,
    val isDirectory: Boolean,
    val isFile: Boolean,
)

interface FileSystemBackend {
    /** List immediate children of `path`. Throws if `path` is not a directory. */
    fun listDir(path: String): List<DirEntry>

    /** Read a file as raw bytes. */
    fun readFile(path: String): ByteArray

    /**
     * Read a file as text, decoding with `encoding` (default `Shift_JIS`,
     * the DTX convention). Implementations should tolerate `UTF-8`.
     */
    fun readText(path: String, encoding: String = "Shift_JIS"): String

    /** True if the path exists (as file or directory). */
    fun exists(path: String): Boolean
}

/** Joins POSIX path segments, collapsing duplicate slashes. */
fun joinPath(vararg segments: String): String {
    val joined = segments.filter { it.isNotEmpty() }.joinToString("/")
    return joined.replace(Regex("""/+"""), "/")
}

/** Returns the parent directory path (POSIX). Returns "" for top-level. */
fun dirname(path: String): String {
    val idx = path.lastIndexOf('/')
    return if (idx <= 0) "" else path.substring(0, idx)
}

/** Returns the basename (last segment) of a POSIX path. */
fun basename(path: String): String {
    val idx = path.lastIndexOf('/')
    return if (idx < 0) path else path.substring(idx + 1)
}

/** Returns the lowercase file extension including the dot, or "". */
fun extname(path: String): String {
    val base = basename(path)
    val idx = base.lastIndexOf('.')
    return if (idx <= 0) "" else base.substring(idx).lowercase()
}

/**
 * Decode a file's raw bytes to text, honouring any Unicode byte-order
 * mark.
 *
 * Real-world DTX + set.def files come in three flavours:
 *
 *   - UTF-16 LE with BOM (DTXCreator default on Windows; very common)
 *   - UTF-8 with BOM (newer charts saved from Notepad / VSCode)
 *   - Shift_JIS with no BOM (legacy, still the most common for `.dtx`
 *     bodies)
 *
 * If no BOM is present we try the caller's expected encoding (usually
 * `Shift_JIS`) with strict (REPORT) error handling; if that throws on
 * malformed bytes we fall back to UTF-8 with replacement so at least
 * something comes out. Callers that know the encoding can still pass
 * it explicitly.
 */
fun decodeTextWithBom(bytes: ByteArray, fallbackEncoding: String = "Shift_JIS"): String {
    if (bytes.size >= 3 &&
        bytes[0] == 0xEF.toByte() &&
        bytes[1] == 0xBB.toByte() &&
        bytes[2] == 0xBF.toByte()
    ) {
        return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
    }
    if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
    }
    if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
        return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
    }
    return try {
        val charset = Charset.forName(fallbackEncoding)
        val decoder = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        decoder.decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        String(bytes, Charsets.UTF_8)
    }
}
