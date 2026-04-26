/**
 * Playfield-canvas — paints the lane-flush overlay (07.Performance
 * sub-cluster). Mirrors the shared painter pattern from
 * `result-canvas.ts` / `splash-canvas.ts`: host owns the 2D
 * context, the canvas owns asset preload + draw logic.
 *
 * Currently scope-limited to lane flush. The 3D pad meshes and chip
 * atlas remain in `renderer.ts`; a follow-up will fold them in so
 * the whole 07 playfield lives behind one entry.
 */

import type { LaneValue } from '@dtxmania/input';
import { LANE_LAYOUT, type LaneSpec } from './lane-layout.js';
import {
  flushFrameIndex,
  laneFlushFrame,
} from './playfield-animations.js';
import {
  LANE_FLUSH_ASSET_FORWARD,
  LANE_FLUSH_FORWARD_FILES,
  LANE_FLUSH_FRAME_COUNT,
  LANE_FLUSH_FRAME_H,
  LANE_FLUSH_FRAME_W,
} from './playfield-layout.js';
import { skinUrl } from './skin-url.js';

export interface PlayfieldRenderInput {
  /** performance.now() at the latest hit per lane. Same semantics
   *  as `RenderState.lastPadHitMs` so the renderer can pass through. */
  lastPadHitMs: ReadonlyMap<LaneValue, number>;
  /** Current performance.now() — animation clock. */
  nowMs: number;
  /** Canvas height (`CANVAS_H`) for the streak's y-rise math. */
  canvasH: number;
}

export class PlayfieldCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();
  /** Per-lane resolved asset reference. Cached so paint() doesn't
   *  do a Map lookup per lane every frame. */
  private readonly laneToAsset = new Map<LaneValue, HTMLImageElement | null>();

  /**
   * Kick off image loads for every unique lane-flush filename.
   * Resolve-on-error so a missing skin file doesn't block the rest.
   */
  async load(): Promise<void> {
    await Promise.all(LANE_FLUSH_FORWARD_FILES.map((n) => this.loadOne(n)));
    // Resolve per-lane cache after every fetch settles.
    for (const spec of LANE_LAYOUT) {
      const name = LANE_FLUSH_ASSET_FORWARD[spec.lane] ?? null;
      this.laneToAsset.set(spec.lane, name ? this.getAsset(name) : null);
    }
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.assets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[playfield] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * Paint every active lane's flush overlay onto the host's 2D
   * context. Lanes with no recent hit (`lastHitMs` absent or stale)
   * are skipped. Drawn bottom-up so a still-alive flush from a
   * recent hit overlays an older one in the same lane.
   */
  paint(ctx: CanvasRenderingContext2D, input: PlayfieldRenderInput): void {
    for (const spec of LANE_LAYOUT) {
      const last = input.lastPadHitMs.get(spec.lane);
      if (last === undefined) continue;
      const frame = laneFlushFrame(input.nowMs, last, input.canvasH);
      if (frame.expired) continue;
      this.paintLaneFlush(ctx, spec, frame.y, frame.alpha, frame.frame);
    }
  }

  private paintLaneFlush(
    ctx: CanvasRenderingContext2D,
    spec: LaneSpec,
    y: number,
    alpha: number,
    frameIdx: number
  ): void {
    const asset = this.laneToAsset.get(spec.lane);
    const sx = (frameIdx % LANE_FLUSH_FRAME_COUNT) * LANE_FLUSH_FRAME_W;
    const drawW = spec.width;
    const drawH = LANE_FLUSH_FRAME_H;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (asset) {
      // The C# code tiles the streak horizontally if the lane is
      // wider than 42 px (`for (n = 0; n < w; n += 42)`). The web
      // port draws a single stretched copy — visually equivalent at
      // typical lane widths (46-66 px) and avoids 3 drawImage calls
      // per lane per frame.
      ctx.drawImage(
        asset,
        sx, 0, LANE_FLUSH_FRAME_W, LANE_FLUSH_FRAME_H,
        spec.x, y, drawW, drawH
      );
    } else {
      // Procedural fallback: a solid lane-coloured rectangle so the
      // hit still has visual feedback when the asset is missing.
      ctx.fillStyle = spec.color;
      ctx.fillRect(spec.x, y, drawW, drawH);
    }
    ctx.restore();
  }

  /**
   * Test-only hook — exposes the resolved per-lane asset cache so
   * paint behaviour can be asserted on without a real image load.
   * Keeping this `internal_` prefixed signals the contract isn't
   * meant for production callers.
   */
  internal_setAssetForLane(lane: LaneValue, img: HTMLImageElement | null): void {
    this.laneToAsset.set(lane, img);
  }
}

// Re-export for callers that want to compute frame index without
// instantiating the canvas (e.g. unit tests pinning the cycle).
export { flushFrameIndex };
