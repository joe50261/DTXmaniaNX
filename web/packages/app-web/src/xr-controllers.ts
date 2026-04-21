import * as THREE from 'three';
import { Lane, type LaneValue } from '@dtxmania/input';
import { LANE_LAYOUT } from './lane-layout.js';
import { PAD_ATLAS, PAD_SIZE } from './pad-atlas.js';

/**
 * VR virtual drum kit.
 *
 * Ten square pads laid out horizontally in front of the player, matching the
 * on-screen DTXMania lane order so the 3D layout reads exactly like the 2D
 * playfield. Each pad is textured with its slice of the 7_pads.png atlas,
 * so the player sees the same drum graphics as the HUD.
 *
 * Controllers are treated as drumsticks — a ~35 cm cylinder extends forward
 * from each controller grip, and the tip of that cylinder is what's tested
 * against the pad planes, not the grip itself. That matches the muscle
 * memory of holding a real stick.
 *
 * Hit detection per frame:
 *   - Compute each controller's stick-tip world position (grip + forward*0.35).
 *   - If the tip crossed a pad's y plane this frame (was above, now below)
 *     AND vertical velocity is strongly downward (< HIT_VELOCITY_THRESHOLD_MPS)
 *     AND the (x, z) projection at the crossing is inside the pad's AABB,
 *     emit a lane-hit event and pulse the controller's haptics.
 *   - 80 ms per-pad cool-down debounces single-swing jitter.
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
  /** World-space centre in metres relative to the playspace origin. */
  position: THREE.Vector3;
  /** Half-edge of the square pad (AABB half-extent in x and z). */
  half: number;
}

const STICK_LENGTH_M = 0.35;         // drumstick length from grip to tip
const STICK_RADIUS_M = 0.01;
const PAD_WORLD_SIZE_M = 0.22;        // each pad ≈ 22 cm square → 11 cm half-extent
const PAD_Y_M = 0.95;                 // waist / lap level for a standing player
const PAD_Z_M = -0.55;                // half a metre in front of viewer
const PAD_ROW_WIDTH_M = 1.6;          // total lateral span of the ten pads
const HIT_VELOCITY_THRESHOLD_MPS = 1.0;
const HIT_COOLDOWN_MS = 80;

/**
 * Map the DTXMania-Type-A screen x (lane-layout.ts) into a world-space x so
 * the 3D row order matches the 2D HUD order and spacing. The 2D lane band
 * spans 263–851 px (LC left edge to RD right edge); we linearly remap that
 * to ±PAD_ROW_WIDTH_M/2.
 */
function buildPadRow(): PadLayout[] {
  const edgeLeft = LANE_LAYOUT[0]!.x;
  const last = LANE_LAYOUT[LANE_LAYOUT.length - 1]!;
  const edgeRight = last.x + last.width;
  const pxCenter = (edgeLeft + edgeRight) / 2;
  const pxRange = edgeRight - edgeLeft;
  const pxToM = PAD_ROW_WIDTH_M / pxRange;
  return LANE_LAYOUT.map((spec) => {
    const laneCenterPx = spec.x + spec.width / 2;
    const x = (laneCenterPx - pxCenter) * pxToM;
    return {
      lane: spec.lane,
      position: new THREE.Vector3(x, PAD_Y_M, PAD_Z_M),
      half: PAD_WORLD_SIZE_M / 2,
    };
  });
}

export class XrControllers {
  private listener: XrLaneListener | null = null;
  private readonly addedToScene: THREE.Object3D[] = [];

  /** Stick-tip world position from the previous frame, per controller. */
  private readonly prevTip: (THREE.Vector3 | null)[] = [null, null];
  /** Reusable vectors to avoid per-frame allocations. */
  private readonly tipForward = new THREE.Vector3(0, 0, -STICK_LENGTH_M);
  private readonly tipWorld = new THREE.Vector3();
  private prevFrameMs: number | null = null;
  private readonly lastHitMs = new Map<LaneValue, number>();

  private readonly padLayout: PadLayout[] = buildPadRow();
  private padsTexture: THREE.Texture | null = null;

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {}

  onHit(cb: XrLaneListener): void {
    this.listener = cb;
  }

  /** Supply the 7_pads.png atlas so the 3D pads can use the DTX sprites. */
  setPadsTexture(tex: THREE.Texture | undefined): void {
    this.padsTexture = tex ?? null;
  }

  start(): void {
    for (const pad of this.padLayout) {
      this.scene.add(...this.buildPadMeshes(pad));
    }

    // Drumsticks: a thin cylinder forward from each grip, with a dark tip so
    // the player can aim.
    for (let i = 0; i < 2; i++) {
      const grip = this.webgl.xr.getControllerGrip(i);
      grip.add(this.buildStick());
      this.scene.add(grip);
      this.addedToScene.push(grip);
    }
  }

  private buildPadMeshes(pad: PadLayout): THREE.Object3D[] {
    const rect = PAD_ATLAS.find((r) => r.lane === pad.lane);
    const out: THREE.Object3D[] = [];

    // Pad face — a horizontal square with the atlas sprite on top. Falls back
    // to a solid coloured plane if the skin didn't load.
    let padMat: THREE.MeshBasicMaterial;
    if (this.padsTexture && rect) {
      const tex = this.padsTexture.clone();
      tex.needsUpdate = true;
      const atlasW = this.padsTexture.image?.width ?? 384;
      const atlasH = this.padsTexture.image?.height ?? 288;
      tex.repeat.set(PAD_SIZE / atlasW, PAD_SIZE / atlasH);
      tex.offset.set(rect.sx / atlasW, 1 - (rect.sy + PAD_SIZE) / atlasH);
      padMat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: THREE.DoubleSide,
      });
    } else {
      const laneColor = LANE_LAYOUT.find((l) => l.lane === pad.lane)?.color ?? '#888';
      padMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(laneColor),
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
      });
    }
    const geom = new THREE.PlaneGeometry(PAD_WORLD_SIZE_M, PAD_WORLD_SIZE_M);
    geom.rotateX(-Math.PI / 2); // face up
    const padMesh = new THREE.Mesh(geom, padMat);
    padMesh.position.copy(pad.position);
    out.push(padMesh);
    this.addedToScene.push(padMesh);

    // Thin white border so pads are legible against any bg.
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(PAD_WORLD_SIZE_M, PAD_WORLD_SIZE_M)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
    );
    border.rotation.x = -Math.PI / 2;
    border.position.copy(pad.position);
    border.position.y += 0.001;
    out.push(border);
    this.addedToScene.push(border);

    return out;
  }

  private buildStick(): THREE.Object3D {
    const group = new THREE.Group();
    // Cylinder default axis is along Y; rotate to align with -Z (forward).
    const geom = new THREE.CylinderGeometry(
      STICK_RADIUS_M,
      STICK_RADIUS_M * 1.3,
      STICK_LENGTH_M,
      12
    );
    geom.rotateX(-Math.PI / 2);
    // Shift so the grip-end is at local origin, tip at (0, 0, -STICK_LENGTH).
    geom.translate(0, 0, -STICK_LENGTH_M / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xdddddd });
    const shaft = new THREE.Mesh(geom, mat);
    group.add(shaft);

    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(STICK_RADIUS_M * 1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x333333 })
    );
    tip.position.set(0, 0, -STICK_LENGTH_M);
    group.add(tip);

    return group;
  }

  /** Poll controller motion; call once per frame. */
  tick(): void {
    if (!this.listener) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    const nowMs = performance.now();
    const dtMs = this.prevFrameMs === null ? 0 : nowMs - this.prevFrameMs;
    this.prevFrameMs = nowMs;
    if (dtMs <= 0 || dtMs > 100) {
      for (let i = 0; i < 2; i++) this.prevTip[i] = this.captureTip(i);
      return;
    }
    const dtSec = dtMs / 1000;

    for (let i = 0; i < 2; i++) {
      const cur = this.captureTip(i);
      const prev = this.prevTip[i];
      this.prevTip[i] = cur;
      if (!cur || !prev) continue;

      const vy = (cur.y - prev.y) / dtSec;
      if (vy > -HIT_VELOCITY_THRESHOLD_MPS) continue;

      for (const pad of this.padLayout) {
        const padY = pad.position.y;
        const crossed = prev.y > padY && cur.y <= padY;
        if (!crossed) continue;
        const t = (prev.y - padY) / (prev.y - cur.y);
        const hx = prev.x + (cur.x - prev.x) * t;
        const hz = prev.z + (cur.z - prev.z) * t;
        if (Math.abs(hx - pad.position.x) > pad.half) continue;
        if (Math.abs(hz - pad.position.z) > pad.half) continue;

        const lastMs = this.lastHitMs.get(pad.lane) ?? -Infinity;
        if (nowMs - lastMs < HIT_COOLDOWN_MS) continue;
        this.lastHitMs.set(pad.lane, nowMs);

        this.listener({
          lane: pad.lane,
          timestampMs: nowMs,
          key: `xr-pad-${laneLabel(pad.lane)}`,
        });
        this.pulseHaptic(session, i);
        break;
      }
    }
  }

  /** Stick tip in world space: grip position + (grip rotation applied to -Z * STICK_LENGTH). */
  private captureTip(index: number): THREE.Vector3 | null {
    const grip = this.webgl.xr.getControllerGrip(index);
    if (grip.position.lengthSq() === 0 && grip.quaternion.x === 0 && grip.quaternion.y === 0 && grip.quaternion.z === 0) {
      return null;
    }
    this.tipWorld.copy(this.tipForward).applyQuaternion(grip.quaternion).add(grip.position);
    return this.tipWorld.clone();
  }

  private pulseHaptic(session: XRSession, controllerIdx: number): void {
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
    this.prevTip[0] = null;
    this.prevTip[1] = null;
    this.prevFrameMs = null;
    this.lastHitMs.clear();
    this.listener = null;
  }
}

function laneLabel(lane: LaneValue): string {
  switch (lane) {
    case Lane.LC: return 'LC';
    case Lane.HH: return 'HH';
    case Lane.LP: return 'LP';
    case Lane.SD: return 'SD';
    case Lane.HT: return 'HT';
    case Lane.BD: return 'BD';
    case Lane.LT: return 'LT';
    case Lane.FT: return 'FT';
    case Lane.CY: return 'CY';
    case Lane.RD: return 'RD';
    default: return String(lane);
  }
}
