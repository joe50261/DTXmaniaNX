import {
  parseDtx,
  computeTiming,
  ScoreTracker,
  classifyDeltaMs,
  computeAchievementRate,
  computeRank,
  isFullCombo,
  isExcellent,
  Judgment,
  joinPath,
  type Chip,
  type FileSystemBackend,
  type ScoreSnapshot,
  type Song,
  type SongEntry,
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
import { applyAutoFire } from './autofire.js';
import { detectMisses, matchLaneHit } from './matcher.js';
import { channelToLane, LANE_LAYOUT, laneSpec } from './lane-layout.js';
import { XrControllers } from './xr-controllers.js';
import { resetStateOnVrExit } from './vr-lifecycle.js';
import {
  applyGaugeDelta,
  shouldEnterFinishedState,
  shouldFireResultPadHitReturn,
  shouldFireVrAutoReturn,
  updateCancelEdgeState,
} from './tick-state.js';
import { VrMenu, type VrMenuDeps, type VrMenuPick } from './vr-menu.js';
import type { BoxNode } from '@dtxmania/dtx-core';
import { loadAudioOffsetMs } from './calibrate.js';

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
  /** performance.now() of the 'playing' → 'finished' transition. Drives the
   * result-screen fade-in and the auto-return dwell. */
  private finishedAtMs: number | null = null;
  /** Once-per-chart latch shared by both result-screen return paths (VR
   * auto-return after 5 s AND pad-hit-skip). Unified so that whichever
   * path fires first prevents the other from firing too and double-calling
   * onRestart (which would re-show the VR menu on top of itself and
   * re-wire XR controller event listeners). */
  private finishedReturnHandled = false;
  /** Edge state for the in-song "squeeze to quit" poller. Indexed by
   * controller. Kept in Game (not XrControllers) because the button's
   * meaning depends on Game's status — during play it aborts, during
   * the VR menu it's a back press handled by VrMenu itself. */
  private cancelSqueezed: boolean[] = [false, false];
  private judgmentFlash: JudgmentFlash | null = null;
  private hitFlashes: HitFlash[] = [];
  /** Life / skill gauge, 0..1. Filled by hits, drained by misses. Starts at 0.5 so the player has headroom. */
  private gauge = 0.5;
  /** performance.now() of the most recent hit per lane; drives pad bounce + flush overlay. */
  private lastPadHitMs = new Map<LaneValue, number>();
  private onRestart: (() => void) | null = null;
  /** Fires exactly once per chart when the song transitions to
   * 'finished'. Host uses it to persist per-chart best-score records.
   * Cleared in loadAndStart and called in the tick() status-flip
   * branch; no guard for null because the callback is optional. */
  private onChartFinished: ((chartPath: string, snap: ScoreSnapshot) => void) | null = null;
  private currentChartPath: string | null = null;
  /** Per-lane auto-play: keys are DTX channel numbers (Lane.BD etc.);
   * presence in the set means Game auto-fires chips on that lane.
   * DTXmania equivalent: each key of CConfigIni.bAutoPlay. Auto-fired
   * chips don't advance combo and are excluded from score / rank
   * denominators via ScoreTracker.recordAuto. */
  private autoPlayLanes = new Set<LaneValue>();
  private bgmSources: AudioBufferSourceNode[] = [];
  private readonly xrControllers: XrControllers;
  private readonly vrMenu: VrMenu;
  private menuIsShown = false;

  constructor(private readonly canvas: HTMLCanvasElement, skin: SkinTextures = {}) {
    this.renderer = new Renderer(canvas, skin);
    this.engine = new AudioEngine();
    this.input = new KeyboardInput();
    this.input.attach();
    this.input.onLaneHit((e) => this.handleLaneHit(e));
    this.input.onMenu((e) => {
      if (e.action !== 'cancel') return;
      // Esc works in two situations now: from RESULTS (same as before,
      // returns to picker) and mid-song (bail out of the current chart
      // without waiting for it to finish). leaveSong handles both by
      // stopping audio + firing onRestart.
      if (this.status === 'finished' || this.status === 'playing') {
        this.leaveSong();
      }
    });
    this.xrControllers = new XrControllers(this.renderer.webgl, this.renderer.scene);
    this.xrControllers.setPadsTexture(skin.pads);
    this.xrControllers.onHit((e) => this.handleLaneHit(e));
    this.vrMenu = new VrMenu(this.renderer.webgl, this.renderer.scene);
    // Tick every frame, even before a chart is loaded, so the VR menu's
    // raycaster + trigger polling keeps working while the player's still
    // picking a song.
    this.renderer.onFrame(() => this.tick());
  }

  /** Enter a WebXR immersive-vr session (Quest browser). Throws if unsupported. */
  async enterXR(onEnded: () => void): Promise<void> {
    await this.renderer.enterXR(() => {
      this.xrControllers.stop();
      this.vrMenu.hide();
      this.menuIsShown = false;
      // Restore playfield visibility: if the player exited via the Exit VR
      // button, the VR menu was up and we'd hidden the playfield. Without
      // this, the next enterXR would scale + position the playfield but
      // leave it invisible — user sees an empty VR scene.
      this.renderer.setPlayfieldVisible(true);
      // If the player exited VR while the result screen was up, clear the
      // finished state (see resetStateOnVrExit for the full why).
      const reset = resetStateOnVrExit({
        status: this.status,
        song: this.song,
        finishedAtMs: this.finishedAtMs,
        finishedReturnHandled: this.finishedReturnHandled,
      });
      this.status = reset.status;
      this.song = reset.song;
      this.finishedAtMs = reset.finishedAtMs;
      this.finishedReturnHandled = reset.finishedReturnHandled;
      onEnded();
    });
    this.xrControllers.start();
  }

  /**
   * Show the in-VR song picker. Renderer.onFrame already ticks xrControllers
   * and the menu every frame so raycast updates while this is visible.
   */
  showVrMenu(
    root: BoxNode,
    onPick: (pick: VrMenuPick) => void,
    onExit: () => void,
    deps: VrMenuDeps
  ): void {
    this.menuIsShown = true;
    // Hide playfield while the menu is up. Without this the result HUD +
    // scrolling pads (renderOrder 2/4, depthTest:off) keep painting over
    // the menu panel (renderOrder 0) and the player can't see what they
    // picked — and thinks auto-return / pad-hit-skip "didn't fire".
    this.renderer.setPlayfieldVisible(false);
    this.vrMenu.show(root, onPick, onExit, deps);
  }

  hideVrMenu(): void {
    this.menuIsShown = false;
    this.renderer.setPlayfieldVisible(true);
    this.vrMenu.hide();
  }

  get inXR(): boolean {
    return this.renderer.inXR;
  }

  /** True if loadAndStart has been called at least once. */
  get hasChart(): boolean {
    return this.song !== null;
  }

  /** Expose the shared AudioContext so the song-select preview player can
   * ride on the same AC (avoids hitting the browser's low cap on
   * concurrent AudioContexts, and means one user gesture resumes both). */
  get audioContext(): AudioContext {
    return this.engine.ctx;
  }

  /** Expose the AudioEngine so main.ts can apply volume settings and
   * wire the PreviewPlayer to the shared previewGain. */
  get audio(): AudioEngine {
    return this.engine;
  }

  /**
   * Inject skin textures after construction. Lets main.ts build the Game
   * eagerly (so Enter-VR stays on a synchronous gesture path) and apply
   * the PNGs once the TextureLoader finishes, without rebuilding anything.
   */
  applySkin(skin: SkinTextures): void {
    this.renderer.applySkin(skin);
    this.xrControllers.setPadsTexture(skin.pads);
  }

  /** Replace the set of auto-firing lanes. Mid-session safe — next
   * tick picks up the new set; chips already past their window aren't
   * retroactively auto-fired. */
  setAutoPlayLanes(lanes: Iterable<LaneValue>): void {
    this.autoPlayLanes = new Set(lanes);
  }

  async loadAndStart(
    dtxText: string,
    opts: {
      onRestart?: () => void;
      fs?: GameFsContext;
      autoPlayLanes?: Iterable<LaneValue>;
      /** Stable ID for this chart — used as the IDB key for best-of
       * records. Host supplies the scanner's `chart.chartPath`. */
      chartPath?: string;
      /** Fires once when the chart's status flips to 'finished'. Host
       * persists the snapshot via mergeChartRecord → saveChartRecord. */
      onChartFinished?: (chartPath: string, snap: ScoreSnapshot) => void;
    } = {}
  ): Promise<void> {
    this.onRestart = opts.onRestart ?? null;
    this.onChartFinished = opts.onChartFinished ?? null;
    this.currentChartPath = opts.chartPath ?? null;
    if (opts.autoPlayLanes !== undefined) {
      this.autoPlayLanes = new Set(opts.autoPlayLanes);
    }
    // Belt-and-braces: whatever state hideVrMenu may or may not have run in,
    // a fresh chart always wants the playfield visible.
    this.renderer.setPlayfieldVisible(true);
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
    this.finishedAtMs = null;
    this.finishedReturnHandled = false;
    this.engine.startSongClock(COUNTDOWN_MS);

    this.scheduleBgm(this.song);
  }

  stop(): void {
    this.input.detach();
    this.stopBgm();
    this.vrMenu.dispose();
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
   * Abandon the current chart. Called from two places:
   *   - Desktop Esc (mid-song or on RESULTS)
   *   - VR squeeze during play
   * Stops BGM, clears chart state so hasChart flips to false (mirrors
   * what the VR-exit session-end path does), then calls onRestart so
   * main.ts can surface the appropriate picker. Safe to call from
   * either 'playing' or 'finished' status.
   */
  private leaveSong(): void {
    if (this.status === 'idle' || !this.onRestart) return;
    this.stopBgm();
    this.status = 'idle';
    this.song = null;
    this.finishedAtMs = null;
    this.finishedReturnHandled = false;
    this.onRestart();
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
      // BGM routes through the engine's bgmGain master so Settings →
      // BGM volume applies without per-chip tweaking.
      const src = this.engine.scheduleBuffer(buffer, chip.playbackTimeMs, {
        volume,
        pan,
        kind: 'bgm',
      });
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
    this.vrMenu.tick();
    // VR mid-song quit: any of X/Y/A/B (face buttons on either Touch
    // controller) presses while the chart is playing dumps us back to
    // the picker. Squeeze was used previously but turned out easy to
    // misfire while gripping the stick tightly — the face buttons need
    // a deliberate thumb reach. Edge-detected per controller so a hold
    // doesn't re-fire, and deliberately only active during 'playing' —
    // VrMenu handles its own back input, and the RESULTS screen is
    // already covered by Esc / pad-hit / 5 s auto-return.
    const sources = this.xrControllers.currentInputSources;
    // Index 4 = A (right) / X (left); index 5 = B / Y. Either counts.
    const pressed0 =
      (sources[0]?.gamepad?.buttons?.[4]?.pressed ?? false) ||
      (sources[0]?.gamepad?.buttons?.[5]?.pressed ?? false);
    const pressed1 =
      (sources[1]?.gamepad?.buttons?.[4]?.pressed ?? false) ||
      (sources[1]?.gamepad?.buttons?.[5]?.pressed ?? false);
    const edge = updateCancelEdgeState({
      prev: [this.cancelSqueezed[0]!, this.cancelSqueezed[1]!],
      pressed: [pressed0, pressed1],
      active: this.status === 'playing' && this.renderer.inXR,
    });
    this.cancelSqueezed[0] = edge.next[0];
    this.cancelSqueezed[1] = edge.next[1];
    if (edge.firedBy !== null) {
      console.info('[game] VR face-button → leaveSong');
      this.leaveSong();
      return;
    }
    if (!this.song) return;
    const songTime = this.engine.songTimeMs();

    // Drum chips don't auto-play; audio only fires on the player's keystroke
    // (handleLaneHit). BGM is still auto-scheduled via scheduleBgm so the
    // music continues. Missed chips are silent — standard rhythm-game feel.
    // Exception: auto-kick fires BD + LBD chips on schedule — see
    // autoFireLanes below.
    this.autoFireLanes(songTime);

    // Miss detection via matcher.ts — pure helper flips `missed = true`
    // on each chip whose POOR window has passed and returns the events
    // so we can apply the tracker / gauge / flash side effects here.
    // Only the newest miss wins the on-screen judgment flash; tracker
    // and gauge take every one.
    const missEvents = detectMisses(this.playables, songTime);
    for (const m of missEvents) {
      this.tracker.record(Judgment.MISS);
      this.applyGaugeDelta(Judgment.MISS);
      this.judgmentFlash = {
        text: 'MISS',
        judgment: Judgment.MISS,
        color: '#ef4444',
        lane: m.lane,
        spawnedMs: songTime,
      };
    }

    // Game-over check: song finished + small tail for last miss detection.
    if (shouldEnterFinishedState(songTime, this.song.durationMs, this.status)) {
      this.status = 'finished';
      this.finishedAtMs = performance.now();
      console.info('[result] entered finished state, inXR=', this.renderer.inXR);
      // Emit the finish event exactly once per chart so the host can
      // persist the best-of record. Only fires on natural completion,
      // not on leaveSong() bail-outs — incomplete plays shouldn't
      // overwrite a real attempt's medal.
      if (this.onChartFinished && this.currentChartPath) {
        try {
          this.onChartFinished(this.currentChartPath, this.tracker.snapshot());
        } catch (e) {
          console.warn('[result] onChartFinished threw', e);
        }
      }
    }

    // In VR there's no keyboard, so the player can't press Esc to return to
    // the menu like on desktop. Auto-fire onRestart ~5 s after FINISHED shows
    // so the VR song-picker appears on its own.
    //
    // We can't use setTimeout here: Quest Browser throttles / suspends 2D
    // page timers while an immersive session is active (hidden-page policy),
    // so a 5 s setTimeout can fire minutes late or never. The XR animation
    // loop (driving tick()) is pinned to XRSession.requestAnimationFrame and
    // keeps running, so we drive the dwell off performance.now() deltas and
    // check it every frame. Latch to single-shot.
    if (
      shouldFireVrAutoReturn({
        status: this.status,
        finishedReturnHandled: this.finishedReturnHandled,
        inXR: this.renderer.inXR,
        hasOnRestart: this.onRestart !== null,
        finishedAtMs: this.finishedAtMs,
        nowMs: performance.now(),
      })
    ) {
      this.finishedReturnHandled = true;
      console.info('[result] VR auto-return fired');
      this.onRestart!();
    }

    this.hitFlashes = this.hitFlashes.filter((f) => songTime - f.spawnedMs < 400);

    // Single snapshot — cheap, but avoids fan-out when we add more derived
    // metrics. Derived rank / rate fields are only meaningful on the result
    // screen; 'E' / 0 are inert placeholders while playing.
    const snap = this.tracker.snapshot();
    const rate = this.status === 'finished' ? computeAchievementRate(snap) : 0;
    const rank = this.status === 'finished' ? computeRank(rate, snap.totalNotes) : 'E';

    const state: RenderState = {
      songTimeMs: songTime,
      chips: this.song.chips,
      combo: snap.combo,
      score: snap.score,
      maxCombo: snap.maxCombo,
      judgmentFlash: this.judgmentFlash,
      hitFlashes: this.hitFlashes,
      status: this.status,
      titleLine: `${this.song.title} / BPM ${this.song.baseBpm} / Notes ${this.playables.length}`,
      songLengthMs: this.song.durationMs,
      gauge: this.gauge,
      lastPadHitMs: this.lastPadHitMs,
      counts: snap.counts,
      totalNotes: snap.totalNotes,
      achievementRate: rate,
      rank,
      fullCombo: isFullCombo(snap),
      excellent: isExcellent(snap),
      finishedAtMs: this.finishedAtMs,
      inXR: this.renderer.inXR,
    };
    this.renderer.render(state);
    this.renderer.submitPadHits(this.lastPadHitMs);
    this.xrControllers.submitPadHits(this.lastPadHitMs);
  }

  /**
   * Fire any playable chip on an auto-play lane whose playback time
   * has arrived. Mirrors DTXmania's auto-play loop in
   * CStagePerfDrumsScreen.cs:3394-3429 (UsePerfectGhost branch) —
   * plays the sample, bounces the pad, pushes a hit flash, but calls
   * ScoreTracker.recordAuto instead of record(PERFECT) so combo and
   * the rank denominator stay honest.
   *
   * `autoPlayLanes` is a Set of LaneValues (DTX channel numbers),
   * populated from config.autoPlay via main.ts. Empty set = no-op.
   */
  private autoFireLanes(songTime: number): void {
    // Decision is a pure function in autofire.ts so it can be unit-
    // tested without spinning up a Game. PlayableChip already has the
    // (chip, laneValue, hit, missed) shape the helper expects —
    // PlayableChip's `state` is itself so we treat each record as
    // both candidate + state container.
    // PlayableChip is structurally a superset of AutoFireCandidate
    // (adds `buffer`), so it passes straight through.
    const events = applyAutoFire(this.playables, this.autoPlayLanes, songTime);
    for (const ev of events) {
      const p = this.playables[ev.idx]!;
      this.tracker.recordAuto();
      this.playChipSample(p, songTime, 1);
      this.lastPadHitMs.set(ev.lane, performance.now());
      this.hitFlashes.push({ lane: ev.lane, spawnedMs: songTime });
    }
  }

  private handleLaneHit(event: LaneHitEvent): void {
    // Result-screen early-exit: any pad hit after a short dwell returns to
    // the song picker (primarily for VR, where there is no keyboard). The
    // 400 ms dwell keeps the last in-song strike from double-firing as a
    // skip the moment the song flips to 'finished'.
    if (this.status === 'finished') {
      const dwell = this.finishedAtMs === null
        ? -1
        : performance.now() - this.finishedAtMs;
      console.info('[result] pad hit during result', {
        lane: event.lane,
        returnHandled: this.finishedReturnHandled,
        hasOnRestart: !!this.onRestart,
        dwellMs: dwell,
      });
      if (
        !shouldFireResultPadHitReturn({
          status: this.status,
          finishedReturnHandled: this.finishedReturnHandled,
          hasOnRestart: this.onRestart !== null,
          finishedAtMs: this.finishedAtMs,
          nowMs: performance.now(),
        })
      ) return;
      this.finishedReturnHandled = true;
      console.info('[result] pad-hit skip → onRestart');
      this.onRestart!();
      return;
    }
    if (this.status !== 'playing' || !this.song) return;
    const songTime = this.engine.songTimeMs();
    // Player's calibrated offset: positive = the player's press lands after
    // the beat (audio output latency / headset lag). Subtracting shifts the
    // judgment window so a consistent lag still counts as PERFECT.
    const offset = loadAudioOffsetMs();
    // matcher.ts handles the nearest-chip search + POOR-window clamp +
    // classifyDeltaMs; it also flips p.hit = true on match so a repeat
    // call in the same frame finds nothing. Null return → stray hit.
    const match = matchLaneHit(this.playables, event.lane, songTime, offset);

    if (match === null) {
      // Stray hit: play the most recent real sample that fired on this lane
      // so off-note keystrokes still sound like a drum, not a synth. Only
      // fall back to synth if the lane has never fired a real-sample chip
      // yet (e.g. first beats, or the whole lane is .xa-backed).
      this.playStrayHit(event.lane, songTime);
      this.hitFlashes.push({ lane: event.lane, spawnedMs: songTime });
      this.lastPadHitMs.set(event.lane, performance.now());
      return;
    }

    const p = this.playables[match.idx]!;
    this.tracker.record(match.judgment);
    this.applyGaugeDelta(match.judgment);
    this.judgmentFlash = {
      text: match.judgment,
      judgment: match.judgment,
      color: judgmentColor(match.judgment),
      lane: event.lane,
      spawnedMs: songTime,
      // Sign matches matcher.ts's delta: negative = press landed before
      // the target (FAST), positive = after (SLOW). Renderer only
      // surfaces the arrow when config.showFastSlow is on.
      deltaMs: match.deltaMs,
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
    this.gauge = applyGaugeDelta(this.gauge, judgment);
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
