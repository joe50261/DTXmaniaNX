import { describe, expect, it, beforeEach } from 'vitest';
import { StageFadeCanvas } from './stage-fade-canvas.js';
import { FADE_DURATION_MS } from './stage-fade-layout.js';

class TrackingCtx {
  calls: { method: string; args: unknown[]; alpha?: number; fillStyle?: unknown }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  drawImage(...args: unknown[]): void {
    this.calls.push({ method: 'drawImage', args, alpha: this.globalAlpha });
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ method: 'fillRect', args, alpha: this.globalAlpha, fillStyle: this.fillStyle });
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

describe('StageFadeCanvas — lifecycle', () => {
  it('isDone is false before start()', () => {
    const f = new StageFadeCanvas();
    expect(f.isDone(0)).toBe(false);
    expect(f.isActive(0)).toBe(false);
  });

  it('isDone flips after the duration', () => {
    const f = new StageFadeCanvas();
    f.start('fade-out-black', 0);
    expect(f.isDone(0)).toBe(false);
    expect(f.isActive(FADE_DURATION_MS - 1)).toBe(true);
    expect(f.isDone(FADE_DURATION_MS)).toBe(true);
    expect(f.isActive(FADE_DURATION_MS)).toBe(false);
  });

  it('start() can override an in-flight fade', () => {
    const f = new StageFadeCanvas();
    f.start('fade-out-black', 0);
    expect(f.internal_currentMode()).toBe('fade-out-black');
    f.start('fade-in-white', 100);
    expect(f.internal_currentMode()).toBe('fade-in-white');
  });
});

describe('StageFadeCanvas — paint without started fade', () => {
  it('does nothing when no fade is active', () => {
    const f = new StageFadeCanvas();
    f.paint(ctx2d(), 0, 1280, 720);
    expect(ctx.calls.length).toBe(0);
  });
});

describe('StageFadeCanvas — paint with no asset (fallback)', () => {
  it('paints a solid rect at the right alpha for fade-out-black', () => {
    const f = new StageFadeCanvas();
    f.start('fade-out-black', 0);
    f.paint(ctx2d(), FADE_DURATION_MS / 2, 1280, 720);
    const rect = ctx.calls.find((c) => c.method === 'fillRect');
    expect(rect).toBeDefined();
    expect(rect!.alpha).toBeCloseTo(0.5);
    expect(rect!.fillStyle).toBe('#000');
  });

  it('switches to white for fade-in-white', () => {
    const f = new StageFadeCanvas();
    f.start('fade-in-white', 0);
    f.paint(ctx2d(), 0, 1280, 720);
    const rect = ctx.calls.find((c) => c.method === 'fillRect');
    expect(rect!.fillStyle).toBe('#fff');
    expect(rect!.alpha).toBe(1);
  });

  it('omits paint at alpha 0 (fade-in finished)', () => {
    const f = new StageFadeCanvas();
    f.start('fade-in-black', 0);
    f.paint(ctx2d(), FADE_DURATION_MS, 1280, 720);
    expect(ctx.calls.some((c) => c.method === 'fillRect' || c.method === 'drawImage')).toBe(false);
  });
});

describe('StageFadeCanvas — paint with stub tile', () => {
  it('tiles the canvas in a 20×12 grid for 1280×720', () => {
    const f = new StageFadeCanvas();
    const fakeTile = {
      complete: true,
      naturalWidth: 64,
      naturalHeight: 64,
      width: 64,
      height: 64,
    } as unknown as HTMLImageElement;
    (f as unknown as { assets: Map<string, HTMLImageElement> }).assets.set(
      'Tile black 64x64.png',
      fakeTile
    );
    f.start('fade-out-black', 0);
    f.paint(ctx2d(), FADE_DURATION_MS / 2, 1280, 720);
    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws.length).toBe(20 * 12);
  });
});
