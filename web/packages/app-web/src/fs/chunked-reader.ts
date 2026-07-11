import { Reader } from '@zip.js/zip.js/index-native.js';

/**
 * A zip.js `Reader` that fronts a `Blob` (a song-pack `.zip` handed out by the
 * File System Access backend) with an in-memory cache of fixed-size, aligned
 * chunks. It exists to cut the *number* of ranged reads zip.js issues, not the
 * bytes.
 *
 * ## Why
 *
 * zip.js reads each archive member with several small ranged reads (local
 * header, then the compressed data) via `Blob.slice().arrayBuffer()`. On a
 * loose folder that's cheap, but a `.zip` pack is one `File` behind the File
 * System Access bridge, where **every** ranged read is a high-latency
 * round-trip that (on the Quest browser) does not reliably run in parallel on a
 * single handle. Loading one song then means ~4 reads × ~60 members ≈ 230
 * serialized round-trips — tens of seconds — and a library scan is hundreds
 * more. The bytes moved are tiny; the round-trip count is the cost.
 *
 * Because a member's local header and data are adjacent, and every member of
 * one song folder is written contiguously, backing zip.js with chunked reads
 * collapses that burst: the first read into a region fetches a whole
 * `chunkSize` window, and the dozens of small reads that follow are served from
 * memory. Measured: a one-song preload drops from ~230 ranged reads to a
 * handful, and the central-directory parse (`getEntries`) to one.
 *
 * ## Memory
 *
 * Chunks are evicted oldest-first once `maxChunks` are resident, so one reader
 * holds at most `chunkSize * maxChunks` bytes. Eviction is FIFO, which matches
 * both access patterns: a scan walks forward (old chunks fall behind and aren't
 * revisited) and a preload touches only a couple of chunks at once (well under
 * the cap, so nothing is evicted mid-burst). Evicting a chunk a concurrent read
 * still wants only costs a re-fetch, never wrong bytes.
 */
export interface ChunkedReaderOptions {
  /** Bytes fetched per cache miss. Larger = fewer round-trips but more bytes
   * pulled per header probe during a scan. Default 1 MiB. */
  chunkSize?: number;
  /** Max resident chunks before oldest-first eviction. `chunkSize * maxChunks`
   * bounds one reader's memory. Default 32 (⇒ 32 MiB at the default chunk). */
  maxChunks?: number;
}

const DEFAULT_CHUNK_SIZE = 1 << 20; // 1 MiB
// Cap resident chunks per reader. A reader is memoised for the whole session
// (one per opened pack), so this is the per-pack memory ceiling:
// DEFAULT_CHUNK_SIZE * DEFAULT_MAX_CHUNKS = 16 MiB. One song's samples span only
// a handful of 1-MiB windows, so 16 comfortably covers a preload burst without
// re-fetching, while keeping a library of many open packs bounded on a headset.
const DEFAULT_MAX_CHUNKS = 16;

export class ChunkedReader extends Reader<Blob> {
  override size: number;
  /**
   * Our fetch-window size. **Deliberately not named `chunkSize`**: zip.js's
   * `ZipReader` writes its own `chunkSize` (64 KiB) onto the reader instance to
   * drive `Reader.readable`'s pull size, which would silently clobber ours and
   * collapse every fetch back to 64 KiB — the exact behaviour we're removing.
   * A distinct name keeps our window intact; zip.js still gets to set its own.
   */
  private readonly windowBytes: number;
  private readonly maxChunks: number;
  /** chunk index → its bytes (a Promise so concurrent readers of the same
   * region share one underlying fetch instead of racing duplicates). */
  private readonly chunks = new Map<number, Promise<Uint8Array>>();

  constructor(private readonly blob: Blob, options: ChunkedReaderOptions = {}) {
    super(blob);
    this.size = blob.size;
    this.windowBytes = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    this.maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
  }

  // zip.js awaits this before its first read; `size` is already known from the
  // blob, so there's nothing to prepare.
  override async init(): Promise<void> {}

  /**
   * Return exactly `length` bytes starting at `index`, assembled from the
   * chunk cache. zip.js guarantees the range is within `[0, size]`; we clamp
   * defensively and stitch across chunk boundaries when a read straddles one.
   */
  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    const end = Math.min(this.size, index + length);
    let written = 0;
    let pos = index;
    while (pos < end) {
      const chunkIndex = Math.floor(pos / this.windowBytes);
      const chunk = await this.chunkAt(chunkIndex);
      const offsetInChunk = pos - chunkIndex * this.windowBytes;
      const available = chunk.length - offsetInChunk;
      if (available <= 0) break; // past EOF within the final chunk
      const take = Math.min(end - pos, available);
      out.set(chunk.subarray(offsetInChunk, offsetInChunk + take), written);
      written += take;
      pos += take;
    }
    return out;
  }

  private chunkAt(chunkIndex: number): Promise<Uint8Array> {
    const cached = this.chunks.get(chunkIndex);
    if (cached) return cached;

    const start = chunkIndex * this.windowBytes;
    const stop = Math.min(this.size, start + this.windowBytes);
    const pending = this.blob
      .slice(start, stop)
      .arrayBuffer()
      .then((buf) => new Uint8Array(buf));
    this.chunks.set(chunkIndex, pending);

    // FIFO eviction: drop the oldest resident chunk once over the cap. Never
    // drop the one we just inserted (guarded by size > maxChunks, so the map
    // holds at least two before this can fire).
    if (this.chunks.size > this.maxChunks) {
      const oldest = this.chunks.keys().next().value;
      if (oldest !== undefined && oldest !== chunkIndex) this.chunks.delete(oldest);
    }
    return pending;
  }
}
