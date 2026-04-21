import {
  parseDtx,
  computeTiming,
  ScoreTracker,
  classifyDeltaMs,
  Judgment,
  HIT_RANGES_MS,
  joinPath,
  type Chip,
  type FileSystemBackend,
  type Song,
} from '@dtxmania/dtx-core';
import { AudioEngine, SampleBank } from '@dtxmania/audio-engine';
import { KeyboardInput, type LaneHitEvent, type LaneValue } from '@dtxmania/input';
import {
  Renderer,
  CANVAS_W,
  CANVAS_H,
  type RenderState,
  type JudgmentFlash,
  type HitFlash,
  type SkinTextures,
} from './renderer.js';
import { channelToLane, LANE_LAYOUT, laneSpec } from './lane-layout.js';
import { XrControllers } from './xr-controllers.js';

const COUNTDOWN_MS = 2000;
const BGM_CHANNEL = 0x01;
const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

interface PlayableChip {
  chip: Chip;
  laneValue: LaneValue;
  hit: boolean;
  missed: boolean;
  /** Real WAV sample for this chip, if one was preloaded. null → use synth fallback. */
  buffer: AudioBuffer | null;
}

export interface GameFsContext {
  backend: FileSystemBackend;
  /** Folder containing the .dtx being played; BGM + drum sample paths resolve here. */
  folder: string;
  /** Optional progress callback for long preloads (e.g. 30+ WAV samples). */
  onProgress?: (loaded: number, total: number) => void;
}

export class Game {
  private readonly renderer: Renderer;
  private readonly engine: AudioEngine;
  private readonly input: KeyboardInput;

  private song: Song | null = null;
  private playables: PlayableChip[] = [];
  private sampleByWavId = new Map<number, AudioBuffer>();
  /**
   * Per-lane "current" real-sample buffer used by any keystroke (matched or
   * stray). Seeded at loadAndStart with the first chip on each lane that has
   * a preloaded buffer, so test-taps before the song even starts sound like
   * real drums. Updated as the player hits chips so a lane can change sample
   * mid-song (e.g. ghost notes on SD).
   */
  private lastBufferByLane = new Map<LaneValue, { buffer: AudioBuffer; wavId: number }>();
  private tracker = new ScoreTracker(0);
  private status: 'idle' | 'playing' | 'finished' = 'idle';
  private judgmentFlash: JudgmentFlash | null = null;
  private hitFlashes: HitFlash[] = [];
  /** Life / skill gauge, 0..1. Filled by hits, drained by misses. Starts at 0.5 so the player has headroom. */
  private gauge = 0.5;
  /** performance.now() of the most recent hit per lane; drives pad bounce + flush overlay. */
  private lastPadHitMs = new Map<LaneValue, number>();
  private onRestart: (() => void) | null = null;
  private bgmSources: AudioBufferSourceNode[] = [];
  private readonly xrControllers: XrControllers;

  constructor(private readonly canvas: HTMLCanvasElement, skin: SkinTextures = {}) {
    this.renderer = new Renderer(canvas, skin);
    this.engine = new AudioEngine();
    this.input = new KeyboardInput();
    this.input.attach();
    this.input.onLaneHit((e) => this.handleLaneHit(e));
    this.input.onMenu((e) => {
      if (e.action === 'cancel' && this.status === 'finished') {
        this.onRestart?.();
      }
    });
    this.xrControllers = new XrControllers(this.renderer.webgl, this.renderer.scene);
    this.xrControllers.setPadsTexture(skin.pads);
    this.xrControllers.onHit((e) => this.handleLaneHit(e));
  }

  /** Enter a WebXR immersive-vr session (Quest browser). Throws if unsupported. */
  async enterXR(onEnded: () => void): Promise<void> {
    await this.renderer.enterXR(() => {
      this.xrControllers.stop();
      onEnded();
    });
    this.xrControllers.start();
  }

  async loadAndStart(
    dtxText: string,
    opts: { onRestart?: () => void; fs?: GameFsContext } = {}
  ): Promise<void> {
    this.onRestart = opts.onRestart ?? null;
    this.stopBgm();
    this.sampleByWavId.clear();
    this.lastBufferByLane.clear();
    this.lastPadHitMs.clear();
    this.gauge = 0.5;
    await this.engine.resume();

    this.song = computeTiming(parseDtx(dtxText));

    // Preload every sample the chart references (BGM + drums) in one batch.
    // Missing or undecodable (e.g. .xa) samples are just absent from the map;
    // the drum scheduler falls through to the synth voice for those chips.
    if (opts.fs) {
      this.sampleByWavId = await this.preloadSamples(this.song, opts.fs);
    }

    this.playables = this.song.chips
      .filter((c) => LANE_CHANNELS.has(c.channel))
      .map<PlayableChip | null>((chip) => {
        const lane = channelToLane(chip.channel);
        if (!lane) return null;
        const buffer =
          chip.wavId !== undefined ? this.sampleByWavId.get(chip.wavId) ?? null : null;
        return {
          chip,
          laneValue: lane.lane,
          hit: false,
          missed: false,
          buffer,
        };
      })
      .filter((p): p is PlayableChip => p !== null);

    // Seed per-lane default sample from the first chip on each lane that has
    // a preloaded buffer. Playables are already sorted by playbackTimeMs.
    for (const p of this.playables) {
      if (!p.buffer || p.chip.wavId === undefined) continue;
      if (this.lastBufferByLane.has(p.laneValue)) continue;
      this.lastBufferByLane.set(p.laneValue, { buffer: p.buffer, wavId: p.chip.wavId });
    }

    this.tracker = new ScoreTracker(this.playables.length);

    this.status = 'playing';
    this.engine.startSongClock(COUNTDOWN_MS);

    this.scheduleBgm(this.song);

    this.renderer.onFrame(() => this.tick());
  }

  stop(): void {
    this.input.detach();
    this.stopBgm();
    this.renderer.dispose();
  }

  /** Expose the Three.js renderer so the caller can request an XR session. */
  get display(): Renderer {
    return this.renderer;
  }

  private stopBgm(): void {
    for (const src of this.bgmSources) {
      try {
        src.stop();
      } catch {
        /* already stopped / not yet started */
      }
    }
    this.bgmSources.length = 0;
  }

  /**
   * Preload every WAV/OGG/MP3 referenced by a BGM or drum chip. Samples the
   * browser can't decode (e.g. DTXMania's .xa files) are silently skipped and
   * the corresponding chip will fall through to the synth voice.
   */
  private async preloadSamples(
    song: Song,
    fs: GameFsContext
  ): Promise<Map<number, AudioBuffer>> {
    const uniqueWavIds = new Set<number>();
    for (const chip of song.chips) {
      if (chip.wavId === undefined) continue;
      if (chip.channel === BGM_CHANNEL || LANE_CHANNELS.has(chip.channel)) {
        uniqueWavIds.add(chip.wavId);
      }
    }
    if (uniqueWavIds.size === 0) return new Map();

    const bank = new SampleBank(this.engine.ctx, (rel) =>
      fs.backend.readFile(joinPath(fs.folder, rel))
    );

    const total = uniqueWavIds.size;
    let done = 0;
    fs.onProgress?.(0, total);

    const out = new Map<number, AudioBuffer>();
    await Promise.all(
      Array.from(uniqueWavIds).map(async (id) => {
        try {
          const def = song.wavTable.get(id);
          if (def && def.path) {
            const buf = await bank.load(def.path);
            if (buf) out.set(id, buf);
          }
        } finally {
          done++;
          fs.onProgress?.(done, total);
        }
      })
    );
    return out;
  }

  private scheduleBgm(song: Song): void {
    if (this.sampleByWavId.size === 0) return;
    for (const chip of song.chips) {
      if (chip.channel !== BGM_CHANNEL) continue;
      if (chip.wavId === undefined) continue;
      const buffer = this.sampleByWavId.get(chip.wavId);
      if (!buffer) continue;
      const def = song.wavTable.get(chip.wavId);
      const volume = def ? def.volume / 100 : 1;
      const pan = def ? def.pan / 100 : 0;
      const src = this.engine.scheduleBuffer(buffer, chip.playbackTimeMs, { volume, pan });
      this.bgmSources.push(src);
    }
  }

  private playChipSample(p: PlayableChip, songTimeMs: number, volume: number): void {
    if (p.buffer) {
      const def =
        p.chip.wavId !== undefined ? this.song?.wavTable.get(p.chip.wavId) : undefined;
      const v = def ? (def.volume / 100) * volume : volume;
      const pan = def ? def.pan / 100 : 0;
      this.engine.scheduleBuffer(p.buffer, songTimeMs, { volume: v, pan });
      if (p.chip.wavId !== undefined) {
        this.lastBufferByLane.set(p.laneValue, { buffer: p.buffer, wavId: p.chip.wavId });
      }
      return;
    }
    const spec = laneSpec(p.laneValue);
    if (spec) this.engine.scheduleDrum(spec.voice, songTimeMs, volume);
  }

  private tick(): void {
    this.xrControllers.tick();
    if (!this.song) return;
    const songTime = this.engine.songTimeMs();

    // Drum chips don't auto-play; audio only fires on the player's keystroke
    // (handleLaneHit). BGM is still auto-scheduled via scheduleBgm so the
    // music continues. Missed chips are silent — standard rhythm-game feel.

    // Miss detection: any unhit chip whose judgment window has fully passed.
    for (const p of this.playables) {
      if (p.hit || p.missed) continue;
      if (songTime - p.chip.playbackTimeMs > HIT_RANGES_MS.POOR) {
        p.missed = true;
        this.tracker.record(Judgment.MISS);
        this.applyGaugeDelta(Judgment.MISS);
        this.judgmentFlash = {
          text: 'MISS',
          judgment: Judgment.MISS,
          color: '#ef4444',
          lane: p.laneValue,
          spawnedMs: songTime,
        };
      }
    }

    // Game-over check: song finished + small tail for last miss detection.
    if (songTime > this.song.durationMs + 500 && this.status === 'playing') {
      this.status = 'finished';
    }

    this.hitFlashes = this.hitFlashes.filter((f) => songTime - f.spawnedMs < 400);

    const state: RenderState = {
      songTimeMs: songTime,
      chips: this.song.chips,
      combo: this.tracker.snapshot().combo,
      score: this.tracker.snapshot().score,
      maxCombo: this.tracker.snapshot().maxCombo,
      judgmentFlash: this.judgmentFlash,
      hitFlashes: this.hitFlashes,
      status: this.status,
      titleLine: `${this.song.title} / BPM ${this.song.baseBpm} / Notes ${this.playables.length}`,
      songLengthMs: this.song.durationMs,
      gauge: this.gauge,
      lastPadHitMs: this.lastPadHitMs,
    };
    this.renderer.render(state);
    this.renderer.submitPadHits(this.lastPadHitMs);
    this.xrControllers.submitPadHits(this.lastPadHitMs);
  }

  private handleLaneHit(event: LaneHitEvent): void {
    if (this.status !== 'playing' || !this.song) return;
    const songTime = this.engine.songTimeMs();

    // Find the nearest unhit chip in this lane (visual lane; so HH accepts HHO, BD accepts LBD).
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < this.playables.length; i++) {
      const p = this.playables[i]!;
      if (p.hit || p.missed) continue;
      if (p.laneValue !== event.lane) continue;
      const delta = songTime - p.chip.playbackTimeMs;
      if (Math.abs(delta) > HIT_RANGES_MS.POOR) continue;
      if (Math.abs(delta) < Math.abs(bestDelta)) {
        bestDelta = delta;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) {
      // Stray hit: play the most recent real sample that fired on this lane
      // so off-note keystrokes still sound like a drum, not a synth. Only
      // fall back to synth if the lane has never fired a real-sample chip
      // yet (e.g. first beats, or the whole lane is .xa-backed).
      this.playStrayHit(event.lane, songTime);
      this.hitFlashes.push({ lane: event.lane, spawnedMs: songTime });
      this.lastPadHitMs.set(event.lane, performance.now());
      return;
    }

    const p = this.playables[bestIdx]!;
    p.hit = true;
    const judgment = classifyDeltaMs(bestDelta);
    this.tracker.record(judgment);
    this.applyGaugeDelta(judgment);
    this.judgmentFlash = {
      text: judgment,
      judgment,
      color: judgmentColor(judgment),
      lane: event.lane,
      spawnedMs: songTime,
    };
    this.hitFlashes.push({ lane: event.lane, spawnedMs: songTime });
    this.lastPadHitMs.set(event.lane, performance.now());

    // Matched-chip hit: always play on keystroke so audio tracks the user's
    // press time, not just the auto-scheduled chip time. The chip-time
    // playback still happens (~30ms earlier at PERFECT), but overlapping
    // with the keystroke playback feels more responsive than silent feedback.
    this.playChipSample(p, songTime, 0.7);
  }

  private playStrayHit(lane: LaneValue, songTime: number): void {
    const last = this.lastBufferByLane.get(lane);
    if (last) {
      const def = this.song?.wavTable.get(last.wavId);
      const v = def ? (def.volume / 100) * 0.55 : 0.55;
      const pan = def ? def.pan / 100 : 0;
      this.engine.scheduleBuffer(last.buffer, songTime, { volume: v, pan });
      return;
    }
    const spec = LANE_LAYOUT.find((s) => s.lane === lane);
    if (spec) this.engine.drums.play(spec.voice, this.engine.ctx.currentTime, { volume: 0.55 });
  }

  /** Adjust the life gauge based on the latest judgment. Clamped to [0, 1]. */
  private applyGaugeDelta(judgment: ReturnType<typeof classifyDeltaMs>): void {
    const delta =
      judgment === Judgment.PERFECT ?  0.025 :
      judgment === Judgment.GREAT   ?  0.015 :
      judgment === Judgment.GOOD    ?  0.005 :
      judgment === Judgment.POOR    ? -0.020 :
      /* MISS */                      -0.050;
    this.gauge = Math.max(0, Math.min(1, this.gauge + delta));
  }
}

function judgmentColor(j: ReturnType<typeof classifyDeltaMs>): string {
  switch (j) {
    case Judgment.PERFECT: return '#fbbf24';
    case Judgment.GREAT: return '#34d399';
    case Judgment.GOOD: return '#60a5fa';
    case Judgment.POOR: return '#a78bfa';
    case Judgment.MISS: return '#ef4444';
  }
}

void CANVAS_W;
void CANVAS_H;
