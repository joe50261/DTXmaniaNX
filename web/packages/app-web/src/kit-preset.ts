import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * Virtual drum-kit presets.
 *
 * The VR drum kit's geometry is tuned per-cabinet so muscle memory built
 * up on one preset transfers cleanly to its real-world counterpart. The
 * primary target is the **GITADORA Galaxy Wave / DELTA** arcade cabinet
 * (white frame, latest generation): pad sizes follow Yamaha DTXPRESS
 * spec (TP-65 ≈ 0.22 m for snare / hi-hat / toms; KCK cymbal pads
 * ≈ 0.28 m; ride ≈ 0.32 m), and tilts follow the cabinet's angled
 * mounting (snare ~18°, toms ~45°, ride ~65°, hi-hat ~35°).
 *
 * Pads are pure data — no Three.js dependency — so this module is
 * unit-testable without a renderer. The consumer (xr-controllers.ts)
 * converts the plain `{x,y,z}` positions into THREE.Vector3 when
 * building scene objects.
 *
 * Y values are world-space metres assuming a sitting drummer on an
 * arcade-height stool. Standing players add a positive `seatYOffset`
 * (config) to lift the whole kit so it sits at hand-comfortable height
 * relative to their hips — without changing any pad-to-pad relative
 * geometry, which is what muscle memory is anchored on.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type PadShape = 'disc' | 'face' | 'pedal';

export interface PadSpec {
  lane: LaneValue;
  /** World-space centre in metres (sitting-drummer reference). */
  position: Vec3;
  /** Disc diameter / pedal side length in metres. */
  size: number;
  /** Tilt towards the player around the world X axis, in degrees.
   *  0 = flat (face up); positive = front edge tilts down toward player. */
  tiltDeg: number;
  shape: PadShape;
  /** If true, render a chrome stand from floor to pad bottom. */
  stand: boolean;
}

export interface KitPreset {
  id: string;
  label: string;
  /** One-line description shown under the preset picker in VR config. */
  description: string;
  pads: readonly PadSpec[];
}

const GITADORA_GALAXY_WAVE: KitPreset = {
  id: 'gitadora-galaxy-wave',
  label: 'GITADORA Galaxy Wave',
  description:
    'Konami arcade — white-frame Galaxy Wave / DELTA. TP-65 / KCK sizes, arcade tilts.',
  pads: [
    { lane: Lane.LC, position: { x: -0.65, y: 1.35, z: -0.60 }, size: 0.28, tiltDeg: 20, shape: 'disc',  stand: true  },
    { lane: Lane.HH, position: { x: -0.50, y: 0.95, z: -0.40 }, size: 0.22, tiltDeg: 35, shape: 'disc',  stand: true  },
    { lane: Lane.LP, position: { x: -0.30, y: 0.20, z: -0.25 }, size: 0.18, tiltDeg:  0, shape: 'pedal', stand: false },
    { lane: Lane.SD, position: { x: -0.15, y: 0.80, z: -0.40 }, size: 0.22, tiltDeg: 18, shape: 'disc',  stand: false },
    { lane: Lane.HT, position: { x: -0.05, y: 1.00, z: -0.60 }, size: 0.22, tiltDeg: 45, shape: 'disc',  stand: false },
    { lane: Lane.BD, position: { x:  0.15, y: 0.35, z: -0.50 }, size: 0.30, tiltDeg:  0, shape: 'face',  stand: false },
    { lane: Lane.LT, position: { x:  0.20, y: 1.00, z: -0.60 }, size: 0.22, tiltDeg: 45, shape: 'disc',  stand: false },
    { lane: Lane.FT, position: { x:  0.50, y: 0.80, z: -0.50 }, size: 0.22, tiltDeg: 30, shape: 'disc',  stand: false },
    { lane: Lane.CY, position: { x:  0.55, y: 1.35, z: -0.70 }, size: 0.28, tiltDeg: 20, shape: 'disc',  stand: true  },
    { lane: Lane.RD, position: { x:  0.75, y: 1.15, z: -0.55 }, size: 0.32, tiltDeg: 65, shape: 'disc',  stand: true  },
  ],
};

const COMPACT_FUSION: KitPreset = {
  id: 'compact',
  label: 'Compact (legacy)',
  description:
    'The original VR layout — closer to a small acoustic fusion kit. Flat pads, drummer-friendly sizes.',
  pads: [
    { lane: Lane.LC, position: { x: -0.65, y: 1.35, z: -0.60 }, size: 0.36, tiltDeg: 10, shape: 'disc',  stand: true  },
    { lane: Lane.HH, position: { x: -0.50, y: 0.95, z: -0.40 }, size: 0.30, tiltDeg:  0, shape: 'disc',  stand: true  },
    { lane: Lane.LP, position: { x: -0.30, y: 0.20, z: -0.25 }, size: 0.18, tiltDeg:  0, shape: 'pedal', stand: false },
    { lane: Lane.SD, position: { x: -0.15, y: 0.80, z: -0.40 }, size: 0.32, tiltDeg:  0, shape: 'disc',  stand: false },
    { lane: Lane.HT, position: { x: -0.05, y: 1.00, z: -0.60 }, size: 0.26, tiltDeg: 10, shape: 'disc',  stand: false },
    { lane: Lane.BD, position: { x:  0.15, y: 0.35, z: -0.50 }, size: 0.50, tiltDeg:  0, shape: 'face',  stand: false },
    { lane: Lane.LT, position: { x:  0.20, y: 1.00, z: -0.60 }, size: 0.26, tiltDeg: 10, shape: 'disc',  stand: false },
    { lane: Lane.FT, position: { x:  0.50, y: 0.80, z: -0.50 }, size: 0.34, tiltDeg:  0, shape: 'disc',  stand: false },
    { lane: Lane.CY, position: { x:  0.55, y: 1.35, z: -0.70 }, size: 0.36, tiltDeg: 10, shape: 'disc',  stand: true  },
    { lane: Lane.RD, position: { x:  0.75, y: 1.15, z: -0.55 }, size: 0.42, tiltDeg:  8, shape: 'disc',  stand: true  },
  ],
};

export const KIT_PRESETS: readonly KitPreset[] = Object.freeze([
  GITADORA_GALAXY_WAVE,
  COMPACT_FUSION,
]);

export const DEFAULT_KIT_PRESET_ID = GITADORA_GALAXY_WAVE.id;

/** Look up a preset by id. Falls back to the default preset if `id` is
 *  unknown — protects against a stale localStorage entry pointing at a
 *  preset id that's been removed in a later release. */
export function getKitPreset(id: string | null | undefined): KitPreset {
  if (id) {
    const found = KIT_PRESETS.find((p) => p.id === id);
    if (found) return found;
  }
  return KIT_PRESETS[0]!;
}

/** Standing-player allowance: how high to lift the whole kit (in
 *  metres) so a player not actually sitting on a stool can still hit
 *  pads at hand-comfortable height. Range chosen to cover children
 *  (negative offset reduces the hop) up to tall standing players
 *  (~+0.55 m raises the kit so the snare ends up around 1.30 m,
 *  matching a tall player's natural hand-resting height). */
export const SEAT_Y_OFFSET_MIN = -0.20;
export const SEAT_Y_OFFSET_MAX = 0.60;
export const SEAT_Y_OFFSET_STEP = 0.05;

/** Quick presets the VR config exposes as one-tap buttons.
 *
 *  STAND default = +0.30 m: lifts the kit so the snare lands at
 *  ~1.10 m world Y, which corresponds (per the standing-elbow-height
 *  ≈ 0.62 × stature anthropometric model) to a ~177 cm player. The
 *  picker labels surface this number so players can sanity-check
 *  before they swing — see seatOffsetToStandingHeightCm() below. */
export const SEAT_Y_OFFSET_SIT = 0;
export const SEAT_Y_OFFSET_STAND = 0.3;

/** Anthropometric model for the standing-height label.
 *
 *  Snare in every preset sits at world Y ≈ 0.80 m (sitting-drummer
 *  reference). For a comfortable standing-drummer posture — forearms
 *  roughly parallel to the ground — the snare wants to land at the
 *  player's elbow-rest height, which empirical anthropometric data
 *  (ISO 7250 / NASA-STD-3000 tables for adults) places at about 62 %
 *  of stature. So
 *
 *    target_snare_y = 0.80 + offset = 0.62 × stature
 *    stature = (0.80 + offset) / 0.62
 *
 *  Constants are exported so the VR slider's reference label and any
 *  future auto-calibrate helper share a single source of truth — and
 *  so the tests can pin the model rather than asserting on a magic
 *  string. */
export const SNARE_REFERENCE_Y_M = 0.80;
export const STANDING_ELBOW_RATIO = 0.62;

/** Apply a uniform Y shift to every pad in the preset, returning a new
 *  array (never mutates input). Used by xr-controllers when building
 *  scene objects so the per-player seat-height adjustment doesn't
 *  contaminate the canonical preset constants. */
export function applySeatYOffset(
  pads: readonly PadSpec[],
  offsetM: number,
): readonly PadSpec[] {
  if (offsetM === 0) return pads;
  return pads.map((p) => ({
    ...p,
    position: { x: p.position.x, y: p.position.y + offsetM, z: p.position.z },
  }));
}

/** Clamp seat offset to the supported range. Exposed so the VR config
 *  slider and any auto-calibrate flow share the same bounds. */
export function clampSeatYOffset(v: number): number {
  if (v < SEAT_Y_OFFSET_MIN) return SEAT_Y_OFFSET_MIN;
  if (v > SEAT_Y_OFFSET_MAX) return SEAT_Y_OFFSET_MAX;
  return v;
}

/** Convert a seat-Y offset into the approximate standing-player
 *  stature it's tuned for, in centimetres. See SNARE_REFERENCE_Y_M /
 *  STANDING_ELBOW_RATIO for the model. Returns null at offset 0 ("Sit
 *  on an arcade stool" — no standing-player height implied) so the
 *  VR config UI can hide the label cleanly in sit mode. */
export function seatOffsetToStandingHeightCm(offsetM: number): number | null {
  if (offsetM === 0) return null;
  const heightM = (SNARE_REFERENCE_Y_M + offsetM) / STANDING_ELBOW_RATIO;
  return Math.round(heightM * 100);
}
