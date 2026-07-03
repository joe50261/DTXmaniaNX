/**
 * Broadcast camera for the replay-video render — pure model.
 *
 * The render (`render.ts`) frames a fixed "above-and-behind" broadcast angle
 * looking down at the VR drum kit with the note-highway panel floating behind
 * it. This module owns the camera's numbers and the pure projection math used
 * to *prove* the framing, so the choice can be unit-tested without a WebGL
 * context (per the repo's "test the model, not the view" rule). `render.ts`
 * builds a `THREE.PerspectiveCamera` from `BROADCAST_CAMERA`; it holds no
 * framing logic of its own.
 *
 * ## Why 70°, not 95° — the black-bar fix
 *
 * `THREE.PerspectiveCamera`'s `fov` is the **vertical** field of view. The
 * first broadcast pass used 95°, which at this camera distance captures a
 * ~6 m-tall slice of the world for a kit that is only ~2.3 m tall — so the
 * subject filled barely half the frame height and the render came out with
 * fat black bars above the highway and below the pedals (reported as
 * "上下有黑邊", black bars top and bottom).
 *
 * Dropping the vertical FOV to 70° and nudging `lookAt` up (1.0 → 1.05) to
 * re-centre the taller-than-16:9 subject fills the frame vertically: the
 * highway sits just under the top edge and the pedals just above the bottom
 * edge (~5 % black top/bottom, down from ~18–24 %), with the whole kit +
 * highway still inside the frame across every kit preset and seat offset.
 * `broadcast-camera-model.test.ts` pins that invariant.
 *
 * The subject is portrait-shaped relative to 16:9, so filling it vertically
 * leaves side pillarbox — that is inherent to keeping the entire kit visible
 * in a landscape frame without cropping content or changing the (approved)
 * angle, and is not something a wider/narrower FOV can remove.
 */

export type Vec3 = readonly [number, number, number];

export interface BroadcastCamera {
  /** VERTICAL field of view, degrees (THREE's `PerspectiveCamera` fov). */
  readonly fovDeg: number;
  /** Eye position, world-space metres. */
  readonly position: Vec3;
  /** Point the camera aims at, world-space metres. */
  readonly lookAt: Vec3;
  readonly near: number;
  readonly far: number;
}

/** The one place the broadcast camera is defined. `render.ts` reads this. */
export const BROADCAST_CAMERA: BroadcastCamera = {
  fovDeg: 70,
  position: [0, 2.2, 0.8],
  lookAt: [0, 1.05, -1.1],
  near: 0.05,
  far: 20,
};

/** 16:9 output aspect the camera is framed for (matches render.ts VIDEO_*). */
export const BROADCAST_ASPECT = 1280 / 720;

/**
 * The note-highway panel the camera must keep fully in-frame. Mirrors
 * `render.ts`, which floats the renderer's 1280×720 playfield HUD scaled by
 * `2.4 / 1280` (→ 2.4 × 1.35 m) at this centre — `render.ts` places the
 * playfield from `PLAYFIELD_PANEL.center` so the two can't drift.
 */
export const PLAYFIELD_PANEL = {
  width: 2.4,
  height: 1.35,
  center: [0, 1.6, -2.0] as Vec3,
};

// ---- pure projection (no three.js; matches THREE.Vector3.project to 1e-15) ----

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Ndc {
  /** Normalised device x; inside the frame ⇔ |x| ≤ 1. */
  x: number;
  /** Normalised device y; inside the frame ⇔ |y| ≤ 1. */
  y: number;
  /** View-space z (negative in front of the camera). */
  viewZ: number;
}

/**
 * Project a world point to normalised device coordinates through the broadcast
 * camera. Replicates THREE's `lookAt` view matrix + symmetric perspective
 * projection; a point is on-screen when `|x| ≤ 1 && |y| ≤ 1 && viewZ < 0`.
 */
export function projectToNdc(
  point: Vec3,
  cam: BroadcastCamera = BROADCAST_CAMERA,
  aspect: number = BROADCAST_ASPECT,
): Ndc {
  // View basis: camera +Z points back toward the eye (THREE convention).
  const zAxis = normalize(sub(cam.position, cam.lookAt));
  const xAxis = normalize(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  const d = sub(point, cam.position);
  const viewX = dot(xAxis, d);
  const viewY = dot(yAxis, d);
  const viewZ = dot(zAxis, d); // < 0 in front of the camera
  const t = Math.tan((cam.fovDeg * Math.PI) / 180 / 2);
  // Guard the degenerate on-plane case so callers never see NaN/Infinity.
  const denom = -viewZ || Number.EPSILON;
  return { x: viewX / (denom * aspect * t), y: viewY / (denom * t), viewZ };
}

export interface Framing {
  /** NDC bounding box of the supplied points. */
  ndc: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** Fraction [0,1] of the frame that is empty on each edge (0 = filled). */
  black: { top: number; bottom: number; left: number; right: number };
  /** True when every point sits inside the frame (nothing clipped). */
  allInFrame: boolean;
}

/**
 * Measure how a set of world points frames through the camera: the NDC
 * bounding box, the empty (black) margin on each edge, and whether anything
 * falls outside the frame. Used by the framing test to assert the broadcast
 * camera keeps the whole kit + highway visible with minimal top/bottom black.
 */
export function computeFraming(
  points: readonly Vec3[],
  cam: BroadcastCamera = BROADCAST_CAMERA,
  aspect: number = BROADCAST_ASPECT,
): Framing {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let allInFrame = true;
  for (const p of points) {
    const n = projectToNdc(p, cam, aspect);
    if (n.viewZ >= 0 || Math.abs(n.x) > 1 || Math.abs(n.y) > 1) allInFrame = false;
    if (n.x < xMin) xMin = n.x;
    if (n.x > xMax) xMax = n.x;
    if (n.y < yMin) yMin = n.y;
    if (n.y > yMax) yMax = n.y;
  }
  return {
    ndc: { xMin, xMax, yMin, yMax },
    black: {
      top: (1 - yMax) / 2,
      bottom: (1 + yMin) / 2,
      left: (1 + xMin) / 2,
      right: (1 - xMax) / 2,
    },
    allInFrame,
  };
}
