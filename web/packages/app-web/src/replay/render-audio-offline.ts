/**
 * Faster-than-realtime audio render for the replay → video pipeline.
 *
 * The realtime path (replay/render.ts pre-WebCodecs) used `AudioEngine`
 * + `MediaRecorder`, which forces a 1× wall-clock encode. Switching to
 * `WebCodecs` lets the visual side encode as fast as the CPU allows;
 * the audio side has to keep up by rendering offline.
 *
 * Pipeline:
 *  1. Create an `OfflineAudioContext` sized to song.durationMs + tail,
 *     stereo @ 48 kHz to match the live AudioEngine.
 *  2. Decode every needed BGM + drum-chip WAV via the same fs loader
 *     the realtime path uses (no SampleBank — it's typed `AudioContext`
 *     and the cast isn't worth the diff for the 4 lines of decode).
 *  3. Schedule BGM chips (channel 0x01) and the replay's hits at their
 *     recorded songTime via `createBufferSource().start(when, offset)`.
 *  4. `await ctx.startRendering()` returns a single `AudioBuffer` that
 *     can be sliced into `AudioData` chunks for the encoder.
 *
 * Sidecar invariant: nothing here imports out of `replay/`. The
 * realtime path's `AudioEngine` + `XrControllers` (still used by
 * the visual side) live in their own files; this offline path
 * deliberately avoids extending AudioEngine to stay self-contained
 * inside the replay subsystem.
 */

import { joinPath, type Song } from '@dtxmania/dtx-core';
import type { Replay } from './recorder-model.js';

const BGM_CHANNEL = 0x01;
const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

export interface OfflineRenderFs {
  backend: { readFile: (path: string) => Promise<ArrayBuffer> };
  folder: string;
}

export interface OfflineRenderOpts {
  /** Total seconds the offline ctx covers. Caller already adds tail. */
  durationSec: number;
  sampleRate?: number;
  /** Optional progress callback fired per sample loaded. */
  onPreloadProgress?: (loaded: number, total: number) => void;
}

export async function renderReplayAudioOffline(
  replay: Replay,
  song: Song,
  fs: OfflineRenderFs,
  opts: OfflineRenderOpts,
): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48_000;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.max(1, Math.ceil(opts.durationSec * sampleRate)),
    sampleRate,
  });

  const samples = await preloadSamplesOffline(song, ctx, fs, opts.onPreloadProgress);

  // BGM tracks the chart's BGM_CHANNEL chips at their playbackTimeMs.
  for (const chip of song.chips) {
    if (chip.channel !== BGM_CHANNEL) continue;
    if (chip.wavId === undefined) continue;
    const buffer = samples.get(chip.wavId);
    if (!buffer) continue;
    const def = song.wavTable.get(chip.wavId);
    scheduleSource(ctx, buffer, chip.playbackTimeMs / 1000, {
      volume: def ? def.volume / 100 : 1,
      pan: def ? def.pan / 100 : 0,
    });
  }

  // Drum hits track replay.hits — same chipIndex → playables semantics
  // as the realtime path so the BGM-doubling bug doesn't sneak back.
  const playables = song.chips.filter((c) => LANE_CHANNELS.has(c.channel));
  for (const h of replay.hits) {
    if (h.chipIndex === -1) continue; // stray — silent in v0
    if (h.lagMs === null && h.judgment === 'MISS') continue; // auto-miss
    const chip = playables[h.chipIndex];
    if (!chip || chip.wavId === undefined) continue;
    const buffer = samples.get(chip.wavId);
    if (!buffer) continue;
    const def = song.wavTable.get(chip.wavId);
    scheduleSource(ctx, buffer, h.songTimeMs / 1000, {
      volume: def ? (def.volume / 100) * 0.7 : 0.7,
      pan: def ? def.pan / 100 : 0,
    });
  }

  return ctx.startRendering();
}

async function preloadSamplesOffline(
  song: Song,
  ctx: OfflineAudioContext,
  fs: OfflineRenderFs,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Map<number, AudioBuffer>> {
  const ids = new Set<number>();
  for (const chip of song.chips) {
    if (chip.wavId === undefined) continue;
    if (chip.channel === BGM_CHANNEL || LANE_CHANNELS.has(chip.channel)) {
      ids.add(chip.wavId);
    }
  }
  const total = ids.size;
  if (total === 0) {
    onProgress?.(0, 0);
    return new Map();
  }
  const out = new Map<number, AudioBuffer>();
  let loaded = 0;
  onProgress?.(0, total);
  await Promise.all(
    Array.from(ids).map(async (id) => {
      const def = song.wavTable.get(id);
      try {
        if (def?.path) {
          const bytes = await fs.backend.readFile(joinPath(fs.folder, def.path));
          // decodeAudioData mutates the input on some browsers; slice to
          // a fresh ArrayBuffer first to keep the cache shape stable.
          const decoded = await ctx.decodeAudioData(bytes.slice(0));
          out.set(id, decoded);
        }
      } catch (e) {
        console.warn('[render-audio] sample load failed', def?.path, e);
      } finally {
        loaded++;
        onProgress?.(loaded, total);
      }
    }),
  );
  return out;
}

function scheduleSource(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  whenSec: number,
  opts: { volume: number; pan: number },
): void {
  // Same routing shape AudioEngine.scheduleBuffer uses: source → gain
  // → optional panner → destination. No master gain split here — the
  // offline ctx mixes everything together; volumes / pans come straight
  // from the per-chip wavTable entries.
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = opts.volume;
  src.connect(gain);
  if (opts.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = opts.pan;
    gain.connect(panner);
    panner.connect(ctx.destination);
  } else {
    gain.connect(ctx.destination);
  }
  // Negative `whenSec` (rare — pre-roll BGM at songTime < 0) clamps to
  // 0; matches AudioEngine.scheduleBuffer's floor behaviour.
  src.start(Math.max(0, whenSec));
}
