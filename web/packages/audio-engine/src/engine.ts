import { DrumSynth, type DrumVoice } from './synth.js';

/**
 * Thin wrapper around AudioContext with drum-synth convenience and clock helpers.
 *
 * Routing: three master gain nodes sit between individual sources and the
 * destination — `bgmGain`, `drumsGain`, `previewGain`. Every scheduled
 * source connects through one of them, so the Settings UI can adjust
 * per-category volume without touching per-chip gains (which still
 * carry DTX `#VOL` + pan etc.).
 *
 *     source → chip gain → (optional panner) → categoryGain → destination
 *
 * Time model:
 *   - `ctx.currentTime` is seconds since the context was created (or resumed).
 *   - Callers work in *song ms* (chart-coordinate, not wall-clock).
 *     `songTimeMs() = (ctx.currentTime - songStart) * 1000 * rate`. At
 *     rate = 1 that's identity; at rate = 0.5 it advances at half wall speed.
 *   - When you start a song, pick a small lead-in (e.g. 200ms) and set
 *     `songStartCtxTime = ctx.currentTime + 0.2`.
 *
 * Practice-rate model: `setRate(r)` scales playback of every live
 * AudioBufferSourceNode (BGM + WAV drum samples) and rebases the song
 * clock so `songTimeMs()` stays continuous across the rate change.
 * DrumSynth voices are unaffected (they schedule at absolute ctx times
 * and pitch-correct).
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly drums: DrumSynth;
  /** Master gain for BGM tracks. Settable via setBgmVolume. */
  readonly bgmGain: GainNode;
  /** Master gain for drum hits (real samples + synth). */
  readonly drumsGain: GainNode;
  /** Master gain for song-select preview audio. Exposed so PreviewPlayer
   * can connect directly (avoiding a double-decorate through scheduleBuffer). */
  readonly previewGain: GainNode;
  private _songStartCtxTime = 0;
  private _rate = 1;
  private _preservePitch = true;
  /** Live `AudioBufferSourceNode`s so `setRate` can propagate the new
   * playback rate to already-playing BGM. Cleared on `ended`. */
  private readonly liveSources = new Set<AudioBufferSourceNode>();

  constructor() {
    const AudioCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AudioCtor) throw new Error('Web Audio API not available');
    this.ctx = new AudioCtor({ latencyHint: 'interactive', sampleRate: 48000 });

    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = 1;
    this.bgmGain.connect(this.ctx.destination);

    this.drumsGain = this.ctx.createGain();
    this.drumsGain.gain.value = 1;
    this.drumsGain.connect(this.ctx.destination);

    this.previewGain = this.ctx.createGain();
    this.previewGain.gain.value = 0.7;
    this.previewGain.connect(this.ctx.destination);

    // DrumSynth pipes through the drums master gain so Settings → Drums
    // volume covers both real samples and the synth fallback.
    this.drums = new DrumSynth(this.ctx, this.drumsGain);
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Latency hint the scheduler should subtract when matching chips to visual positions. */
  get outputLatencyMs(): number {
    // outputLatency is only on certain implementations; fall back to baseLatency.
    const anyCtx = this.ctx as AudioContext & { outputLatency?: number };
    const lat = anyCtx.outputLatency ?? this.ctx.baseLatency ?? 0;
    return lat * 1000;
  }

  /** Mark "song start" as `leadInMs` ms from now. The song clock also
   * resets the rate to 1 — practice settings are reapplied by main.ts
   * via the config subscribe channel, so the engine doesn't need to
   * remember rate across chart loads. */
  startSongClock(leadInMs = 200): void {
    this._songStartCtxTime = this.ctx.currentTime + leadInMs / 1000;
  }

  /** Current elapsed song time in ms (may be negative during lead-in).
   * Returns chart-coordinate ms — at rate ≠ 1 this advances slower
   * (or faster) than wall time so chip-vs-input comparisons stay
   * rate-invariant and the visual scroll slows in lockstep with audio. */
  songTimeMs(): number {
    return (this.ctx.currentTime - this._songStartCtxTime) * 1000 * this._rate;
  }

  /** Current practice-rate multiplier. 1 = normal. */
  get rate(): number {
    return this._rate;
  }

  /** Update the practice-rate multiplier.
   *
   * Clamps to [0.25, 2.0]. Rebases the song clock so `songTimeMs()`
   * stays continuous across the change — without that, flipping the
   * rate mid-song would teleport the chart forward or backward.
   * Walks `liveSources` and propagates the new rate via
   * `playbackRate.setValueAtTime` so already-playing BGM slows in
   * place. */
  setRate(rate: number): void {
    const next = clampRate(rate);
    if (next === this._rate) return;
    const now = this.ctx.currentTime;
    this._songStartCtxTime = rebaseSongStart(now, this._songStartCtxTime, this._rate, next);
    this._rate = next;
    for (const src of this.liveSources) {
      try {
        src.playbackRate.setValueAtTime(next, now);
      } catch {
        /* source may have ended between set and walk; tolerate */
      }
    }
  }

  /** Whether pitch is preserved across rate changes on BGM / WAV-sample
   * sources. Applies to sources scheduled AFTER the set — existing
   * sources keep their initial value because `preservesPitch` is not
   * an AudioParam. */
  setPreservePitch(preserve: boolean): void {
    this._preservePitch = preserve;
    for (const src of this.liveSources) {
      applyPreservesPitch(src, preserve);
    }
  }

  /** Schedule a drum voice at an absolute song time (chart-coord ms).
   * DrumSynth oscillators don't pitch-shift with rate — the voice plays
   * at its natural pitch, only the scheduling wall-clock slows. */
  scheduleDrum(voice: DrumVoice, songTimeMs: number, volume?: number, pan?: number): void {
    const ctxWhen = this._songStartCtxTime + songTimeMs / (1000 * this._rate);
    const opts: { volume?: number; pan?: number } = {};
    if (volume !== undefined) opts.volume = volume;
    if (pan !== undefined) opts.pan = pan;
    this.drums.play(voice, Math.max(this.ctx.currentTime, ctxWhen), opts);
  }

  /**
   * Schedule a pre-decoded AudioBuffer at an absolute song time. If the song
   * time is already in the past (e.g. BGM scheduled after the song has
   * started) the buffer starts immediately but `offset` advances into it so
   * playback stays aligned with the song clock.
   *
   * `kind` picks which master gain the source joins. Defaults to 'drums'
   * so existing callers (drum sample playback via SampleBank) don't need
   * to change; BGM callers pass 'bgm'.
   *
   * The returned source can be `.stop()`-ed on restart / scene change.
   */
  scheduleBuffer(
    buffer: AudioBuffer,
    songTimeMs: number,
    options: { volume?: number; pan?: number; kind?: 'bgm' | 'drums' } = {}
  ): AudioBufferSourceNode {
    const volume = options.volume ?? 1;
    const pan = options.pan ?? 0;
    const kind = options.kind ?? 'drums';
    const master = kind === 'bgm' ? this.bgmGain : this.drumsGain;
    const target = this._songStartCtxTime + songTimeMs / (1000 * this._rate);
    const { when, offset } = computeScheduleWhen(target, this.ctx.currentTime);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this._rate;
    applyPreservesPitch(src, this._preservePitch);
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(master);
    } else {
      gain.connect(master);
    }
    this.liveSources.add(src);
    src.addEventListener('ended', () => this.liveSources.delete(src));
    src.start(when, offset);
    return src;
  }

  /** Per-category volume setters. Values clamp to [0, 1]; no ramp — the
   * Settings UI already debounces via input events so we don't need
   * extra smoothing here. */
  setBgmVolume(v: number): void {
    this.bgmGain.gain.value = clampVolume(v);
  }
  setDrumsVolume(v: number): void {
    this.drumsGain.gain.value = clampVolume(v);
  }
  setPreviewVolume(v: number): void {
    this.previewGain.gain.value = clampVolume(v);
  }
}

/** Clamp a user-supplied volume to [0, 1]. NaN → 1 (silent-fallback to
 * unity) rather than 0 so a misbehaving UI slider can't accidentally
 * mute the category without the user noticing. */
export function clampVolume(v: number): number {
  if (Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

/** Clamp practice rate to [0.25, 2.0]. Ranges outside this pitch BGM
 * unpleasantly even with preservePitch and confuse the visual scroll. */
export function clampRate(v: number): number {
  if (Number.isNaN(v)) return 1;
  return Math.max(0.25, Math.min(2.0, v));
}

/** Compute the new `_songStartCtxTime` that keeps `songTimeMs()`
 * continuous when rate changes from `oldRate` to `newRate` at wall
 * time `now`. Exported (pure) so the continuity invariant is unit-
 * testable without instantiating an AudioContext.
 *
 *   songMsOld = (now - oldStart) * 1000 * oldRate
 *   songMsNew = (now - newStart) * 1000 * newRate
 *   songMsOld == songMsNew  ⇒
 *   newStart = now - (now - oldStart) * oldRate / newRate
 */
export function rebaseSongStart(
  now: number,
  oldStart: number,
  oldRate: number,
  newRate: number,
): number {
  return now - (now - oldStart) * oldRate / newRate;
}

/** Set both `preservesPitch` and the legacy `webkitPreservesPitch` alias
 * so older Safari still respects the toggle. */
function applyPreservesPitch(src: AudioBufferSourceNode, preserve: boolean): void {
  // Cast to the mutable form — both names are well-known but typed as
  // readonly on older DOM lib definitions in some targets.
  const anySrc = src as AudioBufferSourceNode & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  try {
    anySrc.preservesPitch = preserve;
  } catch {
    /* ignore — older browser */
  }
  try {
    anySrc.webkitPreservesPitch = preserve;
  } catch {
    /* ignore */
  }
}

/** Decide the (absolute-ctx) start time and the source-offset a buffer
 * should use when scheduled at `target` relative to a clock whose now
 * is `now`. If target is already in the past we start the source now
 * and fast-forward into it by `offset`, so a late-scheduled BGM/sample
 * stays aligned with song time rather than restarting from zero.
 *
 * Exported (rather than kept inline in scheduleBuffer) so the past-time
 * compensation rule can be unit-tested without a real AudioContext.
 */
export function computeScheduleWhen(target: number, now: number): {
  when: number;
  offset: number;
} {
  const past = target < now;
  return {
    when: past ? now : target,
    offset: past ? now - target : 0,
  };
}
