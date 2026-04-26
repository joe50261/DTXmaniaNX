import * as THREE from 'three';
import { Lane, type LaneValue } from '@dtxmania/input';
import { LANE_LAYOUT } from './lane-layout.js';
import { PAD_ATLAS, PAD_SIZE } from './pad-atlas.js';
import { getConfig, subscribe, type Config } from './config.js';
import {
  applySeatYOffset,
  getKitPreset,
  type PadSpec,
} from './kit-preset.js';
import { detectPadHit } from './hit-detect.js';
import type { Pose } from './replay/recorder-model.js';

/** Snapshot of the headset + controller poses at the moment getPoses()
 * is called. Each side is `null` when the pose isn't available — see
 * `XrControllers.getPoses` for the precise nullability rules. */
export interface XrPoseSnapshot {
  head: Pose | null;
  left: Pose | null;
  right: Pose | null;
}

/**
 * VR virtual drum kit.
 *
 * Layout, sizes, and tilts come from `kit-preset.ts`. The default preset
 * targets the GITADORA Galaxy Wave arcade cabinet (Konami's white-frame
 * latest gen) so muscle memory transfers between the sim and a real
 * machine; players can swap to other presets via the VR config panel.
 *
 * Controllers are drumsticks (visible cylinder + tip sphere attached to
 * each grip). The stick is sampled at five points along its shaft; a
 * hit fires when any sample crosses a pad's tilted face from the
 * outward-normal side at sufficient inward speed and lands within the
 * pad's footprint. See `hit-detect.ts` for the math — pure functions,
 * unit-tested.
 *
 * BD is a special case: its visual is a large vertical face, but
 * judgment uses a horizontal plane above it (Quest has no foot
 * tracking, so the kick is a stick-strike abstraction).
 */

export interface XrLaneEvent {
  lane: LaneValue;
  timestampMs: number;
  key: string;
  /** Which controller fired this hit. Populated from the input source's
   * `handedness` at fire time. Falls back to `'right'` only in the
   * pathological case where handedness is `'none'` (trackers, not real
   * controllers) — drum sticks always report a real hand on Quest. */
  hand: 'left' | 'right';
}
export type XrLaneListener = (e: XrLaneEvent) => void;

const STICK_LENGTH_M = 0.35;
const STICK_RADIUS_M = 0.01;
const HIT_COOLDOWN_MS = 80;
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

  /** Currently-built pad specs, world-space (preset + seat offset
   * applied). Drives both visuals and hit detection so the two stay
   * trivially in sync. Empty before start() / after stop(). */
  private currentPads: readonly PadSpec[] = [];
  /** Scene objects belonging to the kit only (pads + stands). Tracked
   * separately from `addedToScene` so we can rebuild the kit in place
   * on a preset / seat-offset change without tearing down controllers
   * or grips. */
  private kitObjects: THREE.Object3D[] = [];
  /** Snapshot of the config inputs the kit was built from, so the
   * config-subscribe handler can decide whether a rebuild is needed
   * (avoids thrash when an unrelated setting like volume changes). */
  private builtKitForPresetId: string | null = null;
  private builtKitForSeatOffset: number | null = null;
  private unsubConfig: (() => void) | null = null;

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
    // SongSelectCanvas / VrConfig / VrCalibrate already use.
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
    this.buildKit(getConfig());

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

    // Live-rebuild the kit when the player changes preset or seat
    // offset via the in-VR config panel. Cheap (10 pads) so a full
    // rebuild on each change beats wiring partial-update paths and
    // keeps visuals + hit-detection trivially in sync.
    this.unsubConfig = subscribe((cfg) => {
      if (
        cfg.kitPresetId !== this.builtKitForPresetId ||
        cfg.seatYOffset !== this.builtKitForSeatOffset
      ) {
        this.buildKit(cfg);
      }
    });
  }

  /** Build (or rebuild) every pad mesh + stand from the current config.
   *  Tears down any previously-built kit objects first, leaving
   *  controllers / grips untouched. */
  private buildKit(cfg: Config): void {
    for (const o of this.kitObjects) this.scene.remove(o);
    this.kitObjects.length = 0;
    this.padMeshByLane.clear();

    const preset = getKitPreset(cfg.kitPresetId);
    this.currentPads = applySeatYOffset(preset.pads, cfg.seatYOffset);
    this.builtKitForPresetId = cfg.kitPresetId;
    this.builtKitForSeatOffset = cfg.seatYOffset;

    for (const spec of this.currentPads) {
      for (const obj of this.buildPadObjects(spec)) {
        this.scene.add(obj);
        this.kitObjects.push(obj);
      }
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
      // padNormal() in hit-detect.ts assumes the same rotation order, so
      // the tilt direction MUST stay positive-around-X here.
      geom.rotateX(THREE.MathUtils.degToRad(spec.tiltDeg));
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(spec.position.x, spec.position.y, spec.position.z);
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
    face.position.set(spec.position.x, spec.position.y, spec.position.z + 0.12);
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
    shell.position.set(spec.position.x, spec.position.y, spec.position.z);
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

  /**
   * Read-only snapshot of headset + controller world poses for the
   * replay subsystem (Recorder during capture, ReplayViewer during
   * playback). Pure side-effect-free getter, safe to call every frame.
   *
   * Nullability rules:
   *  - `left` / `right`: null when no grips have been added to the
   *    scene yet (`addedToScene` empty — i.e. before `start()` or
   *    after `stop()`). When grips ARE in the scene we read pose
   *    straight off the grip Object3D regardless of whether the
   *    runtime has actually populated it; cleanly detecting an
   *    "untracked but added" grip would duplicate the pose-validity
   *    heuristic in `captureSamples` and isn't worth the complexity
   *    for the replay use case (a few frames of identity-pose at
   *    session start is acceptable).
   *  - `head`: null when there is no active XR session. We gate on
   *    `webgl.xr.isPresenting` (Three.js 0.160 exposes this on
   *    WebXRManager) so a desktop-mode caller doesn't get a stale
   *    last-XR-frame camera pose. Documented choice: lean toward
   *    "return null when there's no active XR session", as the spec
   *    suggests.
   *
   * Allocations: one `XrPoseSnapshot` per call plus one `Pose` per
   * non-null side. `position.toArray()` / `quaternion.toArray()`
   * each allocate one small array — fine at frame cadence.
   */
  getPoses(): XrPoseSnapshot {
    let left: Pose | null = null;
    let right: Pose | null = null;
    if (this.addedToScene.length > 0) {
      left = readPose(this.webgl.xr.getControllerGrip(0));
      right = readPose(this.webgl.xr.getControllerGrip(1));
    }

    let head: Pose | null = null;
    const xr = this.webgl.xr as THREE.WebXRManager & { isPresenting?: boolean };
    if (xr.isPresenting) {
      const cam = xr.getCamera();
      if (cam) head = readPose(cam);
    }

    return { head, left, right };
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

      // Whole-stick hit scan: each sample (grip → tip) tested against
      // every pad's tilted face via the pure detector. Early-exits once
      // one pad fires so a single swing can only trigger one lane per
      // controller-frame. Cooldown is per-lane so rapid double-strikes
      // on the same pad across two controllers stay correct.
      let fired = false;
      for (let s = 0; s < STICK_SAMPLE_COUNT && !fired; s++) {
        const c = cur[s];
        const p = prev[s];
        if (!c || !p) continue;

        for (const pad of this.currentPads) {
          // Threshold is left at detectPadHit's default
          // (HIT_VELOCITY_THRESHOLD_MPS) — passing it explicitly was
          // redundant and obscured that the velocity threshold lives
          // in the detector module.
          const result = detectPadHit({ prev: p, curr: c, dtSec }, pad);
          if (!result) continue;

          const lastMs = this.lastHitMs.get(pad.lane) ?? -Infinity;
          if (nowMs - lastMs < HIT_COOLDOWN_MS) continue;
          this.lastHitMs.set(pad.lane, nowMs);

          const handedness = this.inputSources[i]?.handedness;
          const hand: 'left' | 'right' =
            handedness === 'left' ? 'left' : handedness === 'right' ? 'right' : 'right';
          this.listener({
            lane: pad.lane,
            timestampMs: nowMs,
            key: `xr-pad-${laneLabel(pad.lane)}`,
            hand,
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
   * Pulse the actuator bound to the same slot that detected the hit.
   * Grip pose and gamepad both live at `inputSources[i]`; slot-indexed
   * routing was verified by PRs #12 / #13's diagnostic logs (`cached`
   * matched `live` on every observed Quest session), so don't re-resolve
   * by handedness — `handedness` can drift relative to `inputSources[i]`
   * across reconnects and would produce wrong-hand buzz.
   *
   * Prefer the standard `gamepad.vibrationActuator.playEffect` path:
   * Quest Browser's legacy `hapticActuators[0].pulse` resolves with
   * `fired: true` but routes to the *wrong* physical device (right-slot
   * pulse buzzed the left controller, left-slot pulse no-oped at all —
   * in-VR reproduction captured in PR #13). `playEffect('dual-rumble')`
   * addresses the correct per-controller vibrator on every Quest
   * firmware we've tested, and falls back gracefully on older / non-
   * Quest runtimes that only expose the legacy actuator array.
   */
  private pulseHaptic(controllerIdx: number): void {
    const src = this.inputSources[controllerIdx];
    const gp = src?.gamepad as
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
    this.unsubConfig?.();
    this.unsubConfig = null;
    for (const o of this.addedToScene) this.scene.remove(o);
    this.addedToScene.length = 0;
    for (const o of this.kitObjects) this.scene.remove(o);
    this.kitObjects.length = 0;
    this.padMeshByLane.clear();
    this.currentPads = [];
    this.builtKitForPresetId = null;
    this.builtKitForSeatOffset = null;
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

/** Read world-space position + quaternion off a Three.js Object3D into
 * the replay-model `Pose` shape. Allocates only the two small fixed-
 * length arrays returned by `toArray()`; safe at frame cadence. */
function readPose(obj: THREE.Object3D): Pose {
  const p = obj.position.toArray() as [number, number, number];
  const q = obj.quaternion.toArray() as [number, number, number, number];
  return { pos: p, quat: q };
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
