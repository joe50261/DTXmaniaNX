/**
 * Replay → video file render path (WebCodecs).
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
 *   3. Mux: `mp4-muxer` or `webm-muxer` (per the probed codec)
 *      interleaves video + audio chunks; `ArrayBufferTarget`
 *      collects the bytes.
 *
 * Codec choice: probed at runtime from `CODEC_CANDIDATES` below.
 * `avc1.42E01E` (H.264 baseline) + `mp4a.40.2` (AAC LC) in MP4 when
 * the browser can encode H.264 (desktop Chromium) — best share-target
 * compatibility; otherwise VP9/VP8 + Opus in WebM. Quest browser
 * ships WebCodecs but not H.264 encode (licensing), so the primary
 * target device produces `.webm`. (`render-codec-model.ts` is the old
 * MediaRecorder-era picker and is not used by this path.)
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
import {
  Renderer,
  type RenderState,
  type SkinTextures,
  type JudgmentFlash,
} from '../renderer.js';
import { XrControllers, type XrPose } from '../xr-controllers.js';
import {
  lerpPoseSample,
  replayActiveHitFlashes,
  replayActiveJudgmentFlashes,
} from './viewer-model.js';
import { renderReplayAudioOffline } from './render-audio-offline.js';
import { clampToPoseRange, stampFinishedAtSongMs } from './render-timeline-model.js';
import { throwIfRenderAborted } from './render-job-model.js';
import { BROADCAST_CAMERA, PLAYFIELD_PANEL } from './broadcast-camera-model.js';
import type { Replay } from './recorder-model.js';

const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

/** Tail beyond `song.durationMs` we keep rendering for. The result
 * screen needs ≥ a few seconds for the rank / counts / FC banner to
 * actually be readable; 1.5 s lets the song flip to 'finished' but
 * cuts off before the player can see the score. 6 s is the
 * "natural" dwell we'd give a real-time playback. */
const RENDER_TAIL_MS = 6000;

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
  /** Cancels the render at the next resumption point (per frame /
   * per audio chunk / per preloaded sample). The promise rejects with
   * an `AbortError` DOMException; all GPU + encoder resources are
   * released on the way out. */
  signal?: AbortSignal;
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
  throwIfRenderAborted(opts.signal);

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
    ...(opts.signal ? { signal: opts.signal } : {}),
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

  // GL context-loss recovery. The render survives the page being
  // frozen (headset off → Quest sleeps → page thaws on wake), but the
  // freeze often takes the WebGL context with it. Without handling,
  // every frame after the loss encodes as garbage while the progress
  // bar keeps advancing — the render "finishes" broken. Instead:
  // pause the frame loop on `webglcontextlost`, resume from the SAME
  // frame on `webglcontextrestored` (three.js re-uploads its GPU
  // resources; every piece of timeline state is plain JS; frames
  // encoded before the pause are already safe inside the muxer).
  //
  // Listener order matters: these MUST be registered after the
  // Renderer above so THREE.WebGLRenderer's own contextrestored
  // handler (which clears its internal _isContextLost and re-inits GL
  // state) runs before ours resolves the pause — otherwise the loop
  // resumes while three still refuses to draw and encodes a run of
  // black frames. The frame loop additionally yields a macrotask
  // after the pause resolves, so this holds even if a refactor
  // reorders the registrations.
  let contextLost = false;
  let contextRestoredWaiters: Array<() => void> = [];
  const onContextLost = (e: Event): void => {
    e.preventDefault(); // required, or webglcontextrestored never fires
    contextLost = true;
    opts.onLog?.('GPU context lost (device slept mid-render?) — render paused…');
  };
  const onContextRestored = (): void => {
    contextLost = false;
    opts.onLog?.('GPU context restored — resuming from the same frame.');
    for (const w of contextRestoredWaiters.splice(0)) w();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  /** Resolves on restore OR abort; the caller re-checks both flags. */
  const contextPause = (): Promise<void> =>
    new Promise<void>((resolve) => {
      contextRestoredWaiters.push(resolve);
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });

  const xr = new XrControllers(renderer.webgl, renderer.scene);
  if (opts.skin?.pads) xr.setPadsTexture(opts.skin.pads);
  xr.start();
  const leftGrip = renderer.webgl.xr.getControllerGrip(0);
  const rightGrip = renderer.webgl.xr.getControllerGrip(1);
  // Three.js's WebXRManager creates grip Object3Ds with
  // `matrixAutoUpdate = false` and `visible = false`; both flip back
  // on only when an XR session emits the `connected` input-source
  // event. Without an active session those defaults stay set —
  // applying position / quaternion does nothing because the matrix
  // is never recomputed, and the grip is invisible anyway. Force
  // both back on so manual pose driving + visibility work.
  for (const g of [leftGrip, rightGrip]) {
    g.matrixAutoUpdate = true;
    g.visible = true;
  }

  // Head proxy. The replay records HMD pose but the live game has
  // no head mesh (the player IS the camera in VR). For the broadcast
  // render we want to see WHERE the player was looking, so a simple
  // sphere + forward-pointing cone marks the head + facing.
  const headMesh = buildHeadProxy();
  renderer.scene.add(headMesh);

  // Match Renderer.enterXR's playfield framing so chips read the
  // correct size relative to the kit. Panel centre comes from the camera
  // model so its framing target and the placement here can't drift.
  const xrScale = PLAYFIELD_PANEL.width / 1280;
  renderer.playfield.scale.setScalar(xrScale);
  renderer.playfield.position.set(...PLAYFIELD_PANEL.center);

  // Broadcast camera — a fixed above-and-behind angle. `fov` is the VERTICAL
  // field of view; 70° (down from an earlier 95°) fills the frame with the
  // kit + highway instead of leaving fat black bars top and bottom. See
  // broadcast-camera-model.ts for the framing rationale; the test there pins
  // that the whole kit stays in-frame across every preset / seat offset.
  // Auto-cinematography with cuts is a follow-up slice.
  const camera = new THREE.PerspectiveCamera(
    BROADCAST_CAMERA.fovDeg,
    VIDEO_WIDTH / VIDEO_HEIGHT,
    BROADCAST_CAMERA.near,
    BROADCAST_CAMERA.far,
  );
  camera.position.set(...BROADCAST_CAMERA.position);
  camera.lookAt(...BROADCAST_CAMERA.lookAt);

  // Renderer.constructor calls webgl.setAnimationLoop with its own
  // tick. We're driving manually frame-by-frame; null it out so the
  // browser's rAF doesn't double-render between our explicit calls.
  renderer.webgl.setAnimationLoop(null);

  // Hoisted so the finally block can close them on every exit path —
  // an abort or error mid-encode must not leak codec resources (Quest
  // has little RAM to spare, and a leaked hardware encoder can block
  // the next render from configuring).
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;

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
    videoEncoder = new VideoEncoder({
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
    audioEncoder = new AudioEncoder({
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
    await encodeAudioBuffer(audioBuffer, audioEncoder, opts.signal);

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
    // Song-time of the playing→finished transition, stamped once (see
    // stampFinishedAtSongMs). The result overlay fades in off this; the
    // axis is songTime, not performance.now() — the render is faster than
    // real time so the wall clock can't drive the fade.
    let finishedAtSongMs: number | null = null;

    const gl = renderer.webgl.getContext();
    for (let f = 0; f < totalFrames; f++) {
      if (encoderError) throw encoderError;
      throwIfRenderAborted(opts.signal);
      // Hold here while the GL context is gone; continue from this
      // exact frame once it's back. Also wakes on abort. The
      // synchronous isContextLost() check matters: the loss EVENT is
      // delivered as a separate task, so right after a thaw the GPU
      // can already be gone while `contextLost` is still false — and
      // a VideoFrame built from a dead canvas would either throw or
      // encode garbage.
      while (contextLost || gl.isContextLost()) {
        if (contextLost) {
          await contextPause();
          // One full macrotask so every remaining contextrestored
          // listener (three.js's GL re-init among them) has run
          // before we start encoding again.
          await new Promise<void>((r) => setTimeout(r, 0));
        } else {
          // Loss event not delivered yet — yield so its task can run.
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        throwIfRenderAborted(opts.signal);
      }
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
          // Song-time strike instant, NOT performance.now(): the pad
          // bounce / flush age is computed against songTime so it fades at
          // the right rate in the faster-than-realtime render.
          lastPadHitMs.set(h.lane, h.songTimeMs);
        }
        nextHitIdx++;
      }

      const finished = songTime >= song.durationMs;
      finishedAtSongMs = stampFinishedAtSongMs(finishedAtSongMs, songTime, finished);
      const snap = tracker.snapshot();
      const rate = finished ? computeAchievementRate(snap) : 0;
      const rank = finished ? computeRank(rate, snap.totalNotes) : 'E';
      // Per-lane judgment flashes so a chord shows one pop per lane in the
      // rendered video, matching the live game's `judgmentFlashes` model.
      const judgmentFlashes = replayActiveJudgmentFlashes(replay, songTime).map(
        (f): JudgmentFlash => ({
          text: f.judgment,
          judgment: f.judgment,
          color: '#fff',
          lane: f.lane,
          spawnedMs: f.spawnedMs,
          ...(f.deltaMs !== null ? { deltaMs: f.deltaMs } : {}),
        }),
      );
      const hitFlashes = replayActiveHitFlashes(replay, songTime);
      const state: RenderState = {
        songTimeMs: songTime,
        chips: song.chips,
        combo: snap.combo,
        score: snap.score,
        maxCombo: snap.maxCombo,
        judgmentFlashes,
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
        finishedAtMs: finishedAtSongMs,
        animClockMs: songTime,
        inXR: false,
        toast: null,
      };
      renderer.render(state);

      // Clamp the pose query to the recorded range so the ghost hands /
      // head proxy hold their last sample through the result-screen tail
      // instead of vanishing (pose capture stops ~500ms after the chart
      // ends; the render tail runs 6s).
      const interp = lerpPoseSample(replay.poses, clampToPoseRange(songTime, replay.poses));
      if (interp) {
        if (interp.left) applyPose(leftGrip, interp.left);
        if (interp.right) applyPose(rightGrip, interp.right);
        if (interp.head) {
          applyPose(headMesh, interp.head);
          headMesh.visible = true;
        } else {
          headMesh.visible = false;
        }
      } else {
        headMesh.visible = false;
      }

      // Drum-pad reactions. Two independent kits animate:
      //  - the 2D HUD pads + flush overlay on the playfield panel
      //    (renderer.animatePads — NOT reached via renderFrame here since
      //    we drive webgl.render manually below), and
      //  - the 3D VR kit pads (xr.tick → animatePadBounce).
      // Both read their lastPadHitMs map; we feed songTime as the clock so
      // bounce/flush fade at the right rate (xr.tick early-returns after
      // the bounce since no hit listener is set). Without these the pads
      // sit still and the flush never flashes — the user reported
      // "缺少鼓組震動".
      renderer.submitPadHits(lastPadHitMs);
      renderer.animatePads(songTime);
      xr.submitPadHits(lastPadHitMs);
      xr.tick(songTime);

      renderer.webgl.render(renderer.scene, camera);

      // VideoFrame from the canvas captures the current backing-store
      // contents. webgl.render() above committed, and we're still in
      // the same JS task, so the buffer is fresh. timestamp in µs.
      const ts = Math.round((f / VIDEO_FPS) * 1_000_000);
      const frame = new VideoFrame(canvas, { timestamp: ts });
      try {
        // Keyframe every second so seeks are tolerant.
        videoEncoder.encode(frame, { keyFrame: f % VIDEO_FPS === 0 });
      } finally {
        // encode() clones the frame; close ours even when encode
        // throws (e.g. the encoder errored and closed itself) so the
        // GPU-backed frame doesn't linger until GC.
        frame.close();
      }

      // Backpressure: pause feeding when the encoder is more than
      // VIDEO_QUEUE_HIGH_WATER frames behind. Without this the loop
      // generates VideoFrames + queued chunks faster than the encoder
      // drains, peak memory blows past Quest's RAM ceiling, and the
      // browser tab freezes (taking 6dof tracking with it for the
      // duration). Queue sizes ≤ 10 frames is roughly 50 MB peak.
      if (videoEncoder.encodeQueueSize >= VIDEO_QUEUE_HIGH_WATER) {
        await waitForQueueDrain(videoEncoder, VIDEO_QUEUE_HIGH_WATER / 2, opts.signal);
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
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    // 8. Flush both encoders, finalise the muxer, return the bytes.
    throwIfRenderAborted(opts.signal);
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
    for (const enc of [videoEncoder, audioEncoder]) {
      try {
        if (enc && enc.state !== 'closed') enc.close();
      } catch {
        /* already closed */
      }
    }
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    contextRestoredWaiters = [];
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
  signal?: AbortSignal,
): Promise<void> {
  const numChannels = buffer.numberOfChannels;
  // Planar f32 = ch0[len] then ch1[len]. AudioEncoder reads
  // contiguous channel runs.
  const ch0 = buffer.getChannelData(0);
  const ch1 = numChannels > 1 ? buffer.getChannelData(1) : ch0;
  for (let off = 0; off < buffer.length; off += AUDIO_FRAMES_PER_CHUNK) {
    throwIfRenderAborted(signal);
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
      await waitForQueueDrain(encoder, AUDIO_QUEUE_HIGH_WATER / 2, signal);
    }
  }
}

/** Block until the encoder has drained below `target` queued items.
 * WebCodecs encoders don't expose a drain promise; poll instead.
 * Bails on abort so Cancel isn't held hostage by a stalled encoder. */
async function waitForQueueDrain(
  encoder: VideoEncoder | AudioEncoder,
  target: number,
  signal?: AbortSignal,
): Promise<void> {
  while (encoder.encodeQueueSize > target) {
    throwIfRenderAborted(signal);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/** Copy an `XrPose` into a Three.js Object3D (camera, grip, etc).
 * pos + quat are world-space; the caller is responsible for parenting. */
function applyPose(obj: THREE.Object3D, pose: XrPose): void {
  obj.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  obj.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
}

/** Tiny "where the player was looking" marker. Sphere for the head
 * volume + a forward-pointing cone (along the head's local -Z, which
 * is WebXR's looking direction) so the broadcast camera can show
 * facing at a glance. MeshBasicMaterial avoids needing scene lights. */
function buildHeadProxy(): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = true;
  group.visible = false;
  const skull = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xe2c79a }),
  );
  group.add(skull);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.04, 0.10, 12),
    new THREE.MeshBasicMaterial({ color: 0xc94c4c }),
  );
  // ConeGeometry points along +Y by default; rotate so the tip
  // sticks out of -Z (WebXR's look direction) of the head's frame.
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0, -0.10);
  group.add(nose);
  return group;
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
