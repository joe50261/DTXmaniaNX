/**
 * Codec selection for the replay → video render path.
 *
 * MediaRecorder support varies across browsers and Chromium versions:
 *  - MP4 (H.264 + AAC) muxer landed in Chromium 114 (mid-2023). Quest
 *    browser tracks Chromium via Meta's fork; recent firmware should
 *    have it but we can't assume.
 *  - WebM (VP9 / VP8 + Opus) is universal across modern Chromium /
 *    Firefox / Safari (Tech Preview).
 *
 * The picker probes `MediaRecorder.isTypeSupported` against an ordered
 * candidate list and returns the first hit. MP4 is preferred because
 * social platforms (YouTube, Twitter, Discord) auto-process it most
 * smoothly; WebM is the always-on fallback.
 *
 * Pure model — no DOM, no MediaRecorder. The `probe` argument is
 * `MediaRecorder.isTypeSupported` at runtime; tests pass a fake.
 */

/** Candidates in preference order. The exact codec strings match what
 * Chrome's MediaRecorder accepts as of Chromium 114 / Quest browser
 * v34+. Tweaking these affects output codec / quality but not the
 * picker logic. */
export const DEFAULT_CODEC_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
] as const;

export type SupportedExtension = 'mp4' | 'webm';

export interface CodecPick {
  /** MIME string to feed to `new MediaRecorder(stream, { mimeType })`. */
  mime: string;
  /** File extension for the downloaded blob. */
  ext: SupportedExtension;
}

/** Probe `isTypeSupported` against `candidates` in order; return the
 * first match plus its conventional file extension. Returns null when
 * none match — caller should surface a "browser too old" error rather
 * than fall back to an arbitrary codec. */
export function pickCodec(
  isTypeSupported: (mime: string) => boolean,
  candidates: readonly string[] = DEFAULT_CODEC_CANDIDATES,
): CodecPick | null {
  for (const mime of candidates) {
    if (isTypeSupported(mime)) {
      return { mime, ext: extensionForMime(mime) };
    }
  }
  return null;
}

/** Convenience: extract the extension from a chosen MIME. Throws on
 * unrecognised — callers should only pass strings that came out of
 * `DEFAULT_CODEC_CANDIDATES`, not arbitrary values. */
export function extensionForMime(mime: string): SupportedExtension {
  if (mime.startsWith('video/mp4')) return 'mp4';
  if (mime.startsWith('video/webm')) return 'webm';
  throw new Error(`extensionForMime: unrecognised MIME ${mime}`);
}
