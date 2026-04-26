/**
 * Stage-fade canvas — paints the FIFO black/white tile fade used
 * at every scene transition. Mirrors `CActFIFOBlack` /
 * `CActFIFOWhite` from `DTXMania/Code/Stage/`.
 *
 * Shared painter pattern: host owns the 2D context; this class
 * owns asset preload + draw logic. Tile loading is lazy — both
 * tiles are tiny (64×64 PNGs), so we pull them at construction.
 */

import { skinUrl } from './skin-url.js';
import {
  fadeAlpha,
  fadeAsset,
  FADE_TILE_H,
  FADE_TILE_W,
  isFadeDone,
  isFadeOutMode,
  tileGridSize,
  type FadeMode,
} from './stage-fade-layout.js';

const ASSET_BLACK = 'Tile black 64x64.png';
const ASSET_WHITE = 'Tile white 64x64.png';

export class StageFadeCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();
  private mode: FadeMode | null = null;
  private startedAtMs: number | null = null;

  async load(): Promise<void> {
    await Promise.all([this.loadOne(ASSET_BLACK), this.loadOne(ASSET_WHITE)]);
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.assets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[stage-fade] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Begin a fade. Re-calling overrides any in-flight fade. */
  start(mode: FadeMode, nowMs: number): void {
    this.mode = mode;
    this.startedAtMs = nowMs;
  }

  /** True once the active fade has reached its end alpha. False if
   *  no fade is active. The host should advance the scene state
   *  when this returns true after a fade-out. */
  isDone(nowMs: number): boolean {
    if (this.startedAtMs === null) return false;
    return isFadeDone(nowMs - this.startedAtMs);
  }

  /** Whether the fade is currently active (started, not finished). */
  isActive(nowMs: number): boolean {
    return this.mode !== null && !this.isDone(nowMs);
  }

  /** Paint one frame of the fade. No-op when no fade is active or
   *  the mode/start are null. */
  paint(
    ctx: CanvasRenderingContext2D,
    nowMs: number,
    canvasW: number,
    canvasH: number
  ): void {
    if (this.mode === null || this.startedAtMs === null) return;
    const elapsed = nowMs - this.startedAtMs;
    const alpha = fadeAlpha(elapsed, this.mode);
    if (alpha <= 0) return;

    const tile = this.getAsset(fadeAsset(this.mode));
    const grid = tileGridSize(canvasW, canvasH);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (tile) {
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          ctx.drawImage(tile, c * FADE_TILE_W, r * FADE_TILE_H);
        }
      }
    } else {
      // Fallback: solid rect in the same colour the tile would
      // have provided. Visually identical to the C# code's
      // tDraw2D loop on a solid-colour tile.
      ctx.fillStyle = isFadeOutMode(this.mode) || this.mode.endsWith('black')
        ? '#000'
        : '#fff';
      ctx.fillRect(0, 0, canvasW, canvasH);
    }
    ctx.restore();
  }

  /** Test-only — current mode for assertions. */
  internal_currentMode(): FadeMode | null {
    return this.mode;
  }
}
