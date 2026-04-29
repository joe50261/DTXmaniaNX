/**
 * Replay → video file render path.
 *
 * Spins up an isolated `Renderer` + `AudioEngine` (per the design
 * decision: render must not touch the live Game instance), pre-schedules
 * BGM + per-hit chip samples, and drives a real-time play loop while
 * MediaRecorder captures the canvas + audio destination into a blob.
 *
 * Out of scope for v0:
 *  - Ghost hands / grips (pose stream is captured but the v0 render
 *    paints HUD + scrolling chips only — adds the 3D drum kit + sticks
 *    later if visuals demand them).
 *  - Stray-hit audio (sample fallback via `lastBufferByLane`). Strays
 *    are still painted as flashes; just no sound. Most chart playthroughs
 *    have very few strays.
 *  - Render speed-up. Output is realtime; a 3-minute chart takes ~3
 *    minutes to render. Faster-than-realtime needs a different audio
 *    path (offline AudioContext) and isn't worth the complexity yet.
 *
 * Audio routing: a `MediaStreamDestination` is created on the engine's
 * AudioContext and the engine's `bgmGain` + `drumsGain` are connected
 * to it IN ADDITION TO `ctx.destination`. This means the user can
 * monitor while it renders if they want; speakers are non-destructive
 * to the recording. (The render runs on desktop only, so a separate
 * "render quietly" toggle would be nice-to-have but not load-bearing.)
 *
 * Duplication debt: `preloadSamples` + BGM scheduling mirror `Game`'s
 * private versions. A shared helper would be cleaner; deferred until
 * more than two consumers exist (e.g., a future "play replay live in
 * VR" mode).
 */

import * as THREE from 'three';
import {
  computeAchievementRate,
  computeRank,
  isExcellent,
  isFullCombo,
  joinPath,
  parseDtx,
  computeTiming,
  ScoreTracker,
  type Song,
} from '@dtxmania/dtx-core';
import { AudioEngine, SampleBank } from '@dtxmania/audio-engine';
import { type LaneValue } from '@dtxmania/input';
import { Renderer, type RenderState, type SkinTextures } from '../renderer.js';
import { laneSpec, channelToLane } from '../lane-layout.js';
import { XrControllers } from '../xr-controllers.js';
import {
  lerpPoseSample,
  replayActiveHitFlashes,
  replayActiveJudgmentFlash,
} from './viewer-model.js';
import { pickCodec, type CodecPick } from './render-codec-model.js';
import type { Pose, Replay } from './recorder-model.js';

const BGM_CHANNEL = 0x01;
const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

/** Tail beyond the chart's `durationMs` we keep recording for, so the
 * last judgment flash + score animation completes before the recorder
 * stops. Mirrors Game's finished-state dwell loosely. */
const RENDER_TAIL_MS = 1500;

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
  /** Granular phase + numeric progress. Throttled to ~4 Hz during
   * the recording phase so the host's repaint stays cheap. */
  onProgress?: (p: RenderProgress) => void;
  /** Free-form one-liner per milestone — phase change, sample loaded,
   * blob size, etc. Host wires into a UI log stream. */
  onLog?: (line: string) => void;
}

export interface RenderResult {
  blob: Blob;
  ext: 'mp4' | 'webm';
  /** MIME the recorder used. Caller may pin this on the download
   * link's type attribute. */
  mime: string;
}

/** Decode the chart text and run a full real-time render; resolves
 * once MediaRecorder finalises the blob. */
export async function renderReplayToBlob(
  replay: Replay,
  chartText: string,
  opts: RenderOpts,
): Promise<RenderResult> {
  // 1. Codec pick. Aborting early gives a clean error for ancient
  //    Chromiums; modern Quest / Chrome will hit MP4 or WebM.
  const codec = pickCodec((mime) => MediaRecorder.isTypeSupported(mime));
  if (!codec) {
    throw new Error(
      'No supported video codec — needs Chromium 80+ for WebM or 114+ for MP4.',
    );
  }

  // 2. Parse + time-tag the chart. Same pipeline Game.loadAndStart uses;
  //    deterministic so replay's chip-position math matches the live run.
  const song = computeTiming(parseDtx(chartText));

  // 3. Offscreen canvas for the WebGL render target. Sized to the
  //    Renderer's expected ortho viewport — Renderer has its own
  //    CANVAS_W / H constants that the .style sizing doesn't matter
  //    for; what matters is the backbuffer dimensions match.
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  // Hidden but in DOM — captureStream needs a real GL context, and a
  // non-DOM canvas can be paused by the browser when the tab loses
  // focus. Sticking the canvas off-screen at the body root keeps it
  // alive without visual clutter.
  canvas.style.position = 'fixed';
  canvas.style.left = '-9999px';
  canvas.style.top = '0';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);

  const renderer = new Renderer(canvas, opts.skin ?? {});
  const engine = new AudioEngine();
  await engine.resume();

  // Build the same VR scene the live player saw — drum kit + grip
  // sticks driven later by the recorded pose stream. XrControllers
  // owns the kit + stick geometry; we construct one (no XR session)
  // and call start() to populate the scene, then drive the grips
  // manually each frame. Without an XR session three.js's
  // `getControllerGrip(i)` returns a plain Object3D that ignores
  // input-source pose updates, which is exactly what we want — we
  // set the transforms ourselves from `replay.poses`.
  const xr = new XrControllers(renderer.webgl, renderer.scene);
  if (opts.skin?.pads) xr.setPadsTexture(opts.skin.pads);
  xr.start();
  const leftGrip = renderer.webgl.xr.getControllerGrip(0);
  const rightGrip = renderer.webgl.xr.getControllerGrip(1);

  // Scale + position the playfield panel exactly the way Renderer.enterXR
  // does, so the chips read the same size relative to the kit as in live
  // VR. The captured frame uses the perspective camera below, not the
  // ortho camera Renderer's idle path uses.
  const xrScale = 2.4 / 1280;
  renderer.playfield.scale.setScalar(xrScale);
  renderer.playfield.position.set(0, 1.6, -2.0);

  // Perspective camera. FOV chosen close to Quest's stereo per-eye FOV
  // so the framing reads as "what the player saw"; near/far covers a
  // typical play space without z-fighting on the kit.
  const camera = new THREE.PerspectiveCamera(85, canvas.width / canvas.height, 0.05, 20);
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.0, -1.0);

  try {
    // 4. Preload samples. Mirrors Game.preloadSamples; would extract
    //    if a third consumer needed it.
    opts.onLog?.('Loading samples…');
    const sampleByWavId = await preloadSamples(song, engine, opts.fs, {
      onProgress: (loaded, total) => {
        opts.onProgress?.({ phase: 'preload', current: loaded, total });
      },
    });
    opts.onLog?.(`Loaded ${sampleByWavId.size} samples.`);

    // 5. Audio routing for capture. Tap both gain nodes; ctx.destination
    //    keeps speakers live so the user can monitor.
    const audioDest = engine.ctx.createMediaStreamDestination();
    engine.bgmGain.connect(audioDest);
    engine.drumsGain.connect(audioDest);

    // 6. Build the combined MediaStream. Browsers want video tracks and
    //    audio tracks in one stream for MediaRecorder.
    const videoStream = canvas.captureStream(60);
    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDest.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, { mimeType: codec.mime });
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve());
    });

    // 7. Anchor the song clock BEFORE pre-scheduling. AudioEngine's
    //    `_songStartCtxTime` defaults to 0, so any scheduleBuffer call
    //    made before `startSongClock` computes its target wall-time
    //    against an epoch in the deep past — every source ends up
    //    playing with `offset = ctx.currentTime` (~15 s into preload),
    //    which both desyncs the audio AND, combined with a buggy
    //    chipIndex lookup, can spawn a second BGM source (= the
    //    "兩道時間錯開重疊" the user reported).
    opts.onLog?.(`Recording (${codec.ext.toUpperCase()})…`);
    recorder.start(/* timeslice — let the browser pick */);
    engine.startSongClock(0);

    // 8. Pre-schedule everything. AudioContext can hold thousands of
    //    queued sources without breaking a sweat, and pre-scheduling
    //    means the render's animation loop only has to paint, not also
    //    fire audio per-frame.
    scheduleBgm(song, engine, sampleByWavId);
    scheduleHits(replay, song, engine, sampleByWavId);

    const tracker = new ScoreTracker(
      song.chips.filter((c) => LANE_CHANNELS.has(c.channel)).length,
    );
    // Track tracker progress incrementally — replay one hit per pass
    // through the loop so the snapshot we paint matches the cutoff.
    let nextHitIdx = 0;
    const lastPadHitMs = new Map<LaneValue, number>();
    // Throttle the per-tick progress emit — animation loop runs at
    // ~60 Hz and the host doesn't need that much UI repaint.
    let lastProgressEmitMs = 0;
    const PROGRESS_EMIT_INTERVAL_MS = 250;

    // Override Renderer's animation loop so the captured frame uses
    // OUR perspective camera (with kit + sticks visible) instead of
    // Renderer's ortho. Renderer.render(state) is still called for
    // the HUD canvas paint; we just take over the GL render call so
    // the perspective view is what the captureStream samples.
    renderer.webgl.setAnimationLoop(() => {
      const songTime = engine.songTimeMs();
      // Catch up the tracker for any hit whose songTime <= now.
      while (nextHitIdx < replay.hits.length) {
        const h = replay.hits[nextHitIdx]!;
        if (h.songTimeMs > songTime) break;
        if (h.chipIndex !== -1) {
          if (h.source === 'auto' && h.judgment !== 'MISS') tracker.recordAuto();
          else tracker.record(h.judgment);
        }
        if (h.chipIndex === -1 || h.lagMs !== null || h.judgment !== 'MISS') {
          // pad strike — update bounce timer (auto-detected misses don't strike).
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
      // Paint the HUD canvas (chips, judgment text, score) — Renderer
      // updates the texture but does NOT do a GL draw; the WebGL render
      // happens below with our perspective camera so the kit + sticks
      // are visible alongside the playfield panel.
      renderer.render(state);

      // Pose-driven scene: head pose → camera, controller poses →
      // grip transforms (sticks ride along as children). lerpPoseSample
      // returns null outside the recorded window — fall back to the
      // initial fixed cam / grip pose so the scene stays sane.
      const interp = lerpPoseSample(replay.poses, songTime);
      if (interp) {
        if (interp.head) applyPose(camera, interp.head);
        if (interp.left) applyPose(leftGrip, interp.left);
        if (interp.right) applyPose(rightGrip, interp.right);
      }

      renderer.webgl.render(renderer.scene, camera);

      const now = performance.now();
      if (now - lastProgressEmitMs >= PROGRESS_EMIT_INTERVAL_MS) {
        lastProgressEmitMs = now;
        opts.onProgress?.({
          phase: 'recording',
          current: Math.max(0, songTime),
          total: song.durationMs,
        });
      }
    });

    // 9. Wait for the song + tail to elapse, then stop. Polling beats
    //    a `setTimeout(durationMs + tail)` because audio context
    //    schedules to wall time; if the user's machine throttles, the
    //    poll naturally waits.
    await waitForSongTime(engine, song.durationMs + RENDER_TAIL_MS);
    opts.onLog?.('Finalizing video…');
    opts.onProgress?.({ phase: 'finalize', current: 0, total: 0 });
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: codec.mime });
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    opts.onLog?.(`Done — ${mb} MB ${codec.ext.toUpperCase()}.`);
    return {
      blob,
      ext: codec.ext,
      mime: codec.mime,
    };
  } finally {
    // Stop the loop before tearing down anything it might still touch.
    try {
      renderer.webgl.setAnimationLoop(null);
    } catch {
      /* already disposed */
    }
    // Tear down the engine first so any lingering BGM doesn't keep
    // the AudioContext alive beyond this scope.
    try {
      await engine.ctx.close();
    } catch {
      /* already closed */
    }
    try {
      xr.stop();
    } catch {
      /* not started or already stopped */
    }
    renderer.dispose();
    canvas.remove();
  }
}

/** Copy a `Pose` into a Three.js Object3D (camera, grip, etc). pos
 * + quat are world-space; the caller is responsible for parenting. */
function applyPose(obj: THREE.Object3D, pose: Pose): void {
  obj.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  obj.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
}

async function preloadSamples(
  song: Song,
  engine: AudioEngine,
  fs: RenderFs,
  hooks: { onProgress?: (loaded: number, total: number) => void } = {},
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
    hooks.onProgress?.(0, 0);
    return new Map();
  }
  const bank = new SampleBank(engine.ctx, (rel) =>
    fs.backend.readFile(joinPath(fs.folder, rel)),
  );
  const out = new Map<number, AudioBuffer>();
  let loaded = 0;
  hooks.onProgress?.(0, total);
  await Promise.all(
    Array.from(ids).map(async (id) => {
      const def = song.wavTable.get(id);
      try {
        if (def?.path) {
          const buf = await bank.load(def.path);
          if (buf) out.set(id, buf);
        }
      } catch (e) {
        // Missing samples shouldn't kill the whole render — chart can
        // still play the chips that resolved.
        console.warn('[render] sample load failed', def?.path, e);
      } finally {
        loaded++;
        hooks.onProgress?.(loaded, total);
      }
    }),
  );
  return out;
}

function scheduleBgm(
  song: Song,
  engine: AudioEngine,
  samples: Map<number, AudioBuffer>,
): void {
  for (const chip of song.chips) {
    if (chip.channel !== BGM_CHANNEL) continue;
    if (chip.wavId === undefined) continue;
    const buffer = samples.get(chip.wavId);
    if (!buffer) continue;
    const def = song.wavTable.get(chip.wavId);
    engine.scheduleBuffer(buffer, chip.playbackTimeMs, {
      volume: def ? def.volume / 100 : 1,
      pan: def ? def.pan / 100 : 0,
      kind: 'bgm',
    });
  }
}

/** Walk replay.hits and pre-schedule each one's chip sample at the
 * recorded songTime. Misses (lagMs===null AND chipIndex !== -1) are
 * silent; strays are silent in v0 (no lastBufferByLane fallback yet).
 *
 * IMPORTANT: `HitEvent.chipIndex` is an index into Game's `playables`
 * (which is `song.chips.filter(LANE_CHANNELS)`), NOT into `song.chips`
 * itself. Looking up by `song.chips[idx]` would pull the wrong chip —
 * commonly a BGM chip (since BGM chips often sit between drum chips
 * in the unfiltered list), causing BGM to be scheduled a second time
 * at every hit's songTime. Build the same playables view here and
 * resolve the index against it. */
function scheduleHits(
  replay: Replay,
  song: Song,
  engine: AudioEngine,
  samples: Map<number, AudioBuffer>,
): void {
  const playables = song.chips.filter((c) => LANE_CHANNELS.has(c.channel));
  for (const h of replay.hits) {
    if (h.chipIndex === -1) continue; // stray — v0: silent
    if (h.lagMs === null && h.judgment === 'MISS') continue; // auto-detected miss
    const chip = playables[h.chipIndex];
    if (!chip) continue;
    if (chip.wavId === undefined) {
      // Synth fallback — match Game.playChipSample's fallback path.
      const lane = channelToLane(chip.channel);
      if (lane) engine.scheduleDrum(lane.voice, h.songTimeMs, 0.7);
      continue;
    }
    const buffer = samples.get(chip.wavId);
    if (!buffer) continue;
    const def = song.wavTable.get(chip.wavId);
    engine.scheduleBuffer(buffer, h.songTimeMs, {
      volume: def ? (def.volume / 100) * 0.7 : 0.7,
      pan: def ? def.pan / 100 : 0,
    });
  }
}

function waitForSongTime(engine: AudioEngine, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (engine.songTimeMs() >= ms) {
        resolve();
        return;
      }
      // 50 ms poll is fine — RENDER_TAIL_MS is generous enough that a
      // half-second of slop on stop time is invisible in the output.
      setTimeout(tick, 50);
    };
    tick();
  });
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
