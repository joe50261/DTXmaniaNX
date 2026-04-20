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
} from './renderer.js';
import { channelToLane, LANE_LAYOUT, laneSpec } from './lane-layout.js';

const COUNTDOWN_MS = 2000;
const BGM_CHANNEL = 0x01;
const LANE_CHANNELS = new Set<number>([
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

interface PlayableChip {
  chip: Chip;
  laneValue: LaneValue;
  scheduled: boolean;
  hit: boolean;
  missed: boolean;
}

export interface GameFsContext {
  backend: FileSystemBackend;
  /** Folder containing the .dtx being played; BGM WAV paths resolve here. */
  folder: string;
}

export class Game {
  private readonly renderer: Renderer;
  private readonly engine: AudioEngine;
  private readonly input: KeyboardInput;

  private song: Song | null = null;
  private playables: PlayableChip[] = [];
  private nextScheduleIdx = 0;
  private tracker = new ScoreTracker(0);
  private status: 'idle' | 'playing' | 'finished' = 'idle';
  private judgmentFlash: JudgmentFlash | null = null;
  private hitFlashes: HitFlash[] = [];
  private rafHandle = 0;
  private onRestart: (() => void) | null = null;
  private bgmSources: AudioBufferSourceNode[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.engine = new AudioEngine();
    this.input = new KeyboardInput();
    this.input.attach();
    this.input.onLaneHit((e) => this.handleLaneHit(e));
    this.input.onMenu((e) => {
      if (e.action === 'cancel' && this.status === 'finished') {
        this.onRestart?.();
      }
    });
  }

  async loadAndStart(
    dtxText: string,
    opts: { onRestart?: () => void; fs?: GameFsContext } = {}
  ): Promise<void> {
    this.onRestart = opts.onRestart ?? null;
    this.stopBgm();
    await this.engine.resume();

    this.song = computeTiming(parseDtx(dtxText));
    this.playables = this.song.chips
      .filter((c) => LANE_CHANNELS.has(c.channel))
      .map<PlayableChip | null>((chip) => {
        const lane = channelToLane(chip.channel);
        if (!lane) return null;
        return { chip, laneValue: lane.lane, scheduled: false, hit: false, missed: false };
      })
      .filter((p): p is PlayableChip => p !== null);

    this.tracker = new ScoreTracker(this.playables.length);
    this.nextScheduleIdx = 0;

    // Preload BGM buffers before starting the song clock so the countdown
    // covers decoding latency on slower devices (Quest browser takes ~200ms
    // to decode a 5MB OGG). Missing or undecodable samples are just skipped;
    // the chart still plays without BGM.
    const bgmBuffers = opts.fs
      ? await this.preloadBgmBuffers(this.song, opts.fs)
      : new Map<number, AudioBuffer>();

    this.status = 'playing';
    this.engine.startSongClock(COUNTDOWN_MS);

    this.scheduleBgm(this.song, bgmBuffers);

    cancelAnimationFrame(this.rafHandle);
    const frame = () => {
      this.tick();
      this.rafHandle = requestAnimationFrame(frame);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.rafHandle);
    this.input.detach();
    this.stopBgm();
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

  private async preloadBgmBuffers(
    song: Song,
    fs: GameFsContext
  ): Promise<Map<number, AudioBuffer>> {
    const uniqueWavIds = new Set<number>();
    for (const chip of song.chips) {
      if (chip.channel === BGM_CHANNEL && chip.wavId !== undefined) {
        uniqueWavIds.add(chip.wavId);
      }
    }
    if (uniqueWavIds.size === 0) return new Map();

    const bank = new SampleBank(this.engine.ctx, (rel) =>
      fs.backend.readFile(joinPath(fs.folder, rel))
    );

    const out = new Map<number, AudioBuffer>();
    await Promise.all(
      Array.from(uniqueWavIds).map(async (id) => {
        const def = song.wavTable.get(id);
        if (!def || !def.path) return;
        const buf = await bank.load(def.path);
        if (buf) out.set(id, buf);
      })
    );
    return out;
  }

  private scheduleBgm(song: Song, buffers: Map<number, AudioBuffer>): void {
    if (buffers.size === 0) return;
    for (const chip of song.chips) {
      if (chip.channel !== BGM_CHANNEL) continue;
      if (chip.wavId === undefined) continue;
      const buffer = buffers.get(chip.wavId);
      if (!buffer) continue;
      const def = song.wavTable.get(chip.wavId);
      const volume = def ? def.volume / 100 : 1;
      const pan = def ? def.pan / 100 : 0;
      const src = this.engine.scheduleBuffer(buffer, chip.playbackTimeMs, { volume, pan });
      this.bgmSources.push(src);
    }
  }

  private tick(): void {
    if (!this.song) return;
    const songTime = this.engine.songTimeMs();

    // Schedule upcoming drum audio ~300ms ahead to keep the queue short.
    while (this.nextScheduleIdx < this.playables.length) {
      const p = this.playables[this.nextScheduleIdx]!;
      if (p.chip.playbackTimeMs > songTime + 300) break;
      if (!p.scheduled) {
        const spec = laneSpec(p.laneValue);
        if (spec) this.engine.scheduleDrum(spec.voice, p.chip.playbackTimeMs, 0.5);
        p.scheduled = true;
      }
      this.nextScheduleIdx++;
    }

    // Miss detection: any unhit chip whose judgment window has fully passed.
    for (const p of this.playables) {
      if (p.hit || p.missed) continue;
      if (songTime - p.chip.playbackTimeMs > HIT_RANGES_MS.POOR) {
        p.missed = true;
        this.tracker.record(Judgment.MISS);
        this.judgmentFlash = {
          text: 'MISS',
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
    };
    this.renderer.render(state);
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
      // Stray hit: play sound for feedback, no score change.
      const spec = LANE_LAYOUT.find((s) => s.lane === event.lane);
      if (spec) this.engine.drums.play(spec.voice, this.engine.ctx.currentTime, { volume: 0.55 });
      this.hitFlashes.push({ lane: event.lane, spawnedMs: songTime });
      return;
    }

    const p = this.playables[bestIdx]!;
    p.hit = true;
    const judgment = classifyDeltaMs(bestDelta);
    this.tracker.record(judgment);
    this.judgmentFlash = {
      text: judgment,
      color: judgmentColor(judgment),
      lane: event.lane,
      spawnedMs: songTime,
    };
    this.hitFlashes.push({ lane: event.lane, spawnedMs: songTime });

    // Play the hit sound via the user press (so feedback matches keystroke).
    const spec = LANE_LAYOUT.find((s) => s.lane === event.lane);
    if (spec) this.engine.drums.play(spec.voice, this.engine.ctx.currentTime, { volume: 0.7 });
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
