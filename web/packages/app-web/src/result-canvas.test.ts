import { describe, expect, it, beforeEach } from 'vitest';
import type { JudgmentKind } from '@dtxmania/dtx-core';
import { ResultCanvas, type ResultRenderInput } from './result-canvas.js';
import { RANK_REVEAL_DURATION_MS, RANK_REVEAL_HOLD_MS } from './result-animations.js';

/**
 * Tracking 2D context — records every drawImage / fillText / fillRect
 * call so a test can assert on what `ResultCanvas.paint()` did
 * without spinning up a real canvas. Mirrors the technique
 * `vr-config.test.ts` uses for its panel paints.
 */
class TrackingCtx {
  calls: { method: string; args: unknown[] }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';

  // record verbose painting calls
  drawImage(...args: unknown[]): void {
    this.calls.push({ method: 'drawImage', args });
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ method: 'fillRect', args });
  }
  fillText(...args: unknown[]): void {
    this.calls.push({ method: 'fillText', args });
  }
  save(): void {
    this.calls.push({ method: 'save', args: [] });
  }
  restore(): void {
    this.calls.push({ method: 'restore', args: [] });
  }
}

const baseCounts = (): Record<JudgmentKind, number> => ({
  PERFECT: 100,
  GREAT: 20,
  GOOD: 5,
  POOR: 2,
  MISS: 1,
});

const baseInput = (over: Partial<ResultRenderInput> = {}): ResultRenderInput => ({
  rank: 'A',
  excellent: false,
  fullCombo: false,
  score: 1234567,
  achievementRate: 87.65,
  maxCombo: 145,
  totalNotes: 128,
  counts: baseCounts(),
  titleLine: 'Test Song / BPM 140 / Notes 128',
  newRecord: false,
  inXR: false,
  ...over,
});

let ctx: TrackingCtx;
let canvas: ResultCanvas;

beforeEach(() => {
  ctx = new TrackingCtx();
  canvas = new ResultCanvas();
});

const ctx2d = (): CanvasRenderingContext2D => ctx as unknown as CanvasRenderingContext2D;

describe('ResultCanvas — paint pipeline order', () => {
  it('paints background, banner, rank, metrics, footer hint in that family of calls', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput(), RANK_REVEAL_DURATION_MS + 500);

    // No images registered (no real <img> loads in happy-dom unless we
    // wire them) — every draw should still execute without throwing,
    // hitting the procedural fallbacks.
    const fillRects = ctx.calls.filter((c) => c.method === 'fillRect');
    const fillTexts = ctx.calls.filter((c) => c.method === 'fillText');

    // At least one fillRect for the background (procedural fallback).
    expect(fillRects.length).toBeGreaterThanOrEqual(1);
    // Some text for the rank, banner, score / rate / metrics, judge counts, footer.
    expect(fillTexts.length).toBeGreaterThanOrEqual(8);
  });

  it('hides the rank glyph during the hold window', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput(), RANK_REVEAL_HOLD_MS - 1);
    // The fallback rank text fillText is gated on reveal.hidden, so
    // there should be no occurrence of the bare 'A' as a label.
    const rankCallsBefore = ctx.calls.filter(
      (c) => c.method === 'fillText' && c.args[0] === 'A'
    );
    expect(rankCallsBefore.length).toBe(0);
  });

  it('shows the rank glyph after the reveal completes', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput({ rank: 'SS' }), RANK_REVEAL_DURATION_MS);
    const rankCalls = ctx.calls.filter(
      (c) => c.method === 'fillText' && c.args[0] === 'SS'
    );
    expect(rankCalls.length).toBe(1);
  });
});

describe('ResultCanvas — banner priority', () => {
  it('picks Excellent over FullCombo when both flags set (mirrors C# 196-210)', () => {
    canvas.start(0);
    canvas.paint(
      ctx2d(),
      baseInput({ excellent: true, fullCombo: true }),
      RANK_REVEAL_DURATION_MS
    );
    const banner = ctx.calls.find(
      (c) =>
        c.method === 'fillText' &&
        (c.args[0] === 'EXCELLENT' || c.args[0] === 'FULL COMBO' || c.args[0] === 'STAGE CLEARED')
    );
    expect(banner?.args[0]).toBe('EXCELLENT');
  });

  it('picks FullCombo when set without Excellent', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput({ fullCombo: true }), RANK_REVEAL_DURATION_MS);
    const banner = ctx.calls.find(
      (c) =>
        c.method === 'fillText' &&
        (c.args[0] === 'EXCELLENT' || c.args[0] === 'FULL COMBO' || c.args[0] === 'STAGE CLEARED')
    );
    expect(banner?.args[0]).toBe('FULL COMBO');
  });

  it('falls through to StageCleared when neither flag is set', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput(), RANK_REVEAL_DURATION_MS);
    const banner = ctx.calls.find(
      (c) =>
        c.method === 'fillText' &&
        (c.args[0] === 'EXCELLENT' || c.args[0] === 'FULL COMBO' || c.args[0] === 'STAGE CLEARED')
    );
    expect(banner?.args[0]).toBe('STAGE CLEARED');
  });
});

describe('ResultCanvas — new record badge', () => {
  it('draws NEW RECORD only when the flag is set', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput({ newRecord: false }), RANK_REVEAL_DURATION_MS);
    expect(ctx.calls.some((c) => c.method === 'fillText' && c.args[0] === 'NEW RECORD')).toBe(false);

    ctx.calls = [];
    canvas.paint(ctx2d(), baseInput({ newRecord: true }), RANK_REVEAL_DURATION_MS);
    expect(ctx.calls.some((c) => c.method === 'fillText' && c.args[0] === 'NEW RECORD')).toBe(true);
  });
});

describe('ResultCanvas — footer hint', () => {
  it('switches text between desktop and XR', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput({ inXR: false }), RANK_REVEAL_DURATION_MS + 500);
    const desktopHint = ctx.calls.find(
      (c) => c.method === 'fillText' && (c.args[0] as string)?.startsWith('Press Esc')
    );
    expect(desktopHint).toBeDefined();

    ctx.calls = [];
    canvas.paint(ctx2d(), baseInput({ inXR: true }), RANK_REVEAL_DURATION_MS + 500);
    const xrHint = ctx.calls.find(
      (c) => c.method === 'fillText' && (c.args[0] as string)?.startsWith('Squeeze controller')
    );
    expect(xrHint).toBeDefined();
  });

  it('omits the hint during the first 400 ms', () => {
    canvas.start(0);
    canvas.paint(ctx2d(), baseInput(), 100);
    expect(
      ctx.calls.some(
        (c) => c.method === 'fillText' && (c.args[0] as string)?.includes('return')
      )
    ).toBe(false);
  });
});

describe('ResultCanvas — animation gate', () => {
  it('reports incomplete before the duration elapses', () => {
    canvas.start(0);
    expect(canvas.isAnimationComplete(RANK_REVEAL_DURATION_MS - 1)).toBe(false);
    expect(canvas.isAnimationComplete(RANK_REVEAL_DURATION_MS)).toBe(true);
  });

  it('reports incomplete before start() is called', () => {
    expect(canvas.isAnimationComplete(10_000)).toBe(false);
  });
});

describe('ResultCanvas — degenerate inputs', () => {
  it('handles totalNotes=0 with --- rate text', () => {
    canvas.start(0);
    canvas.paint(
      ctx2d(),
      baseInput({ totalNotes: 0, achievementRate: 0 }),
      RANK_REVEAL_DURATION_MS
    );
    const rateText = ctx.calls.find(
      (c) => c.method === 'fillText' && c.args[0] === '---'
    );
    expect(rateText).toBeDefined();
  });

  it('handles a long titleLine without throwing', () => {
    canvas.start(0);
    expect(() =>
      canvas.paint(
        ctx2d(),
        baseInput({ titleLine: 'x'.repeat(500) }),
        RANK_REVEAL_DURATION_MS
      )
    ).not.toThrow();
  });
});
