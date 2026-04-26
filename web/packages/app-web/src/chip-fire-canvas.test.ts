import { describe, expect, it, beforeEach } from 'vitest';
import { Lane, type LaneValue } from '@dtxmania/input';
import { ChipFireCanvas } from './chip-fire-canvas.js';
import { CHIP_FIRE_LIFETIME_MS } from './chip-fire-layout.js';

class TrackingCtx {
  calls: { method: string; args: unknown[]; alpha?: number; comp?: GlobalCompositeOperation }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  drawImage(...args: unknown[]): void {
    this.calls.push({
      method: 'drawImage',
      args,
      alpha: this.globalAlpha,
      comp: this.globalCompositeOperation,
    });
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ method: 'fillRect', args });
  }
  fillText(...args: unknown[]): void {
    this.calls.push({ method: 'fillText', args });
  }
  beginPath(): void {
    this.calls.push({ method: 'beginPath', args: [] });
  }
  arc(...args: unknown[]): void {
    this.calls.push({ method: 'arc', args, alpha: this.globalAlpha });
  }
  fill(): void {
    this.calls.push({ method: 'fill', args: [] });
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

describe('ChipFireCanvas — fallback path', () => {
  it('paints a circle when no asset is loaded for the lane', () => {
    const cf = new ChipFireCanvas();
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    cf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 200, judgeLineY: 600 });
    const arc = ctx.calls.find((c) => c.method === 'arc');
    expect(arc).toBeDefined();
  });

  it('skips lanes that were never hit', () => {
    const cf = new ChipFireCanvas();
    cf.paint(ctx2d(), { lastPadHitMs: new Map(), nowMs: 200, judgeLineY: 600 });
    expect(ctx.calls.some((c) => c.method === 'arc' || c.method === 'drawImage')).toBe(false);
  });

  it('skips expired bursts', () => {
    const cf = new ChipFireCanvas();
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    cf.paint(ctx2d(), {
      lastPadHitMs: lastHits,
      nowMs: 100 + CHIP_FIRE_LIFETIME_MS + 50,
      judgeLineY: 600,
    });
    expect(ctx.calls.some((c) => c.method === 'arc' || c.method === 'drawImage')).toBe(false);
  });
});

describe('ChipFireCanvas — sprite path', () => {
  it('uses drawImage with default source-over composite when asset is present', () => {
    const cf = new ChipFireCanvas();
    const fakeImage = {
      complete: true,
      naturalWidth: 128,
      naturalHeight: 128,
      width: 128,
      height: 128,
    } as unknown as HTMLImageElement;
    cf.internal_setAssetForLane(Lane.SD, fakeImage);
    const lastHits = new Map<LaneValue, number>([[Lane.SD, 100]]);
    cf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 200, judgeLineY: 600 });
    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws.length).toBe(1);
    // Honour the PNG's own alpha cut — additive `lighter` paints
    // square opaque halos on busy backgrounds (regression caught in
    // the first CF Pages preview).
    expect(draws[0]!.comp).toBe('source-over');
  });
});

describe('ChipFireCanvas — multi-lane', () => {
  it('paints one burst per active lane', () => {
    const cf = new ChipFireCanvas();
    const lastHits = new Map<LaneValue, number>([
      [Lane.SD, 100],
      [Lane.HH, 100],
      [Lane.BD, 100],
    ]);
    cf.paint(ctx2d(), { lastPadHitMs: lastHits, nowMs: 150, judgeLineY: 600 });
    const fxCalls = ctx.calls.filter((c) => c.method === 'arc' || c.method === 'drawImage');
    expect(fxCalls.length).toBe(3);
  });
});
