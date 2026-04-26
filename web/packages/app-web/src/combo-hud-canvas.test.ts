import { describe, expect, it, beforeEach } from 'vitest';
import { ComboHudCanvas, type ComboHudRenderInput } from './combo-hud-canvas.js';
import { DANGER_THRESHOLD } from './combo-hud-layout.js';

class TrackingCtx {
  calls: { method: string; args: unknown[]; alpha?: number }[] = [];
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

const input = (over: Partial<ComboHudRenderInput> = {}): ComboHudRenderInput => ({
  combo: 0,
  gauge: 1,
  judgeLineY: 600,
  canvasW: 1280,
  canvasH: 720,
  nowMs: 0,
  ...over,
});

beforeEach(() => {
  ctx = new TrackingCtx();
});

describe('ComboHudCanvas — combo display', () => {
  it('skips paint when combo is 0', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ combo: 0 }));
    expect(ctx.calls.some((x) => x.method === 'fillText')).toBe(false);
  });

  it('paints fallback text + COMBO label when no asset is loaded', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ combo: 125 }));
    const fillTexts = ctx.calls.filter((x) => x.method === 'fillText');
    expect(fillTexts.length).toBe(2);
    expect(fillTexts[0]!.args[0]).toBe('125');
    expect(fillTexts[1]!.args[0]).toBe('COMBO');
  });

  it('renders "999+" overflow tag when combo > 999', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ combo: 1500 }));
    const fillTexts = ctx.calls.filter((x) => x.method === 'fillText');
    expect(fillTexts[0]!.args[0]).toBe('999+');
  });
});

describe('ComboHudCanvas — danger overlay', () => {
  it('draws nothing when gauge is healthy', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ combo: 0, gauge: 0.8 }));
    expect(ctx.calls.some((x) => x.method === 'fillRect')).toBe(false);
  });

  it('draws a red overlay when gauge ≤ threshold', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ combo: 0, gauge: 0.1, nowMs: 0 }));
    const fillRects = ctx.calls.filter((x) => x.method === 'fillRect');
    expect(fillRects.length).toBe(1);
    expect(fillRects[0]!.alpha).toBeGreaterThan(0);
  });

  it('threshold boundary draws nothing (strictly above is safe)', () => {
    const c = new ComboHudCanvas();
    c.paint(ctx2d(), input({ gauge: DANGER_THRESHOLD + 0.001 }));
    expect(ctx.calls.some((x) => x.method === 'fillRect')).toBe(false);
  });
});

describe('ComboHudCanvas — sprite path', () => {
  it('draws the per-digit slice + COMBO label when asset is registered', () => {
    const c = new ComboHudCanvas();
    const fakeImage = {
      complete: true,
      naturalWidth: 600,
      naturalHeight: 380,
      width: 600,
      height: 380,
    } as unknown as HTMLImageElement;
    // Stub by injecting straight into the private map via a
    // workaround — we use the same-shape getAsset through paint by
    // pre-populating via a direct cast.
    (c as unknown as { assets: Map<string, HTMLImageElement> }).assets.set(
      'ScreenPlayDrums combo.png',
      fakeImage
    );
    c.paint(ctx2d(), input({ combo: 42 }));
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    // 2 digits + COMBO label = 3 draws.
    expect(draws.length).toBe(3);
  });
});
