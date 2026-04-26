import { describe, expect, it, beforeEach } from 'vitest';
import {
  endSplash,
  loadingSplash,
  SplashCanvas,
  startupSplash,
  titleSplash,
} from './splash-canvas.js';

class TrackingCtx {
  calls: { method: string; args: unknown[] }[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';

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

let ctx: TrackingCtx;
const ctx2d = (): CanvasRenderingContext2D => ctx as unknown as CanvasRenderingContext2D;

beforeEach(() => {
  ctx = new TrackingCtx();
});

describe('SplashCanvas — paint with no loaded assets', () => {
  it('falls back to fillRect for the background', () => {
    const splash = new SplashCanvas({
      background: 'nonexistent.jpg',
      timing: { fadeInMs: 0, holdMs: 1000, fadeOutMs: 0 },
      fallbackBackgroundColor: '#000033',
    });
    splash.start(0);
    splash.paint(ctx2d(), 100);
    const bg = ctx.calls.find((c) => c.method === 'fillRect');
    expect(bg).toBeDefined();
  });

  it('skips the foreground draw when no asset loaded', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      foreground: 'fg.png',
      timing: { fadeInMs: 0, holdMs: 1000, fadeOutMs: 0 },
    });
    splash.start(0);
    splash.paint(ctx2d(), 100);
    // No drawImage at all, since neither asset is loaded.
    expect(ctx.calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('paints the optional caption when set', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 0, holdMs: 1000, fadeOutMs: 0 },
      caption: 'Loading…',
    });
    splash.start(0);
    splash.paint(ctx2d(), 100);
    expect(ctx.calls.some((c) => c.method === 'fillText' && c.args[0] === 'Loading…')).toBe(true);
  });

  it('omits paint entirely when alpha is 0 (fade-out done)', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 0, holdMs: 100, fadeOutMs: 100 },
    });
    splash.start(0);
    splash.paint(ctx2d(), 1000); // way past the auto-exit window
    expect(ctx.calls.length).toBe(0);
  });
});

describe('SplashCanvas — exit lifecycle', () => {
  it('latches the exit request and reports done after fade-out', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 0, holdMs: Number.POSITIVE_INFINITY, fadeOutMs: 100 },
    });
    splash.start(0);
    expect(splash.isDone(50)).toBe(false);
    splash.requestExit(200);
    expect(splash.isDone(250)).toBe(false);
    expect(splash.isDone(300)).toBe(true);
  });

  it('idempotent requestExit — second call does not re-anchor the fade', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 0, holdMs: Number.POSITIVE_INFINITY, fadeOutMs: 100 },
    });
    splash.start(0);
    splash.requestExit(200);
    splash.requestExit(500);
    // Fade should have started at 200 and finished by 300.
    expect(splash.isDone(300)).toBe(true);
  });

  it('re-entering the scene resets the exit state', () => {
    const splash = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 0, holdMs: Number.POSITIVE_INFINITY, fadeOutMs: 100 },
    });
    splash.start(0);
    splash.requestExit(50);
    expect(splash.isDone(200)).toBe(true);
    splash.start(1000);
    expect(splash.isDone(1010)).toBe(false);
  });
});

describe('SplashCanvas — pre-baked constructors', () => {
  it('startup uses 1_background.jpg', () => {
    const s = startupSplash();
    expect(s).toBeInstanceOf(SplashCanvas);
  });
  it('title uses 2_background.jpg + 2_menu.png', () => {
    const s = titleSplash();
    expect(s).toBeInstanceOf(SplashCanvas);
  });
  it('loading takes a caption parameter', () => {
    const s = loadingSplash('Custom caption');
    s.start(0);
    s.paint(ctx2d(), 50);
    expect(ctx.calls.some((c) => c.method === 'fillText' && c.args[0] === 'Custom caption')).toBe(true);
  });
  it('end uses 9_background.jpg with auto-exit', () => {
    const s = endSplash();
    s.start(0);
    expect(s.isDone(0)).toBe(false);
    expect(s.isDone(800 + 400 + 1)).toBe(true);
  });
});

describe('SplashCanvas — hold phase before start()', () => {
  it('reports fade-in/0 if paint is called before start', () => {
    const s = new SplashCanvas({
      background: 'bg.jpg',
      timing: { fadeInMs: 100, holdMs: 100, fadeOutMs: 100 },
    });
    expect(s.phase(0).phase).toBe('fade-in');
    expect(s.phase(0).progress).toBe(0);
  });
});
