import * as THREE from 'three';
import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * VR virtual drum kit.
 *
 * Ten circular pads are arranged in a semicircle around the player at waist
 * height (see `PAD_POSITIONS`). The Quest 3 Touch Plus controllers are
 * treated as drumsticks — a small sphere at each controller's grip position
 * acts as the stick tip.
 *
 * Hit detection per frame:
 *   - Track each controller's previous and current grip position.
 *   - If vertical velocity is strongly downward (< HIT_VELOCITY_THRESHOLD_MPS)
 *     AND the grip crossed a pad's y plane this frame (was above, now below)
 *     AND the (x, z) projection is inside the pad's bounding circle,
 *     emit a lane-hit event for that pad and pulse the controller haptics.
 *   - Each pad has a short cool-down (`HIT_COOLDOWN_MS`) so a single big
 *     swing doesn't register twice from minor jitter.
 *
 * Button mappings are deliberately gone; the player's physical motion is the
 * input. Falling back to buttons would undo what makes VR feel like drums.
 */

export interface XrLaneEvent {
  lane: LaneValue;
  timestampMs: number;
  /** Synthesised so XR events satisfy the shared LaneHitEvent shape. */
  key: string;
}

export type XrLaneListener = (e: XrLaneEvent) => void;

interface PadLayout {
  lane: LaneValue;
  label: string;
  color: number;
  /** World-space centre in metres relative to the playspace origin. */
  position: THREE.Vector3;
  /** Radius of the pad disc in metres. */
  radius: number;
}

// Laid out in a shallow arc in front of and around the player, seated-like
// drum-kit framing. Coords: x = lateral (right positive), y = height from
// floor, z = forward (negative = away from viewer). Values picked to keep
// everything inside a ~1 m reach from a seated position.
const PAD_POSITIONS: readonly PadLayout[] = [
  // Cymbals high and to the sides
  { lane: Lane.LC, label: 'LC', color: 0xe74c3c, position: new THREE.Vector3(-0.55, 1.25, -0.55), radius: 0.14 },
  { lane: Lane.CY, label: 'CY', color: 0xff6b9d, position: new THREE.Vector3( 0.45, 1.25, -0.65), radius: 0.14 },
  { lane: Lane.RD, label: 'RD', color: 0x7ed6df, position: new THREE.Vector3( 0.70, 1.15, -0.40), radius: 0.14 },
  // HiHat upper-left
  { lane: Lane.HH, label: 'HH', color: 0xf1c40f, position: new THREE.Vector3(-0.40, 1.05, -0.50), radius: 0.12 },
  // Snare + toms at waist in a row
  { lane: Lane.SD, label: 'SD', color: 0xecf0f1, position: new THREE.Vector3(-0.15, 0.95, -0.40), radius: 0.12 },
  { lane: Lane.HT, label: 'HT', color: 0x3498db, position: new THREE.Vector3( 0.10, 1.05, -0.55), radius: 0.11 },
  { lane: Lane.LT, label: 'LT', color: 0x1abc9c, position: new THREE.Vector3( 0.30, 1.00, -0.55), radius: 0.11 },
  { lane: Lane.FT, label: 'FT', color: 0xe67e22, position: new THREE.Vector3( 0.50, 0.90, -0.45), radius: 0.12 },
  // Pedals low (act as kick/LP — player strikes downward from above)
  { lane: Lane.BD, label: 'BD', color: 0x2ecc71, position: new THREE.Vector3( 0.00, 0.30, -0.30), radius: 0.16 },
  { lane: Lane.LP, label: 'LP', color: 0x9b59b6, position: new THREE.Vector3(-0.20, 0.30, -0.30), radius: 0.14 },
];

const HIT_VELOCITY_THRESHOLD_MPS = 1.0;
const HIT_COOLDOWN_MS = 80;

export class XrControllers {
  private listener: XrLaneListener | null = null;
  private readonly addedToScene: THREE.Object3D[] = [];

  /** Previous-frame controller grip positions (metres, world space). */
  private readonly prevPos: (THREE.Vector3 | null)[] = [null, null];
  private prevFrameMs: number | null = null;

  /** Last hit timestamp per pad, to debounce. */
  private readonly lastHitMs = new Map<LaneValue, number>();

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {}

  onHit(cb: XrLaneListener): void {
    this.listener = cb;
  }

  start(): void {
    // Drum pads — double-sided discs laid horizontally so the player can
    // strike from above. Emissive-ish MeshBasicMaterial since we're not
    // lighting the scene.
    for (const pad of PAD_POSITIONS) {
      const geom = new THREE.CircleGeometry(pad.radius, 32);
      geom.rotateX(-Math.PI / 2); // face up
      const mat = new THREE.MeshBasicMaterial({
        color: pad.color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(pad.position);
      this.scene.add(mesh);
      this.addedToScene.push(mesh);

      // Rim ring for depth cue.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(pad.radius * 0.95, pad.radius, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
      );
      ring.position.copy(pad.position);
      ring.position.y += 0.001;
      this.scene.add(ring);
      this.addedToScene.push(ring);
    }

    // Controllers: grip pose + a small sphere as the "stick tip".
    for (let i = 0; i < 2; i++) {
      const grip = this.webgl.xr.getControllerGrip(i);
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      grip.add(tip);
      this.scene.add(grip);
      this.addedToScene.push(grip);
    }
  }

  /** Poll controller motion; call once per frame. */
  tick(): void {
    if (!this.listener) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    const nowMs = performance.now();
    const dtMs = this.prevFrameMs === null ? 0 : nowMs - this.prevFrameMs;
    this.prevFrameMs = nowMs;
    // Skip if dt is obviously bogus (first frame, long pause).
    if (dtMs <= 0 || dtMs > 100) {
      for (let i = 0; i < 2; i++) {
        this.prevPos[i] = this.capturePosition(i);
      }
      return;
    }
    const dtSec = dtMs / 1000;

    for (let i = 0; i < 2; i++) {
      const cur = this.capturePosition(i);
      const prev = this.prevPos[i];
      this.prevPos[i] = cur;
      if (!cur || !prev) continue;

      const vy = (cur.y - prev.y) / dtSec;
      if (vy > -HIT_VELOCITY_THRESHOLD_MPS) continue; // not a downward strike

      // Which pad (if any) did this grip cross this frame?
      for (const pad of PAD_POSITIONS) {
        const padY = pad.position.y;
        const crossed = prev.y > padY && cur.y <= padY;
        if (!crossed) continue;
        // Interpolated crossing point in (x, z) to avoid missing hits on the
        // edge when the controller moves fast.
        const t = (prev.y - padY) / (prev.y - cur.y);
        const hx = prev.x + (cur.x - prev.x) * t;
        const hz = prev.z + (cur.z - prev.z) * t;
        const dx = hx - pad.position.x;
        const dz = hz - pad.position.z;
        if (dx * dx + dz * dz > pad.radius * pad.radius) continue;

        const lastMs = this.lastHitMs.get(pad.lane) ?? -Infinity;
        if (nowMs - lastMs < HIT_COOLDOWN_MS) continue;
        this.lastHitMs.set(pad.lane, nowMs);

        this.listener({
          lane: pad.lane,
          timestampMs: nowMs,
          key: `xr-pad-${pad.label}`,
        });
        this.pulseHaptic(session, i);
        break; // one hit per grip per frame
      }
    }
  }

  private capturePosition(index: number): THREE.Vector3 | null {
    const grip = this.webgl.xr.getControllerGrip(index);
    // Pose arrives via the WebXRManager updates; Object3D.position is set by
    // Three.js when the grip has an active pose. If no pose yet, skip.
    if (grip.position.lengthSq() === 0 && !grip.quaternion.x) return null;
    return grip.position.clone();
  }

  private pulseHaptic(session: XRSession, controllerIdx: number): void {
    // Match the controller index to an input source. Order of inputSources
    // isn't guaranteed left-then-right, so we use handedness best-effort.
    let i = 0;
    for (const src of session.inputSources) {
      if (!src.gamepad) continue;
      if (i === controllerIdx) {
        const actuators = (src.gamepad as Gamepad & { hapticActuators?: GamepadHapticActuator[] })
          .hapticActuators;
        const act = actuators?.[0];
        if (act && 'pulse' in act) {
          (act as GamepadHapticActuator & { pulse(intensity: number, durationMs: number): Promise<boolean> })
            .pulse(0.6, 40)
            .catch(() => {});
        }
        return;
      }
      i++;
    }
  }

  stop(): void {
    for (const o of this.addedToScene) this.scene.remove(o);
    this.addedToScene.length = 0;
    this.prevPos[0] = null;
    this.prevPos[1] = null;
    this.prevFrameMs = null;
    this.lastHitMs.clear();
    this.listener = null;
  }
}
