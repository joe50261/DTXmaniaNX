/**
 * Chip-fire animations — pure helper for the burst's lifetime
 * envelope. Mirrors `chip-fire-design.md`'s "Animation" section.
 *
 * No THREE / DOM imports. Co-terminal scale-up + alpha-fade so the
 * burst reads as a single envelope rather than two separate beats.
 */

import {
  CHIP_FIRE_END_SCALE,
  CHIP_FIRE_LIFETIME_MS,
} from './chip-fire-layout.js';

export interface ChipFireFrame {
  /** True when the burst is past its lifetime — caller skips the draw. */
  expired: boolean;
  /** 0..1 progress through the lifetime. */
  progress: number;
  /** 1.0 → CHIP_FIRE_END_SCALE — multiplier applied to both axes. */
  scale: number;
  /** 1.0 → 0 — alpha applied to the sprite. */
  alpha: number;
}

/**
 * Resolve the chip-fire envelope at `nowMs` given the timestamp of
 * the most recent hit in this lane. Returns `expired: true` if the
 * burst is no longer visible.
 */
export function chipFireFrame(nowMs: number, lastHitMs: number): ChipFireFrame {
  const t = nowMs - lastHitMs;
  if (!Number.isFinite(t) || t < 0 || t >= CHIP_FIRE_LIFETIME_MS) {
    return { expired: true, progress: 1, scale: CHIP_FIRE_END_SCALE, alpha: 0 };
  }
  const progress = t / CHIP_FIRE_LIFETIME_MS;
  const scale = 1 + (CHIP_FIRE_END_SCALE - 1) * progress;
  const alpha = 1 - progress;
  return { expired: false, progress, scale, alpha };
}
