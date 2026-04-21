import * as THREE from 'three';
import { Lane, type LaneValue } from '@dtxmania/input';
import { LANE_LAYOUT } from './lane-layout.js';
import { PAD_ATLAS, PAD_SIZE } from './pad-atlas.js';

/**
 * VR virtual drum kit.
 *
 * Layout ported from /drum-kit-design.html after design review. Every pad
 * corresponds 1:1 to a DTX lane, and each uses the matching slice of
 * 7_pads.png so what the player sees in VR matches the on-screen HUD
 * sprite for that drum.
 *
 * Controllers are drumsticks (visible cylinder + tip sphere attached to
 * each grip). The stick tip's world position is tracked per frame; a hit
 * fires when the tip plane-crosses a pad downward at sufficient speed and
 * lands within the pad's (x, z) footprint.
 *
 * BD is a special case: its visual is a large disc facing the player
 * (like a real kick drum head), but the judgment plane is the virtual
 * horizontal surface above it — VR has no foot pedal, so the player
 * strikes it from above with a stick.
 */

export interface XrLaneEvent {
  lane: LaneValue;
  timestampMs: number;
  key: string;
}
export type XrLaneListener = (e: XrLaneEvent) => void;

type PadShape = 'disc' | 'face' | 'pedal';

interface PadSpec {
  lane: LaneValue;
  /** World-space centre in metres. */
  position: THREE.Vector3;
  /** Disc diameter / pedal side length in metres. */
  size: number;
  /** Tilt angle towards the player, in degrees (0 = flat). */
  tiltDeg: number;
  shape: PadShape;
  /** If true, add a chrome stand from floor to pad bottom. */
  stand: boolean;
}

const PAD_LAYOUT: readonly PadSpec[] = [
  { lane: Lane.LC, position: new THREE.Vector3(-0.65, 1.35, -0.60), size: 0.36, tiltDeg: 10, shape: 'disc',  stand: true  },
  { lane: Lane.HH, position: new THREE.Vector3(-0.50, 0.95, -0.40), size: 0.30, tiltDeg:  0, shape: 'disc',  stand: true  },
  { lane: Lane.LP, position: new THREE.Vector3(-0.30, 0.20, -0.25), size: 0.18, tiltDeg:  0, shape: 'pedal', stand: false },
  { lane: Lane.SD, position: new THREE.Vector3(-0.15, 0.80, -0.40), size: 0.32, tiltDeg:  0, shape: 'disc',  stand: false },
  { lane: Lane.HT, position: new THREE.Vector3(-0.05, 1.00, -0.60), size: 0.26, tiltDeg: 10, shape: 'disc',  stand: false },
  { lane: Lane.BD, position: new THREE.Vector3( 0.15, 0.35, -0.50), size: 0.50, tiltDeg:  0, shape: 'face',  stand: false },
  { lane: Lane.LT, position: new THREE.Vector3( 0.20, 1.00, -0.60), size: 0.26, tiltDeg: 10, shape: 'disc',  stand: false },
  { lane: Lane.FT, position: new THREE.Vector3( 0.50, 0.80, -0.50), size: 0.34, tiltDeg:  0, shape: 'disc',  stand: false },
  { lane: Lane.CY, position: new THREE.Vector3( 0.55, 1.35, -0.70), size: 0.36, tiltDeg: 10, shape: 'disc',  stand: true  },
  { lane: Lane.RD, position: new THREE.Vector3( 0.75, 1.15, -0.55), size: 0.42, tiltDeg:  8, shape: 'disc',  stand: true  },
];

const STICK_LENGTH_M = 0.35;
const STICK_RADIUS_M = 0.01;
const HIT_VELOCITY_THRESHOLD_MPS = 1.0;
const HIT_COOLDOWN_MS = 80;
/** BD is hit from above — judgment square is the pad's (x, z) footprint expanded
 *  a bit so the large kick-face is easy to strike. */
const BD_HIT_HALF_M = 0.25;

export class XrControllers {
  private listener: XrLaneListener | null = null;
  private readonly addedToScene: THREE.Object3D[] = [];

  private readonly prevTip: (THREE.Vector3 | null)[] = [null, null];
  private readonly tipForward = new THREE.Vector3(0, 0, -STICK_LENGTH_M);
  private readonly tipWorld = new THREE.Vector3();
  private prevFrameMs: number | null = null;
  private readonly lastHitMs = new Map<LaneValue, number>();

  private padsTexture: THREE.Texture | null = null;

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {}

  onHit(cb: XrLaneListener): void {
    this.listener = cb;
  }

  setPadsTexture(tex: THREE.Texture | undefined): void {
    this.padsTexture = tex ?? null;
  }

  start(): void {
    for (const spec of PAD_LAYOUT) {
      for (const obj of this.buildPadObjects(spec)) {
        this.scene.add(obj);
        this.addedToScene.push(obj);
      }
    }

    // Controllers: sticks extending forward from each grip.
    for (let i = 0; i < 2; i++) {
      const grip = this.webgl.xr.getControllerGrip(i);
      grip.add(this.buildStick());
      this.scene.add(grip);
      this.addedToScene.push(grip);
    }
  }

  private buildPadObjects(spec: PadSpec): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];

    if (spec.shape === 'face') {
      out.push(...this.buildBassDrum(spec));
      return out;
    }

    // Disc / pedal: a textured square plane lying horizontal (face up), with
    // an optional tilt toward the player.
    out.push(this.buildDiscPad(spec));

    if (spec.stand) {
      out.push(this.buildStand(spec));
    }
    return out;
  }

  private buildDiscPad(spec: PadSpec): THREE.Mesh {
    const mat = this.padMaterial(spec.lane);
    const geom = new THREE.PlaneGeometry(spec.size, spec.size);
    geom.rotateX(-Math.PI / 2); // face up
    if (spec.tiltDeg !== 0) {
      // Tilt the front edge down towards the player (rotate around X axis).
      geom.rotateX(THREE.MathUtils.degToRad(spec.tiltDeg));
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(spec.position);
    return mesh;
  }

  /**
   * Kick drum visual: a large circle *facing the player* (a vertical disc
   * perpendicular to -Z) plus a short cylindrical shell behind it to read
   * as a real drum body. Judgment is done against the horizontal plane
   * through the pad centre, so the player can tap the top of the kick.
   */
  private buildBassDrum(spec: PadSpec): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];

    // Front face — vertical, facing +Z (toward the player at origin).
    const faceMat = this.padMaterial(spec.lane);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(spec.size, spec.size), faceMat);
    face.position.copy(spec.position);
    face.position.z += 0.12; // front of shell
    out.push(face);

    // Shell cylinder — the kick drum body.
    const shellLen = 0.24;
    const shellGeom = new THREE.CylinderGeometry(spec.size / 2, spec.size / 2, shellLen, 24, 1, true);
    shellGeom.rotateX(Math.PI / 2); // cylinder axis along Z
    const shellMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(shellGeom, shellMat);
    shell.position.copy(spec.position);
    out.push(shell);

    return out;
  }

  private buildStand(spec: PadSpec): THREE.Mesh {
    const padBottom = spec.position.y - spec.size * 0.05; // just under the pad
    const height = padBottom; // from floor
    if (height <= 0.05) {
      // Pad is basically on the floor; skip the stand.
      return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    }
    const geom = new THREE.CylinderGeometry(0.012, 0.015, height, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb8b8b8 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(spec.position.x, height / 2, spec.position.z);
    return mesh;
  }

  private padMaterial(lane: LaneValue): THREE.MeshBasicMaterial {
    const rect = PAD_ATLAS.find((r) => r.lane === lane);
    if (this.padsTexture && rect) {
      const tex = this.padsTexture.clone();
      tex.needsUpdate = true;
      const atlasW = this.padsTexture.image?.width ?? 384;
      const atlasH = this.padsTexture.image?.height ?? 288;
      tex.repeat.set(PAD_SIZE / atlasW, PAD_SIZE / atlasH);
      tex.offset.set(rect.sx / atlasW, 1 - (rect.sy + PAD_SIZE) / atlasH);
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    }
    // Fallback: coloured plane if the skin didn't load.
    const laneColor = LANE_LAYOUT.find((l) => l.lane === lane)?.color ?? '#888';
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(laneColor),
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
    });
  }

  private buildStick(): THREE.Object3D {
    const group = new THREE.Group();
    const shaftGeom = new THREE.CylinderGeometry(STICK_RADIUS_M, STICK_RADIUS_M * 1.3, STICK_LENGTH_M, 12);
    shaftGeom.rotateX(-Math.PI / 2);
    shaftGeom.translate(0, 0, -STICK_LENGTH_M / 2);
    const shaft = new THREE.Mesh(shaftGeom, new THREE.MeshBasicMaterial({ color: 0xdddddd }));
    group.add(shaft);
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(STICK_RADIUS_M * 1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x333333 })
    );
    tip.position.set(0, 0, -STICK_LENGTH_M);
    group.add(tip);
    return group;
  }

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

      for (const pad of PAD_LAYOUT) {
        const padY = pad.position.y;
        const crossed = prev.y > padY && cur.y <= padY;
        if (!crossed) continue;

        const t = (prev.y - padY) / (prev.y - cur.y);
        const hx = prev.x + (cur.x - prev.x) * t;
        const hz = prev.z + (cur.z - prev.z) * t;

        const half = pad.shape === 'face' ? BD_HIT_HALF_M : pad.size / 2;
        if (Math.abs(hx - pad.position.x) > half) continue;
        if (Math.abs(hz - pad.position.z) > half) continue;

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

  private captureTip(index: number): THREE.Vector3 | null {
    const grip = this.webgl.xr.getControllerGrip(index);
    if (
      grip.position.lengthSq() === 0 &&
      grip.quaternion.x === 0 &&
      grip.quaternion.y === 0 &&
      grip.quaternion.z === 0
    ) {
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
