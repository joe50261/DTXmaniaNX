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
/** Number of points sampled along each stick's shaft (grip → tip) for hit
 * detection. The old single-tip check made it easy to overshoot — any
 * swing that passed through a pad with the stick's shaft but the tip
 * ending below+past the far edge would miss. Sampling the whole length
 * means a hit registers as soon as ANY part of the stick crosses the
 * pad plane inside its XZ rect with downward velocity, matching how a
 * real drumstick works.
 * 5 samples = grip, 25%, 50%, 75%, tip — cheap (10 crossings checked
 * per frame per controller) and dense enough that short pad sizes
 * don't fall between samples at typical swing speeds. */
const STICK_SAMPLE_COUNT = 5;

export class XrControllers {
  private listener: XrLaneListener | null = null;
  private readonly addedToScene: THREE.Object3D[] = [];

  /** Grip-local offsets for the stick samples, computed once. */
  private readonly stickOffsets: THREE.Vector3[] = [];
  /** Previous-frame world positions per controller per sample. */
  private readonly prevSamples: (THREE.Vector3 | null)[][] = [
    new Array(STICK_SAMPLE_COUNT).fill(null),
    new Array(STICK_SAMPLE_COUNT).fill(null),
  ];
  private prevFrameMs: number | null = null;
  private readonly lastHitMs = new Map<LaneValue, number>();

  /**
   * XRInputSource bound to controller index i, captured on `connected` event.
   * Needed because `session.inputSources` iteration order is not guaranteed
   * to match the Three.js controller index — pulsing the wrong entry made
   * the left-hand strike rumble the right controller.
   */
  private readonly inputSources: (XRInputSource | null)[] = [null, null];

  private padsTexture: THREE.Texture | null = null;

  /** Pad mesh + base Y per lane, so we can bounce them on hits. */
  private padMeshByLane = new Map<LaneValue, { mesh: THREE.Mesh; baseY: number }>();
  /** Latest hit timestamps — read in tick() to animate the bounce. */
  private lastPadHitMs = new Map<LaneValue, number>();

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    // Grip-local stick samples from grip (t=0) to tip (t=1). The shaft is
    // oriented along -Z in grip space (see buildStick), so z decreases
    // linearly. Each entry is the position relative to the grip origin
    // that we later rotate+translate into world space every frame.
    // Evenly spaced from grip (t=0) to tip (t=1). STICK_SAMPLE_COUNT > 1
    // is enforced by construction (constant is 5).
    for (let i = 0; i < STICK_SAMPLE_COUNT; i++) {
      const t = i / (STICK_SAMPLE_COUNT - 1);
      this.stickOffsets.push(new THREE.Vector3(0, 0, -STICK_LENGTH_M * t));
    }

    // Attach `connected` / `disconnected` listeners in the CTOR, not
    // `start()`, so they're live before the first animation frame of
    // any XR session. Three.js dispatches the initial `connected`
    // events during the first `onAnimationFrame` call after
    // `setSession`, not synchronously — which means listeners wired
    // in `start()` (called right after `await renderer.enterXR()`)
    // are attached a microtask EARLY but `scene.add(controller)`
    // plus the session-start animation loop then races against
    // subsequent first-frame event dispatch. In practice we saw the
    // listeners miss the initial dispatch on some Quest runtimes,
    // leaving `inputSources[i]` null and `pulseHaptic` silently
    // no-opping ("right stick hit → nothing, left stick hit → left
    // buzz" was the reported symptom — the cached slot that DID
    // populate was the only one ever pulsed). Mirrors the pattern
    // VrMenu / VrConfig / VrCalibrate already use.
    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const idx = i;
      controller.addEventListener('connected', (event) => {
        const data = (event as unknown as { data?: XRInputSource }).data;
        if (data) this.inputSources[idx] = data;
      });
      controller.addEventListener('disconnected', () => {
        this.inputSources[idx] = null;
      });
      this.scene.add(controller);
    }
  }

  /** Expose input sources so other subsystems (e.g. the game layer's
   * mid-song cancel-squeeze polling) can read button state without
   * duplicating the `connected`/`disconnected` wiring. Returned array
   * is indexed by Three.js controller slot (0 / 1); ORDER IS NOT
   * handedness — WebXR's input-source-change event decides slots
   * independently of which hand connects first. Use `inputSourceByHand`
   * when semantics depend on handedness (loop markers, quit). */
  get currentInputSources(): ReadonlyArray<XRInputSource | null> {
    return this.inputSources;
  }

  /** Look up the currently-connected input source for a specific hand.
   * Returns null if that hand isn't connected or the runtime reports
   * `handedness === 'none'` (rare; happens for trackers). Stable across
   * controller slot reassignments within a session. */
  inputSourceByHand(hand: 'left' | 'right'): XRInputSource | null {
    for (const src of this.inputSources) {
      if (src?.handedness === hand) return src;
    }
    return null;
  }

  onHit(cb: XrLaneListener): void {
    this.listener = cb;
  }

  setPadsTexture(tex: THREE.Texture | undefined): void {
    this.padsTexture = tex ?? null;
  }

  /** Game pushes its per-frame pad-hit timestamp map in. */
  submitPadHits(map: Map<LaneValue, number>): void {
    this.lastPadHitMs = map;
  }

  start(): void {
    for (const spec of PAD_LAYOUT) {
      for (const obj of this.buildPadObjects(spec)) {
        this.scene.add(obj);
        this.addedToScene.push(obj);
      }
    }

    // Controllers + their `connected` listeners live in the CTOR (so
    // the initial first-frame event dispatch can't miss them — see the
    // regression comment there). Here we only attach the per-session
    // stick mesh to each grip; the controller Object3D itself is
    // already in the scene.
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
    this.padMeshByLane.set(spec.lane, { mesh, baseY: spec.position.y });
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
    this.animatePadBounce();
    if (!this.listener) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    const nowMs = performance.now();
    const dtMs = this.prevFrameMs === null ? 0 : nowMs - this.prevFrameMs;
    this.prevFrameMs = nowMs;
    if (dtMs <= 0 || dtMs > 100) {
      for (let i = 0; i < 2; i++) this.prevSamples[i] = this.captureSamples(i);
      return;
    }
    const dtSec = dtMs / 1000;

    for (let i = 0; i < 2; i++) {
      const cur = this.captureSamples(i);
      const prev = this.prevSamples[i]!;
      this.prevSamples[i] = cur;

      // Whole-stick hit scan: each sample (grip → tip) tested for a
      // downward crossing of each pad. Early-exits once one pad is hit
      // so a single swing can only fire one lane per controller-frame.
      // Cooldown is still per-lane so rapid double-strikes on the same
      // pad across two controllers stay correct.
      let fired = false;
      for (let s = 0; s < STICK_SAMPLE_COUNT && !fired; s++) {
        const c = cur[s];
        const p = prev[s];
        if (!c || !p) continue;
        const vy = (c.y - p.y) / dtSec;
        if (vy > -HIT_VELOCITY_THRESHOLD_MPS) continue;

        for (const pad of PAD_LAYOUT) {
          const padY = pad.position.y;
          const crossed = p.y > padY && c.y <= padY;
          if (!crossed) continue;

          const t = (p.y - padY) / (p.y - c.y);
          const hx = p.x + (c.x - p.x) * t;
          const hz = p.z + (c.z - p.z) * t;

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
          this.pulseHaptic(i);
          fired = true;
          break;
        }
      }
    }
  }

  /** Compute world-space positions of every sample point along this
   * controller's stick, or return an array of nulls if the pose hasn't
   * populated yet (grip at identity). */
  private captureSamples(index: number): (THREE.Vector3 | null)[] {
    const grip = this.webgl.xr.getControllerGrip(index);
    const posed =
      grip.position.lengthSq() !== 0 ||
      grip.quaternion.x !== 0 ||
      grip.quaternion.y !== 0 ||
      grip.quaternion.z !== 0;
    if (!posed) return new Array(STICK_SAMPLE_COUNT).fill(null);

    const out: THREE.Vector3[] = [];
    for (const off of this.stickOffsets) {
      const p = off.clone().applyQuaternion(grip.quaternion).add(grip.position);
      out.push(p);
    }
    return out;
  }

  /**
   * Pulse the actuator for the hand that just struck.
   *
   * Resolution chain:
   *   slot index (from hit detection) → handedness (read off the cached
   *   `inputSources[slot]`) → live `session.inputSources` iteration →
   *   the LIVE `XRInputSource` matching that handedness → its
   *   `gamepad.vibrationActuator.playEffect`.
   *
   * Why not `this.inputSources[slot].gamepad` directly: PRs #12-#14
   * progressively eliminated every layer but this one. PR #12 confirmed
   * slot↔handedness binding is correct. PR #13's `fired: true` +
   * wrong-hand behaviour ruled out the legacy `hapticActuators[0].pulse`
   * actuator mapping. PR #14 swapped to standards-compliant
   * `vibrationActuator.playEffect('dual-rumble', ...)` and the symptom
   * persisted — right-slot pulse still buzzed the left controller, left-
   * slot pulse still no-op'd. The single remaining suspect is
   * `XRInputSource.gamepad`'s reference staleness: Quest Browser appears
   * to retain our cached `XRInputSource` object across an
   * inputsourceschange such that its `.gamepad.vibrationActuator` keeps
   * pointing at whatever actuator it was first paired with — which
   * isn't necessarily the one now bound to that physical controller.
   * Other WebXR games (and e.g. Paradiddle-style native apps) don't hit
   * this because they either read `session.inputSources` live every
   * frame or go through OpenXR directly; our `connected`-time cache was
   * the odd one out.
   *
   * We still use the slot index for hit attribution (grip pose tracking
   * is per-slot and verified correct by `captureSamples`), so the cached
   * handedness at `this.inputSources[slot].handedness` is the stable
   * bridge — it identifies which live input source to fetch without
   * re-introducing the old \"handedness drift\" hazard (handedness of a
   * given physical controller doesn't change across reconnects; its
   * gamepad actuator reference does).
   */
  private pulseHaptic(controllerIdx: number): void {
    const cachedHand = this.inputSources[controllerIdx]?.handedness;
    if (cachedHand !== 'left' && cachedHand !== 'right') return;
    const session = this.webgl.xr.getSession();
    if (!session) return;
    let liveSrc: XRInputSource | null = null;
    for (const s of session.inputSources) {
      // Defensive: WebXR spec says session.inputSources is a
      // FrozenArray<XRInputSource>, no holes — but guard anyway so a
      // hand-tracking-only session (`handedness: 'none'`) or a sparse
      // polyfill can't crash the haptic path.
      if (!s) continue;
      if (s.handedness === cachedHand) {
        liveSrc = s;
        break;
      }
    }
    const gp = liveSrc?.gamepad as
      | (Gamepad & {
          vibrationActuator?: {
            playEffect(
              type: 'dual-rumble',
              params: {
                startDelay?: number;
                duration: number;
                weakMagnitude?: number;
                strongMagnitude?: number;
              },
            ): Promise<string>;
          };
          hapticActuators?: GamepadHapticActuator[];
        })
      | undefined;
    if (!gp) return;

    if (gp.vibrationActuator?.playEffect) {
      gp.vibrationActuator
        .playEffect('dual-rumble', {
          duration: 40,
          strongMagnitude: 0.6,
          weakMagnitude: 0.6,
        })
        // Deliberately do NOT chain-fallback to the legacy actuator on
        // reject: that path has known wrong-device routing on Quest (the
        // whole reason this PR exists). Silent no-op is the safer
        // behaviour if a future Quest firmware starts rejecting
        // `playEffect` — better no buzz than wrong-hand buzz.
        .catch(() => {});
      return;
    }

    const act = gp.hapticActuators?.[0];
    if (act && 'pulse' in act) {
      (act as GamepadHapticActuator & {
        pulse(intensity: number, durationMs: number): Promise<boolean>;
      })
        .pulse(0.6, 40)
        .catch(() => {});
    }
  }

  /** Dip each struck pad downward 1.5 cm then spring back over ~150 ms. */
  private animatePadBounce(): void {
    if (this.padMeshByLane.size === 0) return;
    const now = performance.now();
    const durMs = 150;
    const dip = 0.015; // metres
    for (const [lane, { mesh, baseY }] of this.padMeshByLane) {
      const hitAt = this.lastPadHitMs.get(lane);
      if (hitAt === undefined) {
        mesh.position.y = baseY;
        continue;
      }
      const age = now - hitAt;
      if (age >= durMs) {
        mesh.position.y = baseY;
        continue;
      }
      const t = age / durMs;
      // Fast down, slower return.
      const offset = t < 0.3 ? -dip * (t / 0.3) : -dip * (1 - (t - 0.3) / 0.7);
      mesh.position.y = baseY + Math.max(-dip, Math.min(0, offset));
    }
  }

  stop(): void {
    for (const o of this.addedToScene) this.scene.remove(o);
    this.addedToScene.length = 0;
    this.padMeshByLane.clear();
    for (let i = 0; i < 2; i++) this.prevSamples[i] = new Array(STICK_SAMPLE_COUNT).fill(null);
    this.prevFrameMs = null;
    this.lastHitMs.clear();
    this.inputSources[0] = null;
    this.inputSources[1] = null;
    // Intentionally NOT nulling this.listener: Game wires it once at
    // construction via onHit(), and tick() already bails early when no
    // XR session is active, so there's no stale-dispatch risk. Clearing
    // it here would break re-enter-VR — start() doesn't re-subscribe.
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
