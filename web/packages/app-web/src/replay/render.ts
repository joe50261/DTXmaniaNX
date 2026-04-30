/**
 * Replay → MP4 file render path (WebCodecs).
 *
 * Faster-than-realtime: the realtime path used `MediaRecorder` +
 * `AudioEngine` and was 1× wall-clock bound (3-min song = 3-min
 * render + tab focus required). The user asked for either background
 * rendering or a speed-up; speed-up wins because it solves both
 * problems at once (a render that finishes in ~30s doesn't NEED
 * background scheduling).
 *
 * Pipeline:
 *   1. Audio: `OfflineAudioContext` mixes BGM + per-hit chip samples
 *      into a single `AudioBuffer`. Done in `render-audio-offline.ts`.
 *   2. Visual: an offscreen canvas + the existing `Renderer` /
 *      `XrControllers` (fresh instances — sidecar invariant) drives
 *      a frame-by-frame loop. Each frame becomes a `VideoFrame` via
 *      `new VideoFrame(canvas, { timestamp })`, encoded by
 *      `VideoEncoder`.
 *   3. Mux: `mp4-muxer` interleaves video + audio chunks into an
 *      MP4 container, `ArrayBufferTarget` collects the bytes.
 *
 * Codec choice: `avc1.42E01E` (H.264 baseline) + `mp4a.40.2` (AAC LC).
 * One container (MP4) covers virtually every share target the user
 * cares about (YouTube / Twitter / Discord / phone gallery). WebM
 * fallback is plumbed in `render-codec-model.ts` but unused by this
 * path — H.264 encode is supported in Chromium 94+, which both Quest
 * browser and any modern desktop satisfy.
 *
 * Out of scope here:
 *  - Stray-hit audio (sample fallback via `lastBufferByLane`); strays
 *    paint visually but stay silent.
 *  - Auto-cinematography (cuts on bar lines, miss zoom). Camera is
 *    a fixed broadcast angle defined below.
 */

import * as THREE from 'three';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebMMuxer, ArrayBufferTarget as WebMTarget } from 'webm-muxer';
import {
  computeAchievementRate,
  computeRank,
  isExcellent,
  isFullCombo,
  parseDtx,
  computeTiming,
  ScoreTracker,
} from '@dtxmania/dtx-core';
import { type LaneValue } from '@dtxmania/input';
import { Renderer, type RenderState, type SkinTextures } from '../renderer.js';
import { XrControllers, type XrPose } from '../xr-controllers.js';
import {
  lerpPoseSample,
  replayActiveHitFlashes,
  replayActiveJudgmentFlash,
} from './viewer-model.js';
import { renderReplayAudioOffline } from './render-audio-offline.js';
import type { Replay } from './recorder-model.js';

const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

/** Tail beyond `song.durationMs` we keep rendering for, so the last
 * judgment flash + score animation completes before encode finishes. */
const RENDER_TAIL_MS = 1500;

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 60;
const VIDEO_BITRATE = 2_500_000;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = 128_000;
/** Larger chunks → fewer Float32Array allocs across the audio loop;
 * 100 ms @ 48 kHz fits comfortably in any encoder's frame size. */
const AUDIO_FRAMES_PER_CHUNK = 4800;
/** Max video frames the encoder may have queued before we yield.
 * Quest's RAM ceiling is much tighter than a desktop's; without
 * this the loop pumps frames faster than the encoder consumes them
 * and the queue grows unbounded → OOM → browser / system stall. */
const VIDEO_QUEUE_HIGH_WATER = 10;
const AUDIO_QUEUE_HIGH_WATER = 50;

/** Codec candidate. Probed in order; first one whose video + audio
 * encoder both report `supported` wins. */
interface CodecCandidate {
  container: 'mp4' | 'webm';
  videoCodec: string;
  /** Codec string the chosen muxer expects (mp4-muxer uses short names
   * like 'avc'; webm-muxer uses Matroska track ids like 'V_VP9'). */
  muxerVideoCodec: string;
  audioCodec: string;
  muxerAudioCodec: string;
  mime: string;
  ext: 'mp4' | 'webm';
}

/** mp4 + h264 first (best share-target compatibility), then webm + vp9
 * + opus (Quest browser doesn't ship h264 encode in WebCodecs because
 * of licensing — vp9 is the standard fallback for Android-class
 * Chromium builds), then vp8 as the last-ditch fallback. */
const CODEC_CANDIDATES: readonly CodecCandidate[] = [
  {
    container: 'mp4',
    videoCodec: 'avc1.42E01E', muxerVideoCodec: 'avc',
    audioCodec: 'mp4a.40.2', muxerAudioCodec: 'aac',
    mime: 'video/mp4', ext: 'mp4',
  },
  {
    container: 'webm',
    videoCodec: 'vp09.00.10.08', muxerVideoCodec: 'V_VP9',
    audioCodec: 'opus', muxerAudioCodec: 'A_OPUS',
    mime: 'video/webm', ext: 'webm',
  },
  {
    container: 'webm',
    videoCodec: 'vp8', muxerVideoCodec: 'V_VP8',
    audioCodec: 'opus', muxerAudioCodec: 'A_OPUS',
    mime: 'video/webm', ext: 'webm',
  },
];

/** Minimal muxer surface both libraries satisfy structurally — the
 * encoder output callbacks dispatch into one of these regardless of
 * which container we picked. */
interface MuxerLike {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void;
  finalize(): void;
}

export interface RenderFs {
  backend: {
    readFile: (path: string) => Promise<ArrayBuffer>;
    readText?: (path: string) => Promise<string>;
  };
  folder: string;
}

export type RenderPhase = 'preload' | 'recording' | 'finalize';

export interface RenderProgress {
  phase: RenderPhase;
  /** preload → samples loaded so far; recording → current songTimeMs;
   * finalize → ignored (set to 0). */
  current: number;
  /** preload → total samples; recording → durationMs; finalize → 0. */
  total: number;
}

export interface RenderOpts {
  fs: RenderFs;
  /** Preloaded skin textures from the live game's `loadSkin`. Optional
   * — render works without them, just less pretty. */
  skin?: SkinTextures;
  /** Granular phase + numeric progress. Throttled for the recording
   * phase so the host's repaint stays cheap. */
  onProgress?: (p: RenderProgress) => void;
  /** Free-form one-liner per milestone. Host wires into a UI log. */
  onLog?: (line: string) => void;
}

export interface RenderResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  /** MIME the encoder used. Caller may pin this on the download
   * link's type attribute. */
  mime: string;
}

/** Probe + build the entire MP4 in memory. Resolves with a Blob the
 * caller hands to a download anchor. */
export async function renderReplayToBlob(
  replay: Replay,
  chartText: string,
  opts: RenderOpts,
): Promise<RenderResult> {
  // 1. Codec probe. Try each candidate in order; first one whose
  //    video + audio encoders both report `supported` wins. Quest
  //    browser typically falls through h264 (no encode license) to
  //    webm + vp9 + opus.
  const codec = await pickSupportedCodec(opts.onLog);
  if (!codec) {
    throw new Error(
      'No supported video/audio codec — needs WebCodecs (Chromium 94+) ' +
      'with at least vp8 + opus encode. Quest browser updates usually ship this.',
    );
  }
  opts.onLog?.(`Codec: ${codec.videoCodec} + ${codec.audioCodec} → ${codec.ext}`);

  // 2. Parse + time-tag the chart. Same pipeline Game.loadAndStart
  //    uses, so chip positions match what the live run produced.
  const song = computeTiming(parseDtx(chartText));
  const totalSec = (song.durationMs + RENDER_TAIL_MS) / 1000;

  // 3. Audio offline. OfflineAudioContext renders the entire mix to
  //    one AudioBuffer in a single deterministic pass — no scheduler
  //    races, no double-tracks. (The realtime MediaRecorder path had
  //    multiple subtle timing bugs before we moved to this.)
  opts.onLog?.('Rendering audio (offline)…');
  const audioBuffer = await renderReplayAudioOffline(replay, song, opts.fs, {
    durationSec: totalSec,
    sampleRate: AUDIO_SAMPLE_RATE,
    onPreloadProgress: (loaded, total) => {
      opts.onProgress?.({ phase: 'preload', current: loaded, total });
    },
  });
  opts.onLog?.(`Audio rendered: ${audioBuffer.duration.toFixed(1)} s.`);

  // 4. Visual setup. Offscreen canvas in body so the GL context stays
  //    alive even when the tab loses focus; isolated Renderer +
  //    XrControllers per the sidecar invariant.
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  canvas.style.position = 'fixed';
  canvas.style.left = '-9999px';
  canvas.style.top = '0';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);

  const renderer = new Renderer(canvas, opts.skin ?? {});
  const xr = new XrControllers(renderer.webgl, renderer.scene);
  if (opts.skin?.pads) xr.setPadsTexture(opts.skin.pads);
  xr.start();
  const leftGrip = renderer.webgl.xr.getControllerGrip(0);
  const rightGrip = renderer.webgl.xr.getControllerGrip(1);

  // Match Renderer.enterXR's playfield framing so chips read the
  // correct size relative to the kit.
  const xrScale = 2.4 / 1280;
  renderer.playfield.scale.setScalar(xrScale);
  renderer.playfield.position.set(0, 1.6, -2.0);

  // Broadcast camera. FOV 95° + position above-and-behind so the
  // outer kit pads + the playfield panel both fit. Auto-cinematography
  // with cuts is a follow-up slice.
  const camera = new THREE.PerspectiveCamera(95, VIDEO_WIDTH / VIDEO_HEIGHT, 0.05, 20);
  camera.position.set(0, 2.2, 0.8);
  camera.lookAt(0, 1.0, -1.0);

  // Renderer.constructor calls webgl.setAnimationLoop with its own
  // tick. We're driving manually frame-by-frame; null it out so the
  // browser's rAF doesn't double-render between our explicit calls.
  renderer.webgl.setAnimationLoop(null);

  try {
    // 5. Muxer + encoders. Build the right container for the chosen
    //    codec; the two muxer libraries have the same chunk-adding
    //    surface so the encoder output callbacks dispatch identically.
    const { muxer, getBuffer } = buildMuxer(codec);
    let encoderError: Error | null = null;
    const trapError = (e: unknown): void => {
      encoderError = e instanceof Error ? e : new Error(String(e));
      console.error('[render] encoder error', e);
    };
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: trapError,
    });
    videoEncoder.configure({
      codec: codec.videoCodec,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      framerate: VIDEO_FPS,
      bitrate: VIDEO_BITRATE,
    });
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: trapError,
    });
    audioEncoder.configure({
      codec: codec.audioCodec,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: AUDIO_BITRATE,
    });

    // 6. Encode audio. The whole mix is already in `audioBuffer`;
    //    feed it as planar chunks to AudioEncoder.
    opts.onLog?.('Encoding audio…');
    await encodeAudioBuffer(audioBuffer, audioEncoder);

    // 7. Frame-by-frame video. No wall-clock dependence — encode runs
    //    as fast as the GPU + encoder can keep up. Per-frame yield
    //    every 30 frames keeps the host UI responsive (and lets the
    //    encoder drain).
    opts.onLog?.('Rendering video frames…');
    const totalFrames = Math.ceil(totalSec * VIDEO_FPS);
    const tracker = new ScoreTracker(
      song.chips.filter((c) => LANE_CHANNELS.has(c.channel)).length,
    );
    let nextHitIdx = 0;
    const lastPadHitMs = new Map<LaneValue, number>();
    let lastEmitFrame = -1000;

    for (let f = 0; f < totalFrames; f++) {
      if (encoderError) throw encoderError;
      const songTime = (f / VIDEO_FPS) * 1000;

      // Catch up the tracker for any hit at or before the current
      // frame. Mirrors the realtime path's per-tick incremental loop.
      while (nextHitIdx < replay.hits.length) {
        const h = replay.hits[nextHitIdx]!;
        if (h.songTimeMs > songTime) break;
        if (h.chipIndex !== -1) {
          if (h.source === 'auto' && h.judgment !== 'MISS') tracker.recordAuto();
          else tracker.record(h.judgment);
        }
        if (h.chipIndex === -1 || h.lagMs !== null || h.judgment !== 'MISS') {
          lastPadHitMs.set(h.lane, performance.now());
        }
        nextHitIdx++;
      }

      const finished = songTime >= song.durationMs;
      const snap = tracker.snapshot();
      const rate = finished ? computeAchievementRate(snap) : 0;
      const rank = finished ? computeRank(rate, snap.totalNotes) : 'E';
      const judgmentFlash = replayActiveJudgmentFlash(replay, songTime);
      const hitFlashes = replayActiveHitFlashes(replay, songTime);
      const state: RenderState = {
        songTimeMs: songTime,
        chips: song.chips,
        combo: snap.combo,
        score: snap.score,
        maxCombo: snap.maxCombo,
        judgmentFlash: judgmentFlash
          ? {
              text: judgmentFlash.judgment,
              judgment: judgmentFlash.judgment,
              color: '#fff',
              lane: judgmentFlash.lane,
              spawnedMs: judgmentFlash.spawnedMs,
              ...(judgmentFlash.deltaMs !== null
                ? { deltaMs: judgmentFlash.deltaMs }
                : {}),
            }
          : null,
        hitFlashes,
        status: finished ? 'finished' : 'playing',
        titleLine: `${song.title} / BPM ${song.baseBpm} / Notes ${snap.totalNotes}`,
        songLengthMs: song.durationMs,
        gauge: 0.5,
        lastPadHitMs,
        counts: snap.counts,
        totalNotes: snap.totalNotes,
        achievementRate: rate,
        rank,
        fullCombo: isFullCombo(snap),
        excellent: isExcellent(snap),
        finishedAtMs: finished ? performance.now() : null,
        inXR: false,
        toast: null,
      };
      renderer.render(state);

      const interp = lerpPoseSample(replay.poses, songTime);
      if (interp) {
        if (interp.left) applyPose(leftGrip, interp.left);
        if (interp.right) applyPose(rightGrip, interp.right);
      }

      renderer.webgl.render(renderer.scene, camera);

      // VideoFrame from the canvas captures the current backing-store
      // contents. webgl.render() above committed, and we're still in
      // the same JS task, so the buffer is fresh. timestamp in µs.
      const ts = Math.round((f / VIDEO_FPS) * 1_000_000);
      const frame = new VideoFrame(canvas, { timestamp: ts });
      // Keyframe every second so seeks are tolerant.
      videoEncoder.encode(frame, { keyFrame: f % VIDEO_FPS === 0 });
      frame.close();

      // Backpressure: pause feeding when the encoder is more than
      // VIDEO_QUEUE_HIGH_WATER frames behind. Without this the loop
      // generates VideoFrames + queued chunks faster than the encoder
      // drains, peak memory blows past Quest's RAM ceiling, and the
      // browser tab freezes (taking 6dof tracking with it for the
      // duration). Queue sizes ≤ 10 frames is roughly 50 MB peak.
      if (videoEncoder.encodeQueueSize >= VIDEO_QUEUE_HIGH_WATER) {
        // eslint-disable-next-line no-await-in-loop
        await waitForQueueDrain(videoEncoder, VIDEO_QUEUE_HIGH_WATER / 2);
      }

      if (f - lastEmitFrame >= 30) {
        lastEmitFrame = f;
        opts.onProgress?.({
          phase: 'recording',
          current: Math.max(0, songTime),
          total: song.durationMs,
        });
        // Always yield at the progress emit point so DOM repaints
        // (progress bar / log) happen even when the queue isn't full.
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    // 8. Flush both encoders, finalise the muxer, return the bytes.
    opts.onLog?.(`Finalising ${codec.ext.toUpperCase()}…`);
    opts.onProgress?.({ phase: 'finalize', current: 0, total: 0 });
    await videoEncoder.flush();
    await audioEncoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();

    const blob = new Blob([getBuffer()], { type: codec.mime });
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    opts.onLog?.(`Done — ${mb} MB ${codec.ext.toUpperCase()}.`);
    return { blob, ext: codec.ext, mime: codec.mime };
  } finally {
    try {
      xr.stop();
    } catch {
      /* not started or already stopped */
    }
    renderer.dispose();
    canvas.remove();
  }
}

/** Walk `CODEC_CANDIDATES` and return the first whose video + audio
 * encoder both report `supported`. Returns null when nothing matches.
 * Logs each rejection so the user can see the fallback chain. */
async function pickSupportedCodec(
  onLog?: (line: string) => void,
): Promise<CodecCandidate | null> {
  for (const c of CODEC_CANDIDATES) {
    let v: VideoEncoderSupport;
    let a: AudioEncoderSupport;
    try {
      v = await VideoEncoder.isConfigSupported({
        codec: c.videoCodec,
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        framerate: VIDEO_FPS,
        bitrate: VIDEO_BITRATE,
      });
      a = await AudioEncoder.isConfigSupported({
        codec: c.audioCodec,
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: 2,
        bitrate: AUDIO_BITRATE,
      });
    } catch (e) {
      // Some browsers throw on unknown codec strings instead of
      // returning {supported:false}; treat as unsupported.
      onLog?.(`Codec ${c.videoCodec} probe threw — skipping.`);
      console.warn('[render] codec probe threw', c, e);
      continue;
    }
    if (v.supported && a.supported) return c;
    if (!v.supported) onLog?.(`Codec ${c.videoCodec} unsupported — falling back.`);
    if (v.supported && !a.supported) {
      onLog?.(`Codec ${c.audioCodec} unsupported — falling back.`);
    }
  }
  return null;
}

/** Build the right muxer + a getter that exposes the final byte
 * buffer once `finalize()` has been called. Both libraries return
 * an `ArrayBufferTarget` whose `.buffer` field holds the bytes. */
function buildMuxer(codec: CodecCandidate): {
  muxer: MuxerLike;
  getBuffer: () => ArrayBuffer;
} {
  if (codec.container === 'mp4') {
    const target = new Mp4Target();
    const muxer = new Mp4Muxer({
      target,
      video: {
        codec: codec.muxerVideoCodec as 'avc',
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
      },
      audio: {
        codec: codec.muxerAudioCodec as 'aac',
        numberOfChannels: 2,
        sampleRate: AUDIO_SAMPLE_RATE,
      },
      // moov box at the head — file plays back without re-muxing.
      fastStart: 'in-memory',
    });
    return { muxer, getBuffer: () => target.buffer };
  }
  const target = new WebMTarget();
  const muxer = new WebMMuxer({
    target,
    video: {
      codec: codec.muxerVideoCodec, // 'V_VP9' / 'V_VP8'
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      frameRate: VIDEO_FPS,
    },
    audio: {
      codec: codec.muxerAudioCodec, // 'A_OPUS'
      numberOfChannels: 2,
      sampleRate: AUDIO_SAMPLE_RATE,
    },
  });
  return { muxer, getBuffer: () => target.buffer };
}

/** Slice a rendered AudioBuffer into planar chunks and push them
 * through AudioEncoder. Yields whenever the encoder queue rises
 * above the high-water mark — without backpressure the loop fires
 * thousands of `encode()` calls synchronously and the queue grows
 * faster than the encoder drains, which on Quest browser hits OOM
 * → browser tab freezes → system 6dof temporarily lost. */
async function encodeAudioBuffer(
  buffer: AudioBuffer,
  encoder: AudioEncoder,
): Promise<void> {
  const numChannels = buffer.numberOfChannels;
  // Planar f32 = ch0[len] then ch1[len]. AudioEncoder reads
  // contiguous channel runs.
  const ch0 = buffer.getChannelData(0);
  const ch1 = numChannels > 1 ? buffer.getChannelData(1) : ch0;
  for (let off = 0; off < buffer.length; off += AUDIO_FRAMES_PER_CHUNK) {
    const len = Math.min(AUDIO_FRAMES_PER_CHUNK, buffer.length - off);
    const data = new Float32Array(len * 2);
    data.set(ch0.subarray(off, off + len), 0);
    data.set(ch1.subarray(off, off + len), len);
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: 2,
      numberOfFrames: len,
      timestamp: Math.round((off / AUDIO_SAMPLE_RATE) * 1_000_000),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
    if (encoder.encodeQueueSize >= AUDIO_QUEUE_HIGH_WATER) {
      // eslint-disable-next-line no-await-in-loop
      await waitForQueueDrain(encoder, AUDIO_QUEUE_HIGH_WATER / 2);
    }
  }
}

/** Block until the encoder has drained below `target` queued items.
 * WebCodecs encoders don't expose a drain promise; poll instead. */
async function waitForQueueDrain(
  encoder: VideoEncoder | AudioEncoder,
  target: number,
): Promise<void> {
  while (encoder.encodeQueueSize > target) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/** Copy an `XrPose` into a Three.js Object3D (camera, grip, etc).
 * pos + quat are world-space; the caller is responsible for parenting. */
function applyPose(obj: THREE.Object3D, pose: XrPose): void {
  obj.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  obj.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
}

/** Trigger a browser download of the rendered blob. Caller composes
 * the filename (chart title etc.); we just wire the anchor click. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click handler has had a chance to start the
  // download — not all browsers handle revoke-then-click correctly.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Suggest a filename for a downloaded replay video. Sanitised so
 * weird chart titles don't break filesystems. */
export function suggestFilename(replay: Replay, ext: 'mp4' | 'webm'): string {
  const base = (replay.meta.title ?? 'replay')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'replay';
  // YYYYMMDD-HHmm from ISO 8601 startedAt.
  const stamp = replay.startedAt.replace(/[-:T]/g, '').slice(0, 13);
  return `${base}-${stamp}.${ext}`;
}
