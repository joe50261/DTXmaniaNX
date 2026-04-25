import type { PadSpec, Vec3 } from './kit-preset.js';

/**
 * Tilted-pad strike detection.
 *
 * The previous implementation tested for a horizontal plane crossing
 * at `pad.y` — fine for flat pads, but for an arcade-tilted ride
 * (~65°) the player's stick travels along a steep arc that intersects
 * the visual disc face well before its centre Y, so flat-plane checks
 * misfire. Arcade GITADORA's snare is tilted ~18°, toms ~45°, ride
 * ~65°; without normal-aware detection the rest of this PR (preset
 * sizes & angles) wouldn't actually feel right.
 *
 * Pure functions only — no Three.js, no state. The caller (xr-
 * controllers.ts) supplies plain `{x,y,z}` sample positions captured
 * from the controller grip-relative offsets and gets back either a
 * hit descriptor (with the world-space crossing point and the inward
 * normal-component speed) or null.
 *
 * Geometry note. PlaneGeometry created in xr-controllers does:
 *
 *   geom.rotateX(-π/2)      // face up (+Y normal)
 *   geom.rotateX(+tiltRad)  // tilt front edge toward player (+Z)
 *
 * After both rotations the pad-face normal in world space is
 *   N = (0, cos t, sin t),
 * the in-plane "u" axis (originally +X) is unchanged at (1, 0, 0),
 * and the in-plane "v" axis (originally +Y of the plane, pointing
 * away from the player after the first rotation) is
 *   V = (0, sin t, -cos t).
 * `padNormal()` and `padTangentV()` exposed below return these so
 * the renderer and tests can share the same geometry contract.
 */

/** Minimum downward-into-pad speed (m/s) needed to register a hit.
 *  Same value the old horizontal-plane detector used; tuned by feel
 *  (slow practice taps still register, idle hand-drift doesn't). */
export const HIT_VELOCITY_THRESHOLD_MPS = 1.0;

/** BD's hit zone is a square half-width — the kick face is large but
 *  the foot-pedal abstraction means we want a generous strike zone so
 *  players don't have to aim for a small target while their attention
 *  is on the chart. Square (not circular) on purpose: the visual is a
 *  flat face but the hit happens on an imaginary horizontal pane
 *  above it, where a square is more lenient than a same-radius
 *  circle. */
export const BD_HIT_HALF_M = 0.25;

/** LP's hit zone follows the same foot-pedal-abstraction reasoning as
 *  BD: the visual is small (size 0.18 → ±0.09 m) because it represents
 *  a real left pedal, but Quest has no foot tracking so the player
 *  taps it from above with a stick while watching the chart. A 9 cm
 *  square would be far harder than the 25 cm BD zone — the asymmetry
 *  was a real bug, players were missing LP hits while landing BD
 *  reliably. 0.18 m (~half the BD zone, generous but smaller because
 *  LP fires less often and is closer to surrounding pads) lands in a
 *  middle ground. */
export const PEDAL_HIT_HALF_M = 0.18;

export interface HitDetectInput {
  /** Sample position last frame, world space. */
  prev: Vec3;
  /** Sample position this frame, world space. */
  curr: Vec3;
  /** Frame delta in seconds. Caller is responsible for skipping
   *  pathological frames (dt ≤ 0 or > ~0.1 s); this function trusts
   *  whatever it's given. */
  dtSec: number;
}

export interface HitResult {
  /** World-space point where the sample crossed the pad face. */
  hit: Vec3;
  /** Speed component along -N at the crossing — i.e. how fast the
   *  sample was moving INTO the pad. Always > 0 for a valid hit;
   *  exposed so the caller could later modulate haptic strength. */
  speedIntoPad: number;
}

/** World-space normal of a pad with `tiltDeg` rotation around X.
 *  Points "up and toward the player" (+Y, +Z). */
export function padNormal(tiltDeg: number): Vec3 {
  const t = (tiltDeg * Math.PI) / 180;
  return { x: 0, y: Math.cos(t), z: Math.sin(t) };
}

/** In-plane "v" axis of a pad with `tiltDeg`. Points "up and away
 *  from the player" (+Y, -Z) for positive tilts; reduces to +Y when
 *  tilt is 90°. The in-plane "u" axis is always world +X, so isn't
 *  exposed as a function. */
export function padTangentV(tiltDeg: number): Vec3 {
  const t = (tiltDeg * Math.PI) / 180;
  return { x: 0, y: Math.sin(t), z: -Math.cos(t) };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Test a single sample's prev→curr segment against one pad. Returns
 *  null if the sample didn't cross the pad face from the +N side this
 *  frame, didn't have enough inward speed, or landed outside the
 *  footprint. Otherwise returns the world-space crossing point and
 *  the inward speed component. */
export function detectPadHit(
  input: HitDetectInput,
  pad: Pick<PadSpec, 'position' | 'size' | 'tiltDeg' | 'shape'>,
  threshold: number = HIT_VELOCITY_THRESHOLD_MPS,
): HitResult | null {
  const { prev, curr, dtSec } = input;
  // `!(dtSec > 0)` instead of `dtSec <= 0` so NaN rejects too — a
  // pathological frame with a NaN delta would otherwise fall through
  // and rely on every downstream comparison short-circuiting to false
  // by accident.
  if (!(dtSec > 0)) return null;

  // BD is special: visual is a vertical kick face, but hit detection
  // happens on a horizontal plane through pad.y (no foot tracking on
  // Quest, so the player taps the kick from above with a stick).
  // Bypass the tilt math entirely; the +N branch below would still
  // work for tiltDeg=0 but `face`'s footprint check is square in world
  // (x,z), not pad-local (u,v) — keeping the case explicit avoids any
  // accidental drift if tiltDeg ever gets set on a face pad.
  if (pad.shape === 'face') {
    const padY = pad.position.y;
    const crossed = prev.y > padY && curr.y <= padY;
    if (!crossed) return null;
    const t = (prev.y - padY) / (prev.y - curr.y);
    const hx = prev.x + (curr.x - prev.x) * t;
    const hz = prev.z + (curr.z - prev.z) * t;
    if (Math.abs(hx - pad.position.x) > BD_HIT_HALF_M) return null;
    if (Math.abs(hz - pad.position.z) > BD_HIT_HALF_M) return null;
    const vy = (curr.y - prev.y) / dtSec;
    if (vy > -threshold) return null;
    return {
      hit: { x: hx, y: padY, z: hz },
      speedIntoPad: -vy,
    };
  }

  const N = padNormal(pad.tiltDeg);
  const rel0 = sub(prev, pad.position);
  const rel1 = sub(curr, pad.position);
  const d0 = dot(rel0, N);
  const d1 = dot(rel1, N);

  // Crossed from +N side ("above" the pad face) to ≤0 side this
  // frame. Equality at d1 = 0 counts as a crossing — exactly grazing
  // the surface still fires.
  if (d0 <= 0 || d1 > 0) return null;

  // Inward speed = component of velocity along -N. We need this
  // ≥ threshold so a slow drift through the surface doesn't register
  // as a strike.
  const v: Vec3 = {
    x: (curr.x - prev.x) / dtSec,
    y: (curr.y - prev.y) / dtSec,
    z: (curr.z - prev.z) / dtSec,
  };
  const speedIntoPad = -dot(v, N);
  if (speedIntoPad < threshold) return null;

  // Linear interpolation along the segment to the crossing point in
  // world space. d0 > 0 ≥ d1 guarantees the denominator is non-zero.
  const t = d0 / (d0 - d1);
  const hit: Vec3 = {
    x: prev.x + (curr.x - prev.x) * t,
    y: prev.y + (curr.y - prev.y) * t,
    z: prev.z + (curr.z - prev.z) * t,
  };

  // Footprint check in pad-local (u, v). u is world +X; v is the
  // in-plane axis pointing up-and-away from the player. Square
  // footprint to match the previous lenient behaviour — tightening
  // to a circle (sqrt(u^2+v^2) ≤ size/2) would cost edge hits and
  // wasn't requested.
  //
  // `pedal` shape (LP) gets an enlarged generous zone — same
  // foot-pedal-abstraction reasoning as BD's `face` branch above.
  // See PEDAL_HIT_HALF_M's comment for the rationale.
  const half = pad.shape === 'pedal' ? PEDAL_HIT_HALF_M : pad.size / 2;
  const rel = sub(hit, pad.position);
  const u = rel.x;
  const V = padTangentV(pad.tiltDeg);
  const vCoord = dot(rel, V);
  if (Math.abs(u) > half) return null;
  if (Math.abs(vCoord) > half) return null;

  return { hit, speedIntoPad };
}
