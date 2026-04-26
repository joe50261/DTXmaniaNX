package com.dtxmania.quest.io

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.dtxmania.quest.dtxcore.scanner.DirEntry
import com.dtxmania.quest.dtxcore.scanner.FileSystemBackend
import com.dtxmania.quest.dtxcore.scanner.decodeTextWithBom

/**
 * [FileSystemBackend] implementation over the Storage Access Framework.
 *
 * Logical paths are POSIX-style and rooted at [rootDisplayPath] (e.g.
 * `"Songs"`). Internally the backend resolves each path segment by
 * walking [DocumentFile.findFile] from [rootDoc]. `findFile` is O(n)
 * per call (it lists all children then linear-scans), so we memoise
 * the per-directory child list keyed by the directory's URI string. A
 * single scan run thus pays the listing cost once per directory.
 *
 * Listing during scan walks via [listDir] and chart reads via
 * [readText] / [readFile] all use [ContentResolver.openInputStream]
 * under the hood — there are no real "paths" on disk, just opaque URIs.
 *
 * No JVM unit-test coverage in Phase 2: simulating SAF in
 * Robolectric requires a fake `DocumentsContract` provider, which is
 * substantial work for limited gain over on-device verification. The
 * compile boundary (this class actually implements [FileSystemBackend]
 * end-to-end) is checked by `:app:assembleDebug`. Real behaviour gets
 * verified on a Quest 3 in Phase 9.
 */
class SafSource(
    private val resolver: ContentResolver,
    private val rootDoc: DocumentFile,
    private val rootDisplayPath: String,
) : FileSystemBackend {

    private val childrenCache = HashMap<String, List<DocumentFile>>()

    /**
     * Resolve a logical POSIX path to a [DocumentFile], or null if the
     * path doesn't exist under [rootDoc].
     */
    private fun resolveDoc(path: String): DocumentFile? {
        val normalized = path.trim('/')
        if (normalized == rootDisplayPath || normalized == "") return rootDoc
        val rel = normalized.removePrefix("$rootDisplayPath/")
        if (rel == normalized && rel.isNotEmpty()) {
            // Path didn't start with the expected root; be lenient and
            // treat the whole thing as relative to rootDoc. The scanner
            // only ever uses paths it built itself from listDir output,
            // but defensive resolution costs nothing.
        }
        var current: DocumentFile? = rootDoc
        for (segment in rel.split('/')) {
            if (segment.isEmpty()) continue
            current = current?.let { findChild(it, segment) } ?: return null
        }
        return current
    }

    private fun findChild(parent: DocumentFile, name: String): DocumentFile? {
        val key = parent.uri.toString()
        val children = childrenCache.getOrPut(key) { parent.listFiles().toList() }
        return children.firstOrNull { it.name == name }
    }

    override fun listDir(path: String): List<DirEntry> {
        val doc = resolveDoc(path)
            ?: throw IllegalStateException("path not found: $path")
        if (!doc.isDirectory) {
            throw IllegalStateException("not a directory: $path")
        }
        val key = doc.uri.toString()
        val children = childrenCache.getOrPut(key) { doc.listFiles().toList() }
        return children.mapNotNull { child ->
            val name = child.name ?: return@mapNotNull null
            val childPath = if (path.isEmpty()) name else "$path/$name"
            DirEntry(
                name = name,
                path = childPath,
                isDirectory = child.isDirectory,
                isFile = child.isFile,
            )
        }
    }

    override fun readFile(path: String): ByteArray {
        val doc = resolveDoc(path)
            ?: throw IllegalStateException("path not found: $path")
        if (!doc.isFile) throw IllegalStateException("not a file: $path")
        return resolver.openInputStream(doc.uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("could not open input stream: $path")
    }

    override fun readText(path: String, encoding: String): String =
        decodeTextWithBom(readFile(path), encoding)

    override fun exists(path: String): Boolean = resolveDoc(path) != null

    companion object {
        /**
         * Convenience factory. Builds a [SafSource] from a tree URI by
         * resolving it via [DocumentFile.fromTreeUri].
         *
         * @param rootDisplayPath logical name to use as the root path
         *  the scanner sees. The scanner uses this string verbatim as
         *  `box.path` for the top-level box; downstream UI shows it
         *  unchanged in breadcrumbs, so prefer something user-friendly
         *  ("Songs" rather than the raw tree URI).
         */
        fun fromTreeUri(
            context: Context,
            treeUri: Uri,
            rootDisplayPath: String = "Songs",
        ): SafSource? {
            val root = DocumentFile.fromTreeUri(context, treeUri) ?: return null
            return SafSource(
                resolver = context.contentResolver,
                rootDoc = root,
                rootDisplayPath = rootDisplayPath,
            )
        }
    }
}
