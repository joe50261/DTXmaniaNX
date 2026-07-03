import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODEC_CANDIDATES,
  extensionForMime,
  pickCodec,
} from './render-codec-model.js';

/**
 * Pure picker tests. The `probe` argument is the only browser
 * touchpoint; tests inject `(mime) => set.has(mime)` to simulate
 * each browser's support matrix.
 */

const MP4 = DEFAULT_CODEC_CANDIDATES[0];
const WEBM_VP9 = DEFAULT_CODEC_CANDIDATES[1];
const WEBM_VP8 = DEFAULT_CODEC_CANDIDATES[2];

function probeFrom(set: Set<string>) {
  return (mime: string): boolean => set.has(mime);
}

describe('pickCodec', () => {
  it('returns the first candidate that probes supported', () => {
    const out = pickCodec(probeFrom(new Set([MP4, WEBM_VP9, WEBM_VP8])));
    expect(out?.mime).toBe(MP4);
    expect(out?.ext).toBe('mp4');
  });

  it('falls through to WebM/VP9 when MP4 is unsupported (older Chromium)', () => {
    const out = pickCodec(probeFrom(new Set([WEBM_VP9, WEBM_VP8])));
    expect(out?.mime).toBe(WEBM_VP9);
    expect(out?.ext).toBe('webm');
  });

  it('falls through to WebM/VP8 when MP4 + VP9 are unsupported', () => {
    const out = pickCodec(probeFrom(new Set([WEBM_VP8])));
    expect(out?.mime).toBe(WEBM_VP8);
    expect(out?.ext).toBe('webm');
  });

  it('returns null when no candidate is supported', () => {
    expect(pickCodec(probeFrom(new Set()))).toBeNull();
  });

  it('respects a custom candidate list (preference order honoured)', () => {
    const customA = 'video/webm;codecs=av01';
    const customB = 'video/mp4;codecs=hev1';
    const probe = probeFrom(new Set([customA, customB]));
    const out = pickCodec(probe, ['video/mp4;codecs=missing', customA, customB]);
    // First candidate fails the probe; second is the first hit.
    expect(out?.mime).toBe(customA);
    expect(out?.ext).toBe('webm');
  });

  it('does not call probe more than once per candidate', () => {
    let calls = 0;
    pickCodec(
      (mime) => {
        calls++;
        return mime === WEBM_VP9;
      },
      DEFAULT_CODEC_CANDIDATES,
    );
    // Stops at the first match (probe order: MP4 fail → VP9 hit).
    expect(calls).toBe(2);
  });
});

describe('extensionForMime', () => {
  it("returns 'mp4' for an MP4 MIME", () => {
    expect(extensionForMime(MP4)).toBe('mp4');
  });

  it("returns 'webm' for a WebM MIME (VP9 or VP8)", () => {
    expect(extensionForMime(WEBM_VP9)).toBe('webm');
    expect(extensionForMime(WEBM_VP8)).toBe('webm');
  });

  it('throws on unrecognised MIME (defensive — caller should only pass real picks)', () => {
    expect(() => extensionForMime('audio/ogg')).toThrow();
  });
});
