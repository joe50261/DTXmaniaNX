import { describe, expect, it, vi } from 'vitest';
import { SampleBank, type SampleLoader } from './sample-bank.js';

/** Minimum AudioContext surface SampleBank touches: decodeAudioData.
 *  Keep the mock shape tight so tests document the contract. */
interface MockContext {
  decodeAudioData: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
}

function fakeBuffer(tag = 'buf'): AudioBuffer {
  // Tagged object standing in for an AudioBuffer. SampleBank itself
  // does not inspect any AudioBuffer field, so referential identity
  // is enough to verify cache semantics.
  return { __tag: tag } as unknown as AudioBuffer;
}

function fakeBytes(byteLength = 16): ArrayBuffer {
  return new ArrayBuffer(byteLength);
}

describe('SampleBank', () => {
  it('load() caches AudioBuffers by path — second call returns the same buffer without re-decoding', async () => {
    const buf = fakeBuffer('A');
    const decode = vi.fn(async () => buf);
    const loader: SampleLoader = vi.fn(async () => fakeBytes());
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    const a = await bank.load('Songs/a.wav');
    const b = await bank.load('Songs/a.wav');

    expect(a).toBe(buf);
    expect(b).toBe(buf);
    // Both loader and decoder should have fired exactly once.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent loads of the same path — one decode even with overlapping awaits', async () => {
    // Two callers race for the same sample; the cache is by promise so
    // only the first kicks off work, the second awaits the same promise.
    const buf = fakeBuffer();
    const decode = vi.fn(async () => buf);
    const loader: SampleLoader = vi.fn(async () => fakeBytes());
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    const [a, b] = await Promise.all([bank.load('x.wav'), bank.load('x.wav')]);
    expect(a).toBe(buf);
    expect(b).toBe(buf);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('loads different paths independently', async () => {
    const bufA = fakeBuffer('A');
    const bufB = fakeBuffer('B');
    const decode = vi.fn(async (bytes: ArrayBuffer) => (bytes.byteLength === 8 ? bufA : bufB));
    const loader: SampleLoader = vi.fn(async (path) =>
      fakeBytes(path === 'a.wav' ? 8 : 16)
    );
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    expect(await bank.load('a.wav')).toBe(bufA);
    expect(await bank.load('b.wav')).toBe(bufB);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('loader throws → load() resolves to null (silent fallback to synth)', async () => {
    // Matches the comment on SampleBank: "decode errors gracefully".
    // Without this guarantee, a single missing WAV would crash the
    // song-load pipeline.
    const decode = vi.fn();
    const loader: SampleLoader = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    expect(await bank.load('missing.wav')).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it('decodeAudioData throws → load() resolves to null', async () => {
    const decode = vi.fn(async () => {
      throw new Error('corrupt');
    });
    const loader: SampleLoader = vi.fn(async () => fakeBytes());
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    expect(await bank.load('broken.wav')).toBeNull();
  });

  it('passes a fresh ArrayBuffer slice to decodeAudioData (loader buffer stays intact)', async () => {
    // decodeAudioData detaches/transfers the buffer in some browsers.
    // SampleBank slices before passing so the loader's returned value
    // (or any caller retaining a reference) is not invalidated.
    const decode = vi.fn(async (bytes: ArrayBuffer) => {
      expect(bytes).not.toBe(original);
      expect(bytes.byteLength).toBe(original.byteLength);
      return fakeBuffer();
    });
    const original = fakeBytes(32);
    const loader: SampleLoader = vi.fn(async () => original);
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    await bank.load('p.wav');
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('clear() drops the cache so a subsequent load goes through the loader again', async () => {
    const buf = fakeBuffer();
    const decode = vi.fn(async () => buf);
    const loader: SampleLoader = vi.fn(async () => fakeBytes());
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    await bank.load('x.wav');
    bank.clear();
    await bank.load('x.wav');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('failure is cached too — second load of a broken path does not retry', async () => {
    // Current behaviour: the failed promise (which resolves to null) is
    // cached and returned on subsequent load()s. This avoids retry
    // storms when e.g. one of 60 BGM chips has a bad path. Pin the
    // behaviour explicitly so a well-meaning refactor (adding
    // invalidate-on-null) doesn't regress performance.
    const decode = vi.fn();
    const loader: SampleLoader = vi.fn(async () => {
      throw new Error('nope');
    });
    const bank = new SampleBank({ decodeAudioData: decode } as unknown as AudioContext, loader);

    expect(await bank.load('bad.wav')).toBeNull();
    expect(await bank.load('bad.wav')).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
