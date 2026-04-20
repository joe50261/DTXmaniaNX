/**
 * Tiny synthesized drum kit. Good enough for MVP demos that don't ship real
 * WAV assets. Real sample playback via AudioBuffer will live in sample-bank.ts
 * (Phase 2.5).
 *
 * All voices are one-shot: start at absolute AudioContext time `when` and
 * release with an exponential ramp. They free themselves when finished.
 */

export type DrumVoice = 'kick' | 'snare' | 'hihat' | 'openhat' | 'tom-hi' | 'tom-lo' | 'tom-floor' | 'crash' | 'ride';

export interface SynthOptions {
  volume?: number;   // 0..1, default 0.8
  pan?: number;      // -1..1, default 0
}

export class DrumSynth {
  private readonly master: GainNode;

  constructor(private readonly ctx: AudioContext, destination: AudioNode = ctx.destination) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(destination);
  }

  play(voice: DrumVoice, when: number, options: SynthOptions = {}): void {
    const vol = options.volume ?? 0.8;
    const pan = options.pan ?? 0;
    const out = this.voiceOut(pan);
    out.gain.setValueAtTime(vol, when);

    switch (voice) {
      case 'kick': return this.kick(when, out);
      case 'snare': return this.snare(when, out);
      case 'hihat': return this.hat(when, 0.06, out);
      case 'openhat': return this.hat(when, 0.35, out);
      case 'tom-hi': return this.tom(when, 240, out);
      case 'tom-lo': return this.tom(when, 160, out);
      case 'tom-floor': return this.tom(when, 110, out);
      case 'crash': return this.cymbal(when, 1.1, 0.35, out);
      case 'ride': return this.cymbal(when, 0.9, 0.45, out);
    }
  }

  private voiceOut(pan: number): GainNode {
    const g = this.ctx.createGain();
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  private kick(when: number, out: GainNode): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.35);
    osc.connect(g).connect(out);
    osc.start(when);
    osc.stop(when + 0.4);
  }

  private snare(when: number, out: GainNode): void {
    // Tone body
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, when);
    const tone = this.ctx.createGain();
    tone.gain.setValueAtTime(0.7, when);
    tone.gain.exponentialRampToValueAtTime(0.001, when + 0.15);
    osc.connect(tone).connect(out);
    osc.start(when);
    osc.stop(when + 0.2);

    // Noise body
    const noise = this.noiseBuffer(0.2);
    const src = this.ctx.createBufferSource();
    src.buffer = noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.8, when);
    ng.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
    src.connect(hp).connect(ng).connect(out);
    src.start(when);
    src.stop(when + 0.25);
  }

  private hat(when: number, duration: number, out: GainNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(duration + 0.05);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + duration);
    src.connect(hp).connect(g).connect(out);
    src.start(when);
    src.stop(when + duration + 0.05);
  }

  private tom(when: number, freq: number, out: GainNode): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, when + 0.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.4);
    osc.connect(g).connect(out);
    osc.start(when);
    osc.stop(when + 0.45);
  }

  private cymbal(when: number, tone: number, duration: number, out: GainNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(duration + 0.1);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000 + tone * 2000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.55, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + duration);
    src.connect(hp).connect(g).connect(out);
    src.start(when);
    src.stop(when + duration + 0.1);
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
