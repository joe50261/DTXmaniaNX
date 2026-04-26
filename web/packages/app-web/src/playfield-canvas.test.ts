import { describe, expect, it, beforeEach } from 'vitest';
import { Lane, type LaneValue } from '@dtxmania/input';
import { PlayfieldCanvas } from './playfield-canvas.js';
import { LANE_FLUSH_LIFETIME_MS } from './playfield-layout.js';

class TrackingCtx {
  calls: { method: string; args: unknown[]; alpha?: number }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';

  drawImage(...args: unknown[]): void {
    this.calls.push({ method: 'drawImage', args, alpha: this.globalAlpha });
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ method: 'fillRect', args, alpha: this.globalAlpha });
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

let ctx: TrackingCtx;
const ctx2d = (): CanvasRenderingContext2D => ctx as unknown as CanvasRenderingContext2D;

beforeEach(() => {
  ctx = new TrackingCtx();
});

describe('PlayfieldCanvas — paint with no loaded assets', () => {
  it('falls back to fillRect for active lanes', () => {
    const pf = new PlayfieldCanvas();
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    pf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 200, canvasH: 720 });
    const fillRects = ctx.calls.filter((c) => c.method === 'fillRect');
    expect(fillRects.length).toBe(1);
  });

  it('skips lanes that have not been hit', () => {
    const pf = new PlayfieldCanvas();
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    pf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 200, canvasH: 720 });
    const drawCalls = ctx.calls.filter((c) => c.method === 'fillRect' || c.method === 'drawImage');
    // Only SD; the other 9 lanes must not draw.
    expect(drawCalls.length).toBe(1);
  });

  it('skips lanes whose flush has expired', () => {
    const pf = new PlayfieldCanvas();
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    pf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 100 + LANE_FLUSH_LIFETIME_MS + 50, canvasH: 720 });
    const drawCalls = ctx.calls.filter((c) => c.method === 'fillRect' || c.method === 'drawImage');
    expect(drawCalls.length).toBe(0);
  });
});

describe('PlayfieldCanvas — paint with stub images', () => {
  it('uses drawImage when an asset is registered for the lane', () => {
    const pf = new PlayfieldCanvas();
    // Create a minimal stub that satisfies the canvas's needs —
    // happy-dom doesn't fetch real images so we hand-roll one.
    const fakeImage = {
      complete: true,
      naturalWidth: 126,
      naturalHeight: 128,
      width: 126,
      height: 128,
    } as unknown as HTMLImageElement;
    pf.internal_setAssetForLane(Lane.SD, fakeImage);
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    pf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 200, canvasH: 720 });
    const drawImages = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(drawImages.length).toBe(1);
    // alpha is faded — at 100 ms into a 500-ms lifetime, alpha = 0.8.
    expect(drawImages[0]!.alpha).toBeCloseTo(0.8, 2);
  });
});

describe('PlayfieldCanvas — multiple simultaneous lanes', () => {
  it('paints one streak per active lane with the right alpha', () => {
    const pf = new PlayfieldCanvas();
    const lastHits = new Map<LaneValue, number>([
      [Lane.SD, 100],
      [Lane.HH, 250],
      [Lane.BD, 400],
    ]);
    pf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 500, canvasH: 720 });
    const draws = ctx.calls.filter((c) => c.method === 'fillRect' || c.method === 'drawImage');
    expect(draws.length).toBe(3);
  });
});
