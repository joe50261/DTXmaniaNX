/**
 * Minimal, streaming-friendly ZIP reader used to enumerate and read song
 * packs straight from a `.zip` file — no extraction, the archive is never
 * unpacked to disk.
 *
 * Design constraints (why this file looks the way it does):
 *
 *   - **Pure.** dtx-core forbids platform APIs (no DOM, no Node streams). So
 *     the two things a real reader needs — random access to the archive bytes
 *     and a DEFLATE decompressor — are *injected* by the caller as a
 *     `ByteSource` and an `Inflate` function. The browser backend wires these
 *     to `Blob.slice()` + `DecompressionStream('deflate-raw')`; tests wire
 *     them to a `Uint8Array` + `node:zlib`. This keeps the format logic here
 *     testable without a headset or a bundler.
 *
 *   - **Ranged.** A song pack can be hundreds of MB (it carries the audio).
 *     We only ever read the End-Of-Central-Directory tail, the central
 *     directory, and — on demand — one entry's compressed bytes. We never
 *     materialise the whole archive, so scanning a big pack to pull a 4 KB
 *     `set.def` stays cheap even on a Quest 3.
 *
 *   - **Central-directory authoritative.** Sizes/offsets come from the central
 *     directory, never the per-entry local header, so archives written with a
 *     streaming data-descriptor (bit 3, sizes zeroed in the local header) read
 *     correctly.
 *
 * Supported: STORE (method 0) and DEFLATE (method 8), ZIP and ZIP64 central
 * directories, UTF-8 (flag bit 11) and Shift_JIS entry names (the DTX
 * ecosystem's legacy convention). Not supported: encrypted archives (thrown
 * with a clear message) and other compression methods.
 */

/** Random-access view over the archive bytes. Implementations range-read
 * however they like (Blob slice, in-memory subarray). `read` must return
 * exactly the requested window (or fewer bytes only at EOF). */
export interface ByteSource {
  size(): number | Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array> | Uint8Array;
}

/** Raw-DEFLATE decompressor. `expectedSize` is the entry's uncompressed size
 * from the central directory — implementations may use it to pre-size a
 * buffer, or ignore it. */
export type Inflate = (
  deflated: Uint8Array,
  expectedSize: number
) => Promise<Uint8Array> | Uint8Array;

export interface ZipEntry {
  /** Forward-slash path as stored, no leading slash, no trailing slash for
   * directories (the raw trailing `/` marker is stripped and reflected in
   * `isDirectory` instead). */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** General-purpose bit flag (bit 0 = encrypted, bit 3 = data descriptor,
   * bit 11 = UTF-8 name). Retained for read-time validation. */
  flags: number;
  isDirectory: boolean;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Entries keyed by `name` (directories without the trailing slash) for
   * O(1) existence / read lookups. */
  byName: Map<string, ZipEntry>;
}

// --- Signatures (little-endian 32-bit) --------------------------------------
const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_EOCD64 = 0x06064b50; // ZIP64 end of central directory record
const SIG_EOCD64_LOC = 0x07064b50; // ZIP64 EOCD locator
const SIG_CENTRAL = 0x02014b50; // Central directory file header
const SIG_LOCAL = 0x04034b50; // Local file header

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Read + parse the archive's central directory. Does no decompression — just
 * enough ranged reads to enumerate every entry. Throws on a malformed archive.
 */
export async function readZipDirectory(src: ByteSource): Promise<ZipDirectory> {
  const size = await src.size();
  if (size < EOCD_MIN_SIZE) throw new Error('zip too small to be valid');

  // The EOCD sits at the very end, possibly followed by an up-to-64 KB
  // comment. Read the tail and scan backwards for its signature.
  const tailLen = Math.min(size, EOCD_MIN_SIZE + MAX_COMMENT);
  const tailStart = size - tailLen;
  const tail = await readExact(src, tailStart, tailLen);
  const eocdRel = findEocd(tail);
  if (eocdRel < 0) throw new Error('zip end-of-central-directory not found');
  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdRel, tail.length - eocdRel);

  let totalEntries = eocd.getUint16(10, true);
  let cdSize = eocd.getUint32(12, true);
  let cdOffset = eocd.getUint32(16, true);

  // Any 0xFFFF / 0xFFFFFFFF sentinel means the real value lives in a ZIP64
  // record. The ZIP64 EOCD locator sits immediately before the EOCD.
  if (totalEntries === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const z = await readZip64(src, tail, tailStart, eocdRel);
    totalEntries = z.totalEntries;
    cdSize = z.cdSize;
    cdOffset = z.cdOffset;
  }

  const cd = await readExact(src, cdOffset, cdSize);
  const entries = parseCentralDirectory(cd, totalEntries);
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) byName.set(e.name, e);
  return { entries, byName };
}

/**
 * Read a single entry's decompressed bytes. Reads the entry's local header to
 * find where its data begins (the local header's name/extra lengths can differ
 * from the central directory's), then range-reads exactly the compressed
 * bytes and inflates them.
 */
export async function readZipEntry(
  src: ByteSource,
  entry: ZipEntry,
  inflate: Inflate
): Promise<Uint8Array> {
  if (entry.isDirectory) throw new Error(`cannot read a directory entry: ${entry.name}`);
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new Error(`encrypted zip entries are not supported: ${entry.name}`);
  }

  const header = await readExact(src, entry.localHeaderOffset, 30);
  const hv = new DataView(header.buffer, header.byteOffset, header.length);
  if (hv.getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  const nameLen = hv.getUint16(26, true);
  const extraLen = hv.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = await readExact(src, dataStart, entry.compressedSize);

  if (entry.compressionMethod === METHOD_STORE) {
    // Copy out of the (possibly larger) backing buffer so callers own a tight
    // Uint8Array they can hand to a decoder / `.buffer.slice`.
    return compressed.slice();
  }
  if (entry.compressionMethod === METHOD_DEFLATE) {
    return inflate(compressed, entry.uncompressedSize);
  }
  throw new Error(
    `unsupported compression method ${entry.compressionMethod} for ${entry.name}`
  );
}

/**
 * List the immediate children of `prefix` within an archive, synthesising
 * directory nodes for paths that only exist implicitly (many zips omit
 * explicit `dir/` entries). `prefix` is a normalised in-archive path
 * ("" for the archive root, "song" for a subfolder). Returns children with
 * just a name + kind; the backend layer attaches full POSIX paths.
 */
export function listZipDir(
  entries: readonly ZipEntry[],
  prefix: string
): Array<{ name: string; isDirectory: boolean }> {
  const norm = normalizeZipPath(prefix);
  const full = norm === '' ? '' : norm + '/';
  const seen = new Map<string, boolean>(); // name -> isDirectory
  for (const entry of entries) {
    const raw = entry.isDirectory ? entry.name + '/' : entry.name;
    if (!raw.startsWith(full)) continue;
    const rest = raw.slice(full.length);
    if (rest === '') continue; // the prefix directory itself
    const slash = rest.indexOf('/');
    if (slash === -1) {
      // Direct file child (dir entries always carry a trailing slash, so a
      // slash-less remainder is necessarily a file).
      if (!seen.get(rest)) seen.set(rest, false);
    } else {
      // Nested path — its first segment is a child directory.
      seen.set(rest.slice(0, slash), true);
    }
  }
  return Array.from(seen, ([name, isDirectory]) => ({ name, isDirectory }));
}

/** True if `path` names a file, an explicit directory, or an implied
 * directory (a prefix of some entry) within the archive. "" (the root) is
 * always considered to exist. */
export function zipEntryExists(entries: readonly ZipEntry[], path: string): boolean {
  const norm = normalizeZipPath(path);
  if (norm === '') return true;
  const asDir = norm + '/';
  for (const entry of entries) {
    if (entry.name === norm) return true;
    if (entry.isDirectory && entry.name === norm) return true;
    if (entry.name.startsWith(asDir)) return true;
  }
  return false;
}

/** Build a `ByteSource` over an in-memory buffer. Used by the whole-file
 * fallback (backends without ranged reads) and by tests. */
export function byteSourceFromBytes(bytes: Uint8Array): ByteSource {
  return {
    size: () => bytes.length,
    read: (offset, length) => bytes.subarray(offset, offset + length),
  };
}

/** Strip a single leading/trailing slash run and collapse repeats. Exported
 * so the backend normalises in-archive paths identically to the reader. */
export function normalizeZipPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

// --- internals --------------------------------------------------------------

/** Scan backwards for the EOCD signature. Returns its offset within `tail`,
 * or -1. Backwards so a comment that happens to embed the signature can't
 * shadow the real record. */
function findEocd(tail: Uint8Array): number {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.length);
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      // Sanity: comment length must fit exactly to end-of-archive.
      const commentLen = dv.getUint16(i + 20, true);
      if (i + EOCD_MIN_SIZE + commentLen === tail.length) return i;
    }
  }
  return -1;
}

async function readZip64(
  src: ByteSource,
  tail: Uint8Array,
  tailStart: number,
  eocdRel: number
): Promise<{ totalEntries: number; cdSize: number; cdOffset: number }> {
  const locRel = eocdRel - 20;
  if (locRel < 0) throw new Error('zip64 locator missing');
  const locDv = new DataView(tail.buffer, tail.byteOffset + locRel, 20);
  if (locDv.getUint32(0, true) !== SIG_EOCD64_LOC) {
    throw new Error('zip64 locator signature mismatch');
  }
  const eocd64Offset = readU64(locDv, 8);
  const rec = await readExact(src, eocd64Offset, 56);
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
  if (dv.getUint32(0, true) !== SIG_EOCD64) {
    throw new Error('zip64 end-of-central-directory signature mismatch');
  }
  void tailStart; // (kept for symmetry with the ZIP path; not needed here)
  return {
    totalEntries: readU64(dv, 32),
    cdSize: readU64(dv, 40),
    cdOffset: readU64(dv, 48),
  };
}

function parseCentralDirectory(cd: Uint8Array, totalEntries: number): ZipEntry[] {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.length);
  const entries: ZipEntry[] = [];
  let p = 0;
  // Trust `totalEntries` but stop early if the buffer runs out — a truncated
  // central directory should surface as "fewer songs" rather than an overrun.
  for (let i = 0; i < totalEntries && p + 46 <= cd.length; i++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error(`bad central directory header at ${p}`);
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let uncompressedSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOffset = dv.getUint32(p + 42, true);

    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const rawName = decodeZipName(nameBytes, flags);

    // ZIP64 extra field patches whichever base fields were sentinelled.
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localOffset === U32_MAX) {
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const z64 = readZip64Extra(extra, {
        uncompressed: uncompressedSize === U32_MAX,
        compressed: compressedSize === U32_MAX,
        offset: localOffset === U32_MAX,
      });
      if (z64.uncompressedSize !== undefined) uncompressedSize = z64.uncompressedSize;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.localOffset !== undefined) localOffset = z64.localOffset;
    }

    const isDirectory = rawName.endsWith('/');
    const name = normalizeZipPath(rawName);
    // Skip zero-length normalised names (e.g. a stray "/" entry).
    if (name.length > 0) {
      entries.push({
        name,
        compressionMethod: method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset: localOffset,
        flags,
        isDirectory,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read the ZIP64 extended-information extra field (header id 0x0001). Only
 * the fields flagged present (sentinelled in the base record) appear, in a
 * fixed order: uncompressed, compressed, local-offset, disk. */
function readZip64Extra(
  extra: Uint8Array,
  want: { uncompressed: boolean; compressed: boolean; offset: boolean }
): { uncompressedSize?: number; compressedSize?: number; localOffset?: number } {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.length);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    const body = p + 4;
    if (id === 0x0001) {
      let q = body;
      const out: { uncompressedSize?: number; compressedSize?: number; localOffset?: number } = {};
      if (want.uncompressed && q + 8 <= body + len) {
        out.uncompressedSize = readU64(dv, q);
        q += 8;
      }
      if (want.compressed && q + 8 <= body + len) {
        out.compressedSize = readU64(dv, q);
        q += 8;
      }
      if (want.offset && q + 8 <= body + len) {
        out.localOffset = readU64(dv, q);
        q += 8;
      }
      return out;
    }
    p = body + len;
  }
  return {};
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  // Bit 11 promises UTF-8. Otherwise the DTX world overwhelmingly authors
  // Shift_JIS — decode as such so in-archive names match the Shift_JIS
  // `set.def` references that point at them. `fatal: false` keeps a stray
  // odd byte from throwing mid-scan.
  const encoding = flags & FLAG_UTF8 ? 'utf-8' : 'shift-jis';
  return new TextDecoder(encoding).decode(bytes);
}

async function readExact(src: ByteSource, offset: number, length: number): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0);
  const chunk = await src.read(offset, length);
  if (chunk.length < length) {
    throw new Error(`short read: wanted ${length} at ${offset}, got ${chunk.length}`);
  }
  return chunk;
}

/** Read a little-endian unsigned 64-bit value as a JS number. Song-pack
 * offsets/sizes are far below 2^53, so the precision loss above that is
 * irrelevant here; guard anyway so a corrupt field fails loudly. */
function readU64(dv: DataView, offset: number): number {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  const value = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(value)) {
    throw new Error('zip64 value exceeds safe integer range');
  }
  return value;
}
