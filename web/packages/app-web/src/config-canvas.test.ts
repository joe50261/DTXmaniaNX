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
