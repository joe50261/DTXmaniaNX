import * as THREE from 'three';
import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * Maps Quest 3 (Touch Plus) controllers to drum lanes. MVP mapping until we
 * build a proper "hit the pad with the controller" collider:
 *
 *   Left trigger  → Snare
 *   Left grip     → HiHat
 *   Right trigger → Bass Drum
 *   Right grip    → Ride Cymbal
 *   Left thumbstick press  → Left Cymbal
 *   Right thumbstick press → High Tom (rotated for FloorTom / LowTom later)
 *
 * Uses the XRInputSource's standard gamepad button indexes:
 *   0 = trigger, 1 = squeeze/grip, 3 = thumbstick click, 4 = A/X, 5 = B/Y
 */

export interface XrLaneEvent {
  lane: LaneValue;
  timestampMs: number;
  /** Synthesised so the XR event satisfies the shared LaneHitEvent shape. */
  key: string;
}

export type XrLaneListener = (e: XrLaneEvent) => void;

type Handedness = 'left' | 'right';

const BUTTON_MAP: Record<Handedness, Record<number, LaneValue>> = {
  left: {
    0: Lane.SD,  // trigger
    1: Lane.HH,  // grip
    3: Lane.LC,  // thumbstick click
    4: Lane.LP,  // X
    5: Lane.HT,  // Y
  },
  right: {
    0: Lane.BD,  // trigger
    1: Lane.RD,  // grip
    3: Lane.CY,  // thumbstick click
    4: Lane.FT,  // A
    5: Lane.LT,  // B
  },
};

export class XrControllers {
  private listener: XrLaneListener | null = null;
  private readonly prev = new Map<string, boolean[]>();
  /**
   * The visible controller models + rays get added to the scene so the player
   * can see where their hands are. Cleaned up on stop().
   */
  private readonly groups: THREE.Group[] = [];

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {}

  onHit(cb: XrLaneListener): void {
    this.listener = cb;
  }

  start(): void {
    // Spawn visible laser pointers for each controller.
    for (let i = 0; i < 2; i++) {
      const grip = this.webgl.xr.getControllerGrip(i);
      const ray = this.webgl.xr.getController(i);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -1),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffffff })
      );
      line.scale.z = 2;
      ray.add(line);
      this.scene.add(grip);
      this.scene.add(ray);
      this.groups.push(grip, ray);
    }
  }

  /** Poll controller button states; call this once per frame. */
  tick(): void {
    if (!this.listener) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      const gamepad = src.gamepad;
      if (!gamepad) continue;
      const hand = src.handedness === 'left' || src.handedness === 'right' ? src.handedness : null;
      if (!hand) continue;
      const key = hand;
      const prev = this.prev.get(key) ?? [];
      const map = BUTTON_MAP[hand];
      for (let i = 0; i < gamepad.buttons.length; i++) {
        const pressed = gamepad.buttons[i]!.pressed;
        const wasPressed = prev[i] === true;
        if (pressed && !wasPressed) {
          const lane = map[i];
          if (lane !== undefined) {
            this.listener({
              lane,
              timestampMs: performance.now(),
              key: `xr-${hand}-btn${i}`,
            });
          }
        }
        prev[i] = pressed;
      }
      this.prev.set(key, prev);
    }
  }

  stop(): void {
    for (const g of this.groups) this.scene.remove(g);
    this.groups.length = 0;
    this.prev.clear();
    this.listener = null;
  }
}
