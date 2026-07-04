import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  byteSourceFromBytes,
  listZipDir,
  readZipDirectory,
  readZipEntry,
  zipEntryExists,
  type Inflate,
} from '../src/scanner/zip.js';

// Node's zlib is the authoritative DEFLATE codec for these tests — it mirrors
// what the browser's DecompressionStream('deflate-raw') does at runtime.
const inflate: Inflate = (bytes) => new Uint8Array(inflateRawSync(bytes));

interface FileSpec {
  /** Raw name bytes as stored in the archive (lets a test author Shift_JIS
   * names that no TextEncoder can produce). */
  nameBytes: Uint8Array;
  data: Uint8Array;
  /** 0 = STORE, 8 = DEFLATE. */
  method: 0 | 8;
  /** General-purpose flags (bit 11 = UTF-8 name). */
  flags: number;
}

/** Minimal but real ZIP writer: local headers, central directory, EOCD.
 * Deliberately hand-rolled so the reader is tested against bytes we fully
 * control, not against a library that might paper over a parsing bug. */
function makeZip(files: FileSpec[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  const pushU16 = (arr: number[], v: number) => arr.push(v & 0xff, (v >>> 8) & 0xff);
  const pushU32 = (arr: number[], v: number) =>
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  for (const f of files) {
    const stored = f.method === 8 ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = crc32(f.data);
    const offset = local.length;
    offsets.push(offset);

    // Local file header.
    pushU32(local, 0x04034b50);
    pushU16(local, 20); // version needed
    pushU16(local, f.flags);
    pushU16(local, f.method);
    pushU16(local, 0); // mod time
    pushU16(local, 0); // mod date
    pushU32(local, crc);
    pushU32(local, stored.length);
    pushU32(local, f.data.length);
    pushU16(local, f.nameBytes.length);
    pushU16(local, 0); // extra len
    local.push(...f.nameBytes);
    local.push(...stored);

    // Central directory header.
    pushU32(central, 0x02014b50);
    pushU16(central, 20); // version made by
    pushU16(central, 20); // version needed
    pushU16(central, f.flags);
    pushU16(central, f.method);
    pushU16(central, 0);
    pushU16(central, 0);
    pushU32(central, crc);
    pushU32(central, stored.length);
    pushU32(central, f.data.length);
    pushU16(central, f.nameBytes.length);
    pushU16(central, 0); // extra len
    pushU16(central, 0); // comment len
    pushU16(central, 0); // disk start
    pushU16(central, 0); // internal attrs
    pushU32(central, 0); // external attrs
    pushU32(central, offset);
    central.push(...f.nameBytes);
  }

  const cdOffset = local.length;
  const eocd: number[] = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0); // disk
  pushU16(eocd, 0); // cd start disk
  pushU16(eocd, files.length);
  pushU16(eocd, files.length);
  pushU32(eocd, central.length);
  pushU32(eocd, cdOffset);
  pushU16(eocd, 0); // comment len

  return new Uint8Array([...local, ...central, ...eocd]);
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function file(name: string, content: string, method: 0 | 8 = 8, flags = 0): FileSpec {
  return { nameBytes: utf8(name), data: utf8(content), method, flags };
}

describe('readZipDirectory', () => {
  it('enumerates stored and deflated entries with correct sizes', async () => {
    const bytes = makeZip([
      file('set.def', '#TITLE Song', 0),
      file('bas.dtx', '#TITLE Song\n#DLEVEL: 30', 8),
    ]);
    const dir = await readZipDirectory(byteSourceFromBytes(bytes));
    expect(dir.entries.map((e) => e.name).sort()).toEqual(['bas.dtx', 'set.def']);
    const dtx = dir.byName.get('bas.dtx')!;
    expect(dtx.compressionMethod).toBe(8);
    expect(dtx.uncompressedSize).toBe('#TITLE Song\n#DLEVEL: 30'.length);
    expect(dir.byName.get('set.def')!.compressionMethod).toBe(0);
  });

  it('tolerates a trailing archive comment', async () => {
    const base = makeZip([file('a.dtx', 'hello', 0)]);
    // Append a fake comment and bump the EOCD comment-length field so the
    // backward EOCD scan has to skip past it.
    const comment = utf8('this is a pack comment PK\x05\x06 lookalike');
    const withComment = new Uint8Array(base.length + comment.length);
    withComment.set(base);
    withComment.set(comment, base.length);
    const dv = new DataView(withComment.buffer);
    // EOCD is the last 22 bytes of `base`; its comment-length field is at
    // base.length - 2.
    dv.setUint16(base.length - 2, comment.length, true);
    const dir = await readZipDirectory(byteSourceFromBytes(withComment));
    expect(dir.entries.map((e) => e.name)).toEqual(['a.dtx']);
  });

  it('decodes Shift_JIS entry names when the UTF-8 flag is unset', async () => {
    // 0x82 0xA0 = "あ" in Shift_JIS.
    const nameBytes = new Uint8Array([0x82, 0xa0, ...utf8('.dtx')]);
    const bytes = makeZip([{ nameBytes, data: utf8('x'), method: 0, flags: 0 }]);
    const dir = await readZipDirectory(byteSourceFromBytes(bytes));
    expect(dir.entries[0]!.name).toBe('あ.dtx');
  });

  it('throws on a buffer too small to hold an EOCD', async () => {
    await expect(readZipDirectory(byteSourceFromBytes(new Uint8Array(4)))).rejects.toThrow();
  });
});

describe('readZipEntry', () => {
  it('round-trips deflated content', async () => {
    const body = 'あいうえお'.repeat(50); // compressible, multibyte
    const bytes = makeZip([file('song/adv.dtx', body, 8)]);
    const src = byteSourceFromBytes(bytes);
    const dir = await readZipDirectory(src);
    const out = await readZipEntry(src, dir.byName.get('song/adv.dtx')!, inflate);
    expect(new TextDecoder('utf-8').decode(out)).toBe(body);
  });

  it('returns stored content verbatim', async () => {
    const bytes = makeZip([file('set.def', '#TITLE Pack', 0)]);
    const src = byteSourceFromBytes(bytes);
    const dir = await readZipDirectory(src);
    const out = await readZipEntry(src, dir.byName.get('set.def')!, inflate);
    expect(new TextDecoder('utf-8').decode(out)).toBe('#TITLE Pack');
  });

  it('rejects encrypted entries', async () => {
    const bytes = makeZip([file('a.dtx', 'secret', 0, 0x0001)]);
    const src = byteSourceFromBytes(bytes);
    const dir = await readZipDirectory(src);
    await expect(readZipEntry(src, dir.entries[0]!, inflate)).rejects.toThrow(/encrypted/);
  });
});

describe('listZipDir', () => {
  it('lists immediate children and synthesises implied directories', async () => {
    const bytes = makeZip([
      file('box.def', '#TITLE Pack', 0),
      file('song-a/set.def', '#TITLE A', 0),
      file('song-a/bas.dtx', 'a', 0),
      file('song-b/set.def', '#TITLE B', 0),
    ]);
    const dir = await readZipDirectory(byteSourceFromBytes(bytes));

    const root = listZipDir(dir.entries, '').sort((a, b) => a.name.localeCompare(b.name));
    expect(root).toEqual([
      { name: 'box.def', isDirectory: false },
      { name: 'song-a', isDirectory: true },
      { name: 'song-b', isDirectory: true },
    ]);

    const inner = listZipDir(dir.entries, 'song-a').sort((a, b) => a.name.localeCompare(b.name));
    expect(inner).toEqual([
      { name: 'bas.dtx', isDirectory: false },
      { name: 'set.def', isDirectory: false },
    ]);
  });
});

describe('zipEntryExists', () => {
  it('matches files, implied directories, and the root', async () => {
    const bytes = makeZip([file('song/adv.dtx', 'x', 0)]);
    const dir = await readZipDirectory(byteSourceFromBytes(bytes));
    expect(zipEntryExists(dir.entries, '')).toBe(true);
    expect(zipEntryExists(dir.entries, 'song')).toBe(true); // implied dir
    expect(zipEntryExists(dir.entries, 'song/adv.dtx')).toBe(true);
    expect(zipEntryExists(dir.entries, 'song/missing.dtx')).toBe(false);
    expect(zipEntryExists(dir.entries, 'nope')).toBe(false);
  });
});
