import type { AudioEngine } from '@dtxmania/audio-engine';

/**
 * Audio-latency calibration routine.
 *
 * Plays a series of short metronome clicks through the AudioContext and asks
 * the player to press Space (or tap / click / controller trigger — any
 * pointerdown or keydown counts) on each beat. The median delta between the
 * player's press times and the scheduled click times is returned as the
 * `audioOffsetMs` the game should subtract from the judgment calculation.
 *
 * Positive offsets ("player hits late") shift the judgment window later —
 * i.e. the code sees `delta - offset`, so a consistently-late press on a
 * laggy headset still scores PERFECT.
 *
 * The routine is UI-only; it knows nothing about the game state. The caller
 * is responsible for persisting the returned number.
 */
/**
 * Pure math core of the calibration routine: given the scheduled beat times
 * (AudioContext seconds) and the player's recorded press times, return the
 * median press-minus-beat delta in ms. Exported so the algorithm can be
 * unit-tested without driving a real AudioContext. See `runCalibration` for
 * the UI shell.
 *
 * Rules:
 *  - Each press matches to its *nearest* beat (skipping the first `warmup`
 *    warm-up beats, which exist to settle latency / input driver state).
 *  - Presses further than 300 ms from any non-warmup beat are discarded as
 *    strays (fat fingers, ignoring a beat and pressing on the next one).
 *  - Need at least 3 survivors; otherwise the result is too noisy to trust
 *    and we return null so the caller keeps the previous offset.
 *  - Median is used instead of mean so a single outlier that squeaks under
 *    the 300 ms cutoff can't shift the result by much.
 */
export function computeOffset(
  beatTimes: number[],
  presses: { audioTime: number }[],
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
    if (Math.abs(best) <= 0.3) deltas.push(best * 1000);
  }
  if (deltas.length < 3) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 0
    ? (deltas[mid - 1]! + deltas[mid]!) / 2
    : deltas[mid]!;
}

export const AUDIO_OFFSET_LS_KEY = 'dtxmania-audio-offset-ms';

export interface CalibrateOptions {
  beats?: number;        // total beats played (default 12)
  warmup?: number;       // beats skipped at the start (default 2)
  intervalMs?: number;   // gap between beats (default 500)
}

interface PressEvent {
  audioTime: number; // AudioContext.currentTime when press happened
}

export async function runCalibration(
  engine: AudioEngine,
  host: HTMLElement,
  options: CalibrateOptions = {}
): Promise<number | null> {
  const beats = options.beats ?? 12;
  const warmup = options.warmup ?? 2;
  const intervalMs = options.intervalMs ?? 500;

  await engine.resume();
  const ctx = engine.ctx;

  // Build calibration overlay DOM.
  const panel = document.createElement('div');
  panel.setAttribute('data-calibration', '');
  Object.assign(panel.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0, 0, 0, 0.92)',
    color: '#e2e8f0',
    zIndex: '20',
    display: 'grid',
    placeItems: 'center',
    font: '14px ui-monospace, SFMono-Regular, Menlo, monospace',
  }) as CSSStyleDeclaration;

  const inner = document.createElement('div');
  inner.style.textAlign = 'center';
  const heading = document.createElement('div');
  heading.textContent = 'Audio latency calibration';
  heading.style.fontSize = '22px';
  heading.style.marginBottom = '14px';
  const info = document.createElement('div');
  info.style.opacity = '0.7';
  info.style.marginBottom = '24px';
  info.innerHTML =
    `Tap <strong>Space</strong> (or click / controller trigger) on every beat.<br>` +
    `${beats} beats total, first ${warmup} are warm-up.`;
  const dot = document.createElement('div');
  Object.assign(dot.style, {
    width: '120px',
    height: '120px',
    borderRadius: '50%',
    background: '#1f2937',
    border: '3px solid #4b5563',
    margin: '0 auto 14px',
    transition: 'background 60ms ease-out, border-color 60ms ease-out, transform 120ms ease-out',
  });
  const status = document.createElement('div');
  status.style.margin = '8px 0 24px';
  status.textContent = 'Starting…';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, {
    font: 'inherit',
    padding: '10px 18px',
    background: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    borderRadius: '6px',
    color: '#fff',
    cursor: 'pointer',
  });
  inner.append(heading, info, dot, status, cancel);
  panel.appendChild(inner);
  host.appendChild(panel);

  // Schedule click buffer (short white-noise burst) for each beat.
  const clickBuf = makeClickBuffer(ctx);
  const startAt = ctx.currentTime + 0.6;
  const beatTimes: number[] = [];
  for (let i = 0; i < beats; i++) {
    const when = startAt + (i * intervalMs) / 1000;
    beatTimes.push(when);
    const src = ctx.createBufferSource();
    src.buffer = clickBuf;
    const gain = ctx.createGain();
    gain.gain.value = 0.4;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(when);
  }

  // Animate the dot alongside beats.
  const tickers: number[] = [];
  for (let i = 0; i < beats; i++) {
    const delayMs = Math.max(0, (beatTimes[i]! - ctx.currentTime) * 1000);
    tickers.push(
      window.setTimeout(() => {
        dot.style.background = '#ffeb3b';
        dot.style.borderColor = '#ffeb3b';
        dot.style.transform = 'scale(1.08)';
        window.setTimeout(() => {
          dot.style.background = '#1f2937';
          dot.style.borderColor = '#4b5563';
          dot.style.transform = 'scale(1)';
        }, 120);
        status.textContent =
          i < warmup
            ? `Warm-up ${i + 1} / ${warmup}`
            : `Beat ${i - warmup + 1} / ${beats - warmup}`;
      }, delayMs)
    );
  }

  // Collect presses.
  const presses: PressEvent[] = [];
  const onPress = (): void => {
    presses.push({ audioTime: ctx.currentTime });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'Enter') onPress();
  };
  window.addEventListener('keydown', onKey);
  panel.addEventListener('pointerdown', onPress);

  return new Promise<number | null>((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      for (const t of tickers) window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      panel.removeEventListener('pointerdown', onPress);
      panel.remove();
    };

    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
      resolve(null);
    });

    // Finish shortly after the last beat's nominal time plus a small grace.
    const endAt = beatTimes[beats - 1]! + 0.35;
    const watchdog = window.setInterval(() => {
      if (ctx.currentTime < endAt) return;
      window.clearInterval(watchdog);
      if (settled) return;
      const offset = computeOffset(beatTimes, presses, warmup);
      cleanup();
      resolve(offset);
    }, 50);
  });
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

/** Short noise burst — cheaper than decoding a click.wav for two routines. */
function makeClickBuffer(ctx: AudioContext): AudioBuffer {
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
