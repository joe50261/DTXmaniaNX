import { DrumSynth, type DrumVoice } from './synth.js';

/**
 * Thin wrapper around AudioContext with drum-synth convenience and clock helpers.
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
  private _songStartCtxTime = 0;

  constructor() {
    const AudioCtor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AudioCtor) throw new Error('Web Audio API not available');
    this.ctx = new AudioCtor({ latencyHint: 'interactive', sampleRate: 48000 });
    this.drums = new DrumSynth(this.ctx);
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
}
