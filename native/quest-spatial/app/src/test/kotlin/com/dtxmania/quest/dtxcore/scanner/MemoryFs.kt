package com.dtxmania.quest.dtxcore.scanner

/**
 * Test-only in-memory [FileSystemBackend]. Paths are POSIX; directories
 * are implicit (any path that is a prefix of a file path acts as a
 * directory).
 *
 * Ported from `web/packages/dtx-core/tests/helpers/memory-fs.ts`. Tests
 * may also override [listDir] / [readText] / [exists] dynamically by
 * reassigning the matching `var`s — used by the "reports errors instead
 * of throwing" case to inject a synthetic failure.
 */
class MemoryFs : FileSystemBackend {

    private sealed class Entry {
        class File(val bytes: ByteArray) : Entry()
        object Dir : Entry()
    }

    private val entries = LinkedHashMap<String, Entry>()

    /** Add or overwrite a file. */
    fun setFile(path: String, content: String) {
        setFile(path, content.toByteArray(Charsets.UTF_8))
    }

    fun setFile(path: String, content: ByteArray) {
        val norm = normalize(path)
        entries[norm] = Entry.File(content)
        // Register parent chain as directories for exists()/listDir().
        var parent = parentOf(norm)
        while (parent.isNotEmpty() && !entries.containsKey(parent)) {
            entries[parent] = Entry.Dir
            parent = parentOf(parent)
        }
    }

    /** Hook for test cases that need to inject a failing listDir on a
     *  specific path. Override callbacks may delegate back to the real
     *  implementation via [listDirImpl]. */
    var listDirOverride: ((String) -> List<DirEntry>)? = null

    override fun listDir(path: String): List<DirEntry> {
        listDirOverride?.let { return it(path) }
        return listDirImpl(path)
    }

    fun listDirImpl(path: String): List<DirEntry> {
        val norm = normalize(path)
        val prefix = if (norm.isEmpty()) "" else "$norm/"
        val seen = LinkedHashMap<String, DirEntry>()
        for ((p, entry) in entries) {
            if (p == norm) continue
            if (!p.startsWith(prefix)) continue
            val rest = p.substring(prefix.length)
            val name = rest.substringBefore('/')
            if (seen.containsKey(name)) continue
            val childPath = prefix + name
            val childEntry = entries[childPath]
            val isDir = childEntry is Entry.Dir
            seen[name] = DirEntry(
                name = name,
                path = childPath,
                isDirectory = isDir,
                isFile = !isDir,
            )
        }
        return seen.values.toList()
    }

    override fun readFile(path: String): ByteArray {
        val e = entries[normalize(path)]
        if (e !is Entry.File) throw IllegalStateException("not a file: $path")
        return e.bytes.copyOf()
    }

    override fun readText(path: String, encoding: String): String {
        val e = entries[normalize(path)]
        if (e !is Entry.File) throw IllegalStateException("not a file: $path")
        return decodeTextWithBom(e.bytes, encoding)
    }

    override fun exists(path: String): Boolean = entries.containsKey(normalize(path))

    private fun normalize(path: String): String =
        path.trim('/').replace(Regex("""/+"""), "/")

    private fun parentOf(path: String): String {
        val idx = path.lastIndexOf('/')
        return if (idx < 0) "" else path.substring(0, idx)
    }
}

/** Convenience: build a [MemoryFs] from a `path → text-content` map. */
fun makeFs(files: Map<String, String>): MemoryFs {
    val fs = MemoryFs()
    for ((path, content) in files) fs.setFile(path, content)
    return fs
}
