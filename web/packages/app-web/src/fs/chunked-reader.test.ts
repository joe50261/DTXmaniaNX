// @vitest-environment node
import {
  BlobWriter,
  Uint8ArrayReader,
  ZipReader,
  ZipWriter,
  configure,
} from '@zip.js/zip.js/index-native.js';
import { describe, expect, it } from 'vitest';
import { ChunkedReader } from './chunked-reader.js';

configure({ useWebWorkers: false });

function seededBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

/** A Blob wrapper that records every `slice().arrayBuffer()` — lets a test
 * assert how many (and how large) the underlying ranged reads were. */
function trackingBlob(u8: Uint8Array): { blob: Blob; sizes: number[] } {
  const sizes: number[] = [];
  const real = new Blob([u8 as BlobPart]);
  const wrap = (b: Blob): Blob =>
    new Proxy(b, {
      get(t, p) {
        if (p === 'slice')
          return (start = 0, end = (t as Blob).size, ...rest: unknown[]) =>
            wrap((t as Blob).slice(start, end, ...(rest as [])));
        if (p === 'arrayBuffer')
          return async () => {
            sizes.push((t as Blob).size);
            return (t as Blob).arrayBuffer();
          };
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as unknown as Blob;
  return { blob: wrap(real), sizes };
}

describe('ChunkedReader', () => {
  it('returns exactly the requested bytes, including reads that straddle a chunk boundary', async () => {
    const data = seededBytes(300 * 1024, 7); // 300 KiB
    const reader = new ChunkedReader(new Blob([data as BlobPart]), { chunkSize: 64 * 1024 });

    // Whole thing.
    expect(new Uint8Array(await reader.readUint8Array(0, data.length))).toEqual(data);
    // A window-straddling slice (64 KiB chunks, read 60 KiB..190 KiB).
    const a = new Uint8Array(await reader.readUint8Array(60 * 1024, 130 * 1024));
    expect(a).toEqual(data.subarray(60 * 1024, 190 * 1024));
    // A slice fully inside one chunk.
    const b = new Uint8Array(await reader.readUint8Array(1000, 2000));
    expect(b).toEqual(data.subarray(1000, 3000));
  });

  it('clamps a read that runs past EOF to the remaining bytes', async () => {
    const data = seededBytes(5000, 3);
    const reader = new ChunkedReader(new Blob([data as BlobPart]), { chunkSize: 4096 });
    // zip.js promises in-range reads, but be defensive: asking past the end
    // returns only what exists (the tail), zero-padded to `length`.
    const got = new Uint8Array(await reader.readUint8Array(4000, 4000));
    expect(got.subarray(0, 1000)).toEqual(data.subarray(4000, 5000));
    expect(got.subarray(1000)).toEqual(new Uint8Array(3000)); // padding past EOF
  });

  it('coalesces many small sequential reads into one fetch per window', async () => {
    const { blob, sizes } = trackingBlob(seededBytes(1 << 20, 9)); // 1 MiB, one window
    const reader = new ChunkedReader(blob, { chunkSize: 1 << 20 });
    // 16 sequential 64-KiB reads that all fall inside the single 1-MiB window.
    for (let i = 0; i < 16; i++) await reader.readUint8Array(i * 64 * 1024, 64 * 1024);
    expect(sizes).toEqual([1 << 20]); // exactly one underlying read, of a full window
  });

  it('shares one fetch across concurrent reads of the same window', async () => {
    const { blob, sizes } = trackingBlob(seededBytes(2 << 20, 11));
    const reader = new ChunkedReader(blob, { chunkSize: 1 << 20 });
    // Fire many reads of window 0 at once — they must not each fetch it.
    await Promise.all(Array.from({ length: 20 }, (_, i) => reader.readUint8Array(i * 4096, 4096)));
    expect(sizes).toEqual([1 << 20]);
  });

  it('bounds resident memory by evicting oldest windows past the cap', async () => {
    const { blob, sizes } = trackingBlob(seededBytes(8 << 20, 13)); // 8 windows
    const reader = new ChunkedReader(blob, { chunkSize: 1 << 20, maxChunks: 2 });
    // Walk forward through all 8 windows (cap 2 → each is a fresh fetch)...
    for (let w = 0; w < 8; w++) await reader.readUint8Array(w << 20, 1024);
    expect(sizes.length).toBe(8);
    // ...then re-read window 0, which must have been evicted (⇒ another fetch).
    sizes.length = 0;
    await reader.readUint8Array(0, 1024);
    expect(sizes.length).toBe(1);
  });

  it('feeds zip.js correctly end-to-end and inflates a member from few large reads', async () => {
    // A STORED archive with one 3-MiB member.
    const payload = seededBytes(3 << 20, 17);
    const writer = new ZipWriter(new BlobWriter('application/zip'), { level: 0 });
    await writer.add('big.bin', new Uint8ArrayReader(payload));
    const zipBytes = new Uint8Array(await (await writer.close()).arrayBuffer());

    const { blob, sizes } = trackingBlob(zipBytes);
    const zr = new ZipReader(new ChunkedReader(blob, { chunkSize: 1 << 20 }));
    const [entry] = await zr.getEntries();
    if (!entry || entry.directory) throw new Error('expected a file entry');
    sizes.length = 0;
    const out = new Uint8Array(await entry.arrayBuffer());
    // Correct bytes back out...
    expect(out).toEqual(payload);
    // ...and zip.js's ~48 internal 64-KiB reads collapsed into a few 1-MiB
    // fetches, not dozens of tiny ones. (Regression guard for the zip.js
    // `chunkSize` field-name collision that silently reset the window.)
    expect(sizes.length).toBeLessThanOrEqual(4);
    expect(Math.max(...sizes)).toBe(1 << 20);
  }, 30_000);
});
