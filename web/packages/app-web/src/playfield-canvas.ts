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
  PARET_ASSET,
  PARET_LANE_SLICE,
  PARET_SRC_H,
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
   * Kick off image loads for every unique lane-flush filename plus
   * the lane-chrome (`7_Paret.png`). Resolve-on-error so a missing
   * skin file doesn't block the rest.
   */
  async load(): Promise<void> {
    await Promise.all([
      ...LANE_FLUSH_FORWARD_FILES.map((n) => this.loadOne(n)),
      this.loadOne(PARET_ASSET),
    ]);
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
   * Paint the lane chrome (permanent `7_Paret.png` per-lane slices
   * including the BD/LP footprint pattern) followed by the lane
   * flush overlays. Chrome paints first so the flush streaks
   * overlay it on hit; the chrome is *always* drawn regardless of
   * hit state, matching `CActPerfDrumsLaneFlushD.OnUpdateAndDraw`.
   *
   * Lanes with no recent hit (`lastHitMs` absent or stale) are
   * skipped for the flush only — chrome still paints for them.
   */
  paint(ctx: CanvasRenderingContext2D, input: PlayfieldRenderInput): void {
    this.paintLaneChrome(ctx, input.canvasH);
    for (const spec of LANE_LAYOUT) {
      const last = input.lastPadHitMs.get(spec.lane);
      if (last === undefined) continue;
      const frame = laneFlushFrame(input.nowMs, last, input.canvasH);
      if (frame.expired) continue;
      this.paintLaneFlush(ctx, spec, frame.y, frame.alpha, frame.frame);
    }
  }

  /**
   * Paint the canonical `7_Paret.png` lane background — vertical
   * separator strips per lane, with the BD / LP slices containing
   * the stamped-footprint motif that DTXMania has always shown on
   * the foot-pedal lanes (the user's `lane 本身就常駐的腳印` from
   * the second-round preview review).
   *
   * Each slice is cropped from `7_Paret.png` per
   * `PARET_LANE_SLICE` (pinned to `CActPerfDrumsLaneFlushD.cs:189-298`)
   * and pasted at the lane centre on the canvas. Slices are drawn
   * at native source size — they may extend a few px into adjacent
   * lanes, which is the canonical look (the visible motif inside
   * each slice is centred narrower than the bounding box).
   *
   * Skipped silently when `7_Paret.png` is absent — the lane
   * fills + colored separators in `renderer.drawLanes` keep the
   * playfield readable.
   */
  private paintLaneChrome(ctx: CanvasRenderingContext2D, canvasH: number): void {
    const tex = this.getAsset(PARET_ASSET);
    if (!tex) return;
    for (const spec of LANE_LAYOUT) {
      const slice = PARET_LANE_SLICE[spec.lane];
      if (!slice) continue;
      // Centre each slice on the lane centre — paint at native source
      // width so the canonical visual proportions are preserved.
      const cx = spec.x + spec.width / 2;
      const dx = cx - slice.sw / 2;
      ctx.drawImage(
        tex,
        slice.sx, 0, slice.sw, PARET_SRC_H,
        dx, 0, slice.sw, canvasH
      );
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
