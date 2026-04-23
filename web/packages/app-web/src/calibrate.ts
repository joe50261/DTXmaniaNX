import type { AudioEngine } from '@dtxmania/audio-engine';
import {
  computeOffset,
  makeClickBuffer,
  scheduleBeats,
  type PressEvent,
} from './calibrate-model.js';

/**
 * DOM calibration overlay — plays a short metronome sequence and asks
 * the player to press Space / click / tap on every beat. The median
 * press-minus-beat delta is the `audioOffsetMs` the game subtracts
 * from its judgment calculation.
 *
 * The math, click buffer, beat scheduler, and localStorage helpers
 * live in `calibrate-model.ts` so the in-VR calibration panel can
 * reuse them.
 */

export interface CalibrateOptions {
  beats?: number;        // total beats played (default 12)
  warmup?: number;       // beats skipped at the start (default 2)
  intervalMs?: number;   // gap between beats (default 500)
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

  const clickBuf = makeClickBuffer(ctx);
  const { beatTimes } = scheduleBeats(ctx, clickBuf, { beats, intervalMs });

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
