import { describe, expect, it } from 'vitest';
import {
  END_TIMING,
  LOADING_TIMING,
  splashAlpha,
  splashPhase,
  STARTUP_TIMING,
  TITLE_TIMING,
} from './splash-layout.js';

describe('splashPhase — timing windows', () => {
  it('startup walks fade-in → hold → fade-out → done on the auto-exit clock', () => {
    expect(splashPhase(0, STARTUP_TIMING, false, 0).phase).toBe('fade-in');
    expect(splashPhase(STARTUP_TIMING.fadeInMs, STARTUP_TIMING, false, 0).phase).toBe('hold');
    const exitAt = STARTUP_TIMING.fadeInMs + STARTUP_TIMING.holdMs;
    expect(splashPhase(exitAt, STARTUP_TIMING, false, 0).phase).toBe('fade-out');
    expect(splashPhase(exitAt + STARTUP_TIMING.fadeOutMs, STARTUP_TIMING, false, 0).phase).toBe('done');
  });

  it('title holds indefinitely until exit is requested', () => {
    expect(splashPhase(10_000, TITLE_TIMING, false, 0).phase).toBe('hold');
    expect(splashPhase(60_000, TITLE_TIMING, false, 0).phase).toBe('hold');
  });

  it('title with no fade-out snaps straight to done on exit request', () => {
    const requested = splashPhase(10_000, TITLE_TIMING, true, 5000);
    // fadeOutMs === 0 → done branch
    expect(requested.phase).toBe('done');
  });

  it('loading uses fade-out only on exit request', () => {
    expect(splashPhase(0, LOADING_TIMING, false, 0).phase).toBe('hold');
    const out = splashPhase(500, LOADING_TIMING, true, 400);
    expect(out.phase).toBe('fade-out');
    expect(out.progress).toBeCloseTo((500 - 400) / LOADING_TIMING.fadeOutMs);
  });

  it('end auto-exits without an external request', () => {
    const exitAt = END_TIMING.fadeInMs + END_TIMING.holdMs;
    expect(splashPhase(exitAt - 1, END_TIMING, false, 0).phase).toBe('hold');
    expect(splashPhase(exitAt, END_TIMING, false, 0).phase).toBe('fade-out');
    expect(splashPhase(exitAt + END_TIMING.fadeOutMs, END_TIMING, false, 0).phase).toBe('done');
  });
});

describe('splashPhase — defensive', () => {
  it('treats negative / NaN elapsed as the fade-in start', () => {
    expect(splashPhase(-100, STARTUP_TIMING, false, 0).phase).toBe('fade-in');
    expect(splashPhase(Number.NaN, STARTUP_TIMING, false, 0).phase).toBe('fade-in');
  });
});

describe('splashAlpha', () => {
  it('maps each phase to the expected alpha', () => {
    expect(splashAlpha({ phase: 'fade-in', progress: 0.5 })).toBe(0.5);
    expect(splashAlpha({ phase: 'hold', progress: 1 })).toBe(1);
    expect(splashAlpha({ phase: 'fade-out', progress: 0.25 })).toBe(0.75);
    expect(splashAlpha({ phase: 'done', progress: 1 })).toBe(0);
  });
});
