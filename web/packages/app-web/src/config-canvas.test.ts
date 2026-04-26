import { describe, expect, it, beforeEach } from 'vitest';
import { ConfigCanvas } from './config-canvas.js';
import {
  CURSOR_BRACKET_W,
  CURSOR_BRACKET_H,
  MENU_PANEL_X,
  MENU_PANEL_Y,
  HEADER_W,
} from './config-layout.js';

class TrackingCtx {
  calls: { method: string; args: unknown[]; fillStyle?: unknown }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  drawImage(...args: unknown[]): void {
    this.calls.push({ method: 'drawImage', args });
  }
  fillRect(...args: unknown[]): void {
    this.calls.push({ method: 'fillRect', args, fillStyle: this.fillStyle });
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

describe('ConfigCanvas — paintFrame fallback path (no assets)', () => {
  it('paints background + menu-panel + header + footer fallback rects', () => {
    const c = new ConfigCanvas();
    c.paintFrame(ctx2d());
    const fillRects = ctx.calls.filter((x) => x.method === 'fillRect');
    // Background + menu-panel fallback + header + footer = 4 rects.
    expect(fillRects.length).toBe(4);
  });

  it('skipBackground=true omits the background paint', () => {
    const c = new ConfigCanvas();
    c.paintFrame(ctx2d(), { skipBackground: true });
    // 3 rects (menu-panel + header + footer); background skipped.
    expect(ctx.calls.filter((x) => x.method === 'fillRect').length).toBe(3);
  });

  it('skipDescriptionPanel does not affect rect count when no asset is loaded', () => {
    const c = new ConfigCanvas();
    c.paintFrame(ctx2d(), { skipDescriptionPanel: true });
    expect(ctx.calls.filter((x) => x.method === 'fillRect').length).toBe(4);
  });
});

describe('ConfigCanvas — paintCursor fallback', () => {
  it('paints two yellow bracket rects when no asset is loaded', () => {
    const c = new ConfigCanvas();
    c.paintCursor(ctx2d(), { x: 100, y: 200, w: 300 });
    const rects = ctx.calls.filter((x) => x.method === 'fillRect');
    expect(rects.length).toBe(2);
    // First bracket at (100, 200), second at (100 + 300 - 4, 200).
    expect(rects[0]!.args).toEqual([100, 200, 4, CURSOR_BRACKET_H]);
    expect(rects[1]!.args).toEqual([100 + 300 - 4, 200, 4, CURSOR_BRACKET_H]);
  });
});

describe('ConfigCanvas — paintHeaderFooter (custom canvas size)', () => {
  function injectAsset(c: ConfigCanvas, filename: string): void {
    const fakeImage = {
      complete: true,
      naturalWidth: 1280,
      naturalHeight: 105,
      width: 1280,
      height: 105,
    } as unknown as HTMLImageElement;
    (c as unknown as { assets: Map<string, HTMLImageElement> }).assets.set(filename, fakeImage);
  }

  it('paints header at the top scaled to canvas width', () => {
    const c = new ConfigCanvas();
    injectAsset(c, '4_header panel.png');
    c.paintHeaderFooter(ctx2d(), 1024, 1260);
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    // Only the header asset is loaded → exactly one drawImage call.
    expect(draws.length).toBe(1);
    // arg order: img, x, y, w, h. y must be 0; w must be canvas w.
    expect(draws[0]!.args[2]).toBe(0);
    expect(draws[0]!.args[3]).toBe(1024);
  });

  it('paints background stretched to the full canvas at lower alpha', () => {
    const c = new ConfigCanvas();
    const fakeBg = {
      complete: true,
      naturalWidth: 1280,
      naturalHeight: 720,
      width: 1280,
      height: 720,
    } as unknown as HTMLImageElement;
    (c as unknown as { assets: Map<string, HTMLImageElement> }).assets.set('4_background.png', fakeBg);
    c.paintHeaderFooter(ctx2d(), 1024, 1260);
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    expect(draws.length).toBe(1);
    // Stretched to fill the panel — last two args are canvas w / h.
    expect(draws[0]!.args[3]).toBe(1024);
    expect(draws[0]!.args[4]).toBe(1260);
  });

  it('paints footer pinned to the bottom', () => {
    const c = new ConfigCanvas();
    // Footer asset has aspect 1280×30 so scaled to 1024 wide gives ~24 high.
    const fakeFooter = {
      complete: true,
      naturalWidth: 1280,
      naturalHeight: 30,
      width: 1280,
      height: 30,
    } as unknown as HTMLImageElement;
    (c as unknown as { assets: Map<string, HTMLImageElement> }).assets.set('4_footer panel.png', fakeFooter);
    c.paintHeaderFooter(ctx2d(), 1024, 1260);
    const footerDraw = ctx.calls.find((x) => x.method === 'drawImage');
    expect(footerDraw).toBeDefined();
    // y should be canvas-h minus scaled-footer-h (~24).
    const drawY = footerDraw!.args[2] as number;
    expect(drawY).toBeGreaterThan(1230);
    expect(drawY).toBeLessThan(1260);
  });

  it('skips both when no chrome assets loaded', () => {
    const c = new ConfigCanvas();
    c.paintHeaderFooter(ctx2d(), 1024, 1260);
    expect(ctx.calls.filter((x) => x.method === 'drawImage').length).toBe(0);
  });
});

describe('ConfigCanvas — paint with stub assets', () => {
  function injectAsset(c: ConfigCanvas, filename: string): void {
    const fakeImage = {
      complete: true,
      naturalWidth: 64,
      naturalHeight: 64,
      width: 64,
      height: 64,
    } as unknown as HTMLImageElement;
    (c as unknown as { assets: Map<string, HTMLImageElement> }).assets.set(filename, fakeImage);
  }

  it('uses drawImage for the background when present', () => {
    const c = new ConfigCanvas();
    injectAsset(c, '4_background.png');
    c.paintFrame(ctx2d());
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    expect(draws.length).toBe(1);
    // bg drawn at (0, 0, 1280, 720)
    expect(draws[0]!.args).toEqual([expect.anything(), 0, 0, 1280, 720]);
  });

  it('paintCursor uses drawImage twice when menu-cursor asset is present', () => {
    const c = new ConfigCanvas();
    injectAsset(c, '4_menu cursor.png');
    c.paintCursor(ctx2d(), { x: 50, y: 150, w: 200 });
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    expect(draws.length).toBe(2);
  });

  it('paints menu-panel at the canonical (245, 140) when asset is present', () => {
    const c = new ConfigCanvas();
    injectAsset(c, '4_menu panel.png');
    c.paintFrame(ctx2d());
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    const menuPanelDraw = draws.find((d) => d.args[1] === MENU_PANEL_X && d.args[2] === MENU_PANEL_Y);
    expect(menuPanelDraw).toBeDefined();
  });

  it('paints header strip with full canvas width', () => {
    const c = new ConfigCanvas();
    injectAsset(c, '4_header panel.png');
    c.paintFrame(ctx2d());
    const draws = ctx.calls.filter((x) => x.method === 'drawImage');
    const headerDraw = draws.find((d) => d.args[1] === 0 && d.args[2] === 0 && d.args[3] === HEADER_W);
    expect(headerDraw).toBeDefined();
  });
});
