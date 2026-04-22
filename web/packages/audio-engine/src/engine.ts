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
 *   - Callers work in *song ms*. songTimeMs(t) = (t - songStartCtxTime) * 1000.
 *   - When you start a song, pick a small lead-in (e.g. 200ms) and set
 *     `songStartCtxTime = ctx.currentTime + 0.2`.
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

  /** Mark "song start" as `leadInMs` ms from now. */
  startSongClock(leadInMs = 200): void {
    this._songStartCtxTime = this.ctx.currentTime + leadInMs / 1000;
  }

  /** Current elapsed song time in ms (may be negative during lead-in). */
  songTimeMs(): number {
    return (this.ctx.currentTime - this._songStartCtxTime) * 1000;
  }

  /** Schedule a drum voice at an absolute song time. */
  scheduleDrum(voice: DrumVoice, songTimeMs: number, volume?: number, pan?: number): void {
    const ctxWhen = this._songStartCtxTime + songTimeMs / 1000;
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
    const target = this._songStartCtxTime + songTimeMs / 1000;
    const now = this.ctx.currentTime;
    const when = target < now ? now : target;
    const offset = target < now ? now - target : 0;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
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

function clampVolume(v: number): number {
  if (Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}
