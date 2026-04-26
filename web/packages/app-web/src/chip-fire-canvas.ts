/**
 * Chip-fire canvas — paints the per-lane fire burst (07.Performance
 * sub-cluster). Same shared-painter pattern as
 * `playfield-canvas.ts`: host owns the 2D context, this class owns
 * asset preload + draw logic.
 *
 * Trigger: `RenderState.lastPadHitMs[lane]` ticking forward, same
 * edge that drives the lane-flush. Drawn ON TOP of the lane flush
 * so the burst pops above the streak.
 */

import type { LaneValue } from '@dtxmania/input';
import { LANE_LAYOUT, type LaneSpec } from './lane-layout.js';
import { chipFireFrame } from './chip-fire-animations.js';
import {
  CHIP_FIRE_ASSET,
  CHIP_FIRE_FILES,
  CHIP_FIRE_SPRITE_H,
  CHIP_FIRE_SPRITE_W,
} from './chip-fire-layout.js';
import { skinUrl } from './skin-url.js';

export interface ChipFireRenderInput {
  /** performance.now() at the latest hit per lane. */
  lastPadHitMs: ReadonlyMap<LaneValue, number>;
  /** Current performance.now() — animation clock. */
  nowMs: number;
  /** Y of the judge line on the canvas — bursts centre on this row. */
  judgeLineY: number;
}

export class ChipFireCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();
  private readonly laneToAsset = new Map<LaneValue, HTMLImageElement | null>();

  async load(): Promise<void> {
    await Promise.all(CHIP_FIRE_FILES.map((n) => this.loadOne(n)));
    for (const spec of LANE_LAYOUT) {
      const name = CHIP_FIRE_ASSET[spec.lane] ?? null;
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
        console.warn('[chip-fire] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  paint(ctx: CanvasRenderingContext2D, input: ChipFireRenderInput): void {
    for (const spec of LANE_LAYOUT) {
      const last = input.lastPadHitMs.get(spec.lane);
      if (last === undefined) continue;
      const frame = chipFireFrame(input.nowMs, last);
      if (frame.expired) continue;
      this.paintBurst(ctx, spec, input.judgeLineY, frame.scale, frame.alpha);
    }
  }

  private paintBurst(
    ctx: CanvasRenderingContext2D,
    spec: LaneSpec,
    judgeLineY: number,
    scale: number,
    alpha: number
  ): void {
    const asset = this.laneToAsset.get(spec.lane);
    const cx = spec.x + spec.width / 2;
    const drawW = CHIP_FIRE_SPRITE_W * scale;
    const drawH = CHIP_FIRE_SPRITE_H * scale;
    const dx = cx - drawW / 2;
    const dy = judgeLineY - drawH / 2;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (asset) {
      // Plain `source-over` — the per-lane chip-fire PNGs already
      // ship with their own alpha channel cut around the burst
      // shape. The previous `'lighter'` (additive) path looked
      // correct on a black background but produced opaque-looking
      // square halos on the busy 7_background.jpg because additive
      // blend ignores the source alpha and just adds RGB. Honour
      // the canonical alpha cut instead.
      ctx.drawImage(asset, dx, dy, drawW, drawH);
    } else {
      // Procedural fallback: a coloured circle that matches the
      // lane's brand colour. Sized by the same scale envelope so the
      // skinless mode still telegraphs a hit.
      ctx.fillStyle = spec.color;
      ctx.beginPath();
      ctx.arc(cx, judgeLineY, drawW / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Test-only hook — exposes the resolved per-lane asset cache. */
  internal_setAssetForLane(lane: LaneValue, img: HTMLImageElement | null): void {
    this.laneToAsset.set(lane, img);
  }
}
