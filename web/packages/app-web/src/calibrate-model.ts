/**
 * Pure model for audio-latency calibration.
 *
 * Shared by the desktop DOM overlay (`calibrate.ts`) and the in-VR
 * calibration panel (`vr-calibrate.ts`). Anything that is view-agnostic
 * — the median-of-deltas offset computation, click-buffer generation,
 * beat scheduler, localStorage persistence — lives here so both views
 * agree on the math. A calibration that measures +25 ms on desktop
 * should still measure +25 ms in VR (modulo the real platform latency
 * delta — which is the whole point of having separate calibration
 * runs per platform).
 */
export const AUDIO_OFFSET_LS_KEY = 'dtxmania-audio-offset-ms';

/** Acceptance window for a press → nearest-beat match. Presses farther
 * than this from any non-warmup beat are treated as strays and dropped.
 * Inclusive — a press at exactly this distance is kept. */
export const PRESS_MATCH_WINDOW_SEC = 0.3;

/** Below this many surviving presses the result is considered too noisy
 * to trust and `computeOffset` returns null so the caller keeps the
 * previous offset. */
export const MIN_USABLE_PRESSES = 3;

export interface PressEvent {
  /** AudioContext.currentTime (seconds) when the press happened. */
  audioTime: number;
}

/**
 * Given the scheduled beat times (AudioContext seconds) and the
 * player's recorded press times, return the median press-minus-beat
 * delta in ms.
 *
 * Rules:
 *  - Each press matches to its *nearest* beat (skipping the first
 *    `warmup` warm-up beats, which exist to settle latency / input
 *    driver state).
 *  - Presses further than PRESS_MATCH_WINDOW_SEC from any non-warmup
 *    beat are discarded as strays (fat fingers, skipped beats).
 *  - Need at least MIN_USABLE_PRESSES survivors; otherwise the result
 *    is too noisy to trust and we return null.
 *  - Median (not mean) so a single outlier that squeaks under the
 *    cutoff can't shift the result by much.
 *
 * Units: seconds in, milliseconds out. Positive result = player
 * consistently pressed after the beat (hits are "late") — the game
 * should subtract this from `delta` so those hits score PERFECT.
 */
export function computeOffset(
  beatTimes: number[],
  presses: PressEvent[],
  warmup: number
): number | null {
  const deltas: number[] = [];
  const active = beatTimes.slice(warmup);
  for (const press of presses) {
    let best = Number.POSITIVE_INFINITY;
    let bestAbs = Number.POSITIVE_INFINITY;
    for (const beat of active) {
      const d = press.audioTime - beat;
      if (Math.abs(d) < bestAbs) {
        bestAbs = Math.abs(d);
        best = d;
      }
    }
    if (Math.abs(best) <= PRESS_MATCH_WINDOW_SEC) deltas.push(best * 1000);
  }
  if (deltas.length < MIN_USABLE_PRESSES) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 0
    ? (deltas[mid - 1]! + deltas[mid]!) / 2
    : deltas[mid]!;
}

/** Short noise burst used as the metronome click — ~40 ms exponential-
 * decay white noise. Cheaper than decoding a separate click.wav. */
export function makeClickBuffer(ctx: AudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.round(sampleRate * 0.04);
  const buf = ctx.createBuffer(1, length, sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const envelope = Math.exp(-i / (sampleRate * 0.01));
    data[i] = (Math.random() * 2 - 1) * envelope * 0.9;
  }
  return buf;
}

export interface ScheduledBeats {
  /** AudioContext.currentTime values at which each click will sound. */
  beatTimes: number[];
  /** When the first beat fires (same as beatTimes[0]); convenient for
   * lead-in animations. */
  startAt: number;
}

export interface ScheduleOptions {
  /** Total beats to play (default 12). */
  beats?: number;
  /** Gap between beats in ms (default 500). */
  intervalMs?: number;
  /** Lead-in from `ctx.currentTime` to the first beat, in seconds
   * (default 0.6) — gives the player a moment to settle. */
  leadInSec?: number;
  /** Click gain (default 0.4). */
  gain?: number;
}

/**
 * Schedule `beats` metronome clicks on the audio graph, returning the
 * list of AudioContext times so both the view's beat animation and the
 * offset computation see exactly the same timestamps.
 */
export function scheduleBeats(
  ctx: AudioContext,
  clickBuf: AudioBuffer,
  opts: ScheduleOptions = {}
): ScheduledBeats {
  const beats = opts.beats ?? 12;
  const intervalMs = opts.intervalMs ?? 500;
  const leadInSec = opts.leadInSec ?? 0.6;
  const gain = opts.gain ?? 0.4;

  const startAt = ctx.currentTime + leadInSec;
  const beatTimes: number[] = [];
  for (let i = 0; i < beats; i++) {
    const when = startAt + (i * intervalMs) / 1000;
    beatTimes.push(when);
    const src = ctx.createBufferSource();
    src.buffer = clickBuf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(when);
  }
  return { beatTimes, startAt };
}

/** Returns the current persisted offset (ms), or 0 if none. */
export function loadAudioOffsetMs(): number {
  try {
    const raw = window.localStorage.getItem(AUDIO_OFFSET_LS_KEY);
    if (raw === null) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function saveAudioOffsetMs(ms: number): void {
  try {
    window.localStorage.setItem(AUDIO_OFFSET_LS_KEY, String(ms));
  } catch {
    /* ignore — private mode / disabled storage */
  }
}
