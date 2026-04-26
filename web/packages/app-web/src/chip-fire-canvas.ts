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
      // Additive blend (`'lighter'`) is mandatory here — the C#
      // game flags this texture family with `bAdditiveBlending = true`
      // (`CActPerfDrumsChipFireD.cs:510`), and the source PNGs are
      // authored as **full 128×128 black backgrounds with the burst
      // colour painted on top** (sampled corner pixels = (0,0,0,255)).
      // With plain `source-over` those black corners would draw as
      // opaque black squares around every burst — the visible
      // regression in the second CF Pages preview ("hit sprite
      // 黑底"). `lighter` adds RGB to the destination, so black
      // (0,0,0) contributes nothing and only the burst colour shows.
      ctx.globalCompositeOperation = 'lighter';
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
