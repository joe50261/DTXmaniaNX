/**
 * Splash-canvas — shared painter for the four "background + glyph"
 * scenes outside song-select / play / result. Mirrors the C# stages
 * `01.Startup`, `02.Title`, `06.SongLoading`, `09.End`. See
 * `splash-design.md` for the per-scene asset / timing matrix.
 *
 * Architecture matches `result-canvas.ts`:
 *   - host (Renderer / main) owns the 2D context and passes it in
 *   - per-instance asset preload via `Image()` + onerror-resolve
 *   - paint() falls back to a procedural draw when an image is missing
 */

import { skinUrl } from './skin-url.js';
import {
  splashAlpha,
  splashPhase,
  SPLASH_CANVAS_H,
  SPLASH_CANVAS_W,
  type SplashPhaseInfo,
  type SplashTiming,
} from './splash-layout.js';

export interface SplashCanvasOptions {
  /** Background filename in `Runtime/System/Graphics/`. Required. */
  background: string;
  /** Optional foreground glyph painted centred over the background. */
  foreground?: string;
  /** Per-scene timing tuple. */
  timing: SplashTiming;
  /** Procedural fallback fill when `background` is missing. */
  fallbackBackgroundColor?: string;
  /** Optional centred caption painted over the glyph. Useful for
   *  loading scenes ("Loading…"); skipped when undefined. */
  caption?: string;
}

export class SplashCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();
  private readonly bgName: string;
  private readonly fgName: string | null;
  private readonly timing: SplashTiming;
  private readonly fallbackBg: string;
  private readonly caption: string | null;

  /** performance.now() at scene entry. null → not active yet. */
  private startedAtMs: number | null = null;
  /** True once the host calls `requestExit()`. */
  private exitRequested = false;
  /** Timestamp of the exit request, used so a fade-out anchored on
   *  request time still reads correctly even if elapsed surges. */
  private exitRequestedAtMs = 0;

  constructor(opts: SplashCanvasOptions) {
    this.bgName = opts.background;
    this.fgName = opts.foreground ?? null;
    this.timing = opts.timing;
    this.fallbackBg = opts.fallbackBackgroundColor ?? '#0b0f1a';
    this.caption = opts.caption ?? null;
  }

  /** Kick off image loads. Resolve-on-error so a missing skin file
   *  doesn't block the splash from painting at all. */
  async load(): Promise<void> {
    const names = [this.bgName, ...(this.fgName ? [this.fgName] : [])];
    await Promise.all(names.map((n) => this.loadOne(n)));
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.assets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[splash] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Anchor the timing clock to `nowMs`. Call once when the scene
   *  state machine enters this splash. Re-entry resets exit state. */
  start(nowMs: number): void {
    this.startedAtMs = nowMs;
    this.exitRequested = false;
    this.exitRequestedAtMs = 0;
  }

  /** Tell the splash to begin its fade-out. Idempotent — only the
   *  first call latches the request time. */
  requestExit(nowMs: number): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    if (this.startedAtMs !== null) {
      this.exitRequestedAtMs = nowMs - this.startedAtMs;
    }
  }

  /** True once the splash has finished its fade-out and the scene
   *  state machine is safe to advance. */
  isDone(nowMs: number): boolean {
    return this.phase(nowMs).phase === 'done';
  }

  /** Public for tests / host inspection. */
  phase(nowMs: number): SplashPhaseInfo {
    if (this.startedAtMs === null) {
      return { phase: 'fade-in', progress: 0 };
    }
    return splashPhase(
      nowMs - this.startedAtMs,
      this.timing,
      this.exitRequested,
      this.exitRequestedAtMs
    );
  }

  /** Paint into the host's 2D context. No-op when the splash is
   *  done (alpha collapses to 0; the host should also short-circuit
   *  once `isDone()` returns true). */
  paint(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const info = this.phase(nowMs);
    const alpha = splashAlpha(info);
    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    this.paintBackground(ctx);
    this.paintForeground(ctx);
    this.paintCaption(ctx);
    ctx.restore();
  }

  private paintBackground(ctx: CanvasRenderingContext2D): void {
    const bg = this.getAsset(this.bgName);
    if (bg) {
      ctx.drawImage(bg, 0, 0, SPLASH_CANVAS_W, SPLASH_CANVAS_H);
      return;
    }
    ctx.fillStyle = this.fallbackBg;
    ctx.fillRect(0, 0, SPLASH_CANVAS_W, SPLASH_CANVAS_H);
  }

  private paintForeground(ctx: CanvasRenderingContext2D): void {
    if (!this.fgName) return;
    const fg = this.getAsset(this.fgName);
    if (!fg) return;
    const x = (SPLASH_CANVAS_W - fg.naturalWidth) / 2;
    const y = (SPLASH_CANVAS_H - fg.naturalHeight) / 2;
    ctx.drawImage(fg, x, y);
  }

  private paintCaption(ctx: CanvasRenderingContext2D): void {
    if (!this.caption) return;
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.caption, SPLASH_CANVAS_W / 2, SPLASH_CANVAS_H - 60);
  }
}

// --- Pre-baked instances per scene -------------------------------------

/** Convenience constructors so callers don't repeat the per-scene
 *  filename + timing tuples. The host should still call `load()` and
 *  `start(nowMs)` before the first paint. */
export function startupSplash(): SplashCanvas {
  return new SplashCanvas({
    background: '1_background.jpg',
    timing: { fadeInMs: 200, holdMs: 1500, fadeOutMs: 400 },
  });
}

export function titleSplash(): SplashCanvas {
  return new SplashCanvas({
    background: '2_background.jpg',
    foreground: '2_menu.png',
    timing: { fadeInMs: 300, holdMs: Number.POSITIVE_INFINITY, fadeOutMs: 0 },
  });
}

export function loadingSplash(caption: string = 'Loading…'): SplashCanvas {
  return new SplashCanvas({
    background: '6_background.jpg',
    foreground: '6_FadeOut.jpg',
    timing: { fadeInMs: 0, holdMs: Number.POSITIVE_INFINITY, fadeOutMs: 200 },
    caption,
  });
}

export function endSplash(): SplashCanvas {
  return new SplashCanvas({
    background: '9_background.jpg',
    timing: { fadeInMs: 0, holdMs: 800, fadeOutMs: 400 },
  });
}
