import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { XrControllers } from './xr-controllers.js';

/**
 * These tests don't touch Three.js's WebXR wiring — no WebGLRenderer, no
 * XRSession, no GL context. We only exercise the `connected` /
 * `disconnected` event branch, which is pure event bookkeeping on
 * Three.js Object3D (EventDispatcher). That branch is responsible for
 * matching the right XRInputSource to the right hand; getting it wrong
 * meant a left-hand strike rumbled the right controller (see the class
 * doc comment on `inputSources`).
 */

interface FakeSession {
  inputSources: XRInputSource[];
}

interface FakeXR {
  getController: (i: number) => THREE.Object3D;
  getControllerGrip: (i: number) => THREE.Object3D;
  getSession: () => FakeSession | null;
  addEventListener: (type: string, listener: (e: { type: string }) => void) => void;
  removeEventListener: (type: string, listener: (e: { type: string }) => void) => void;
  dispatchEvent: (e: { type: string }) => void;
  /** Test helper: simulate Three.js calling `setSession`. The fake
   * session is parked on `getSession()` and `sessionstart` is fired so
   * the class under test can read `session.inputSources`. Mirrors what
   * `webgl.xr.setSession()` does in Three.js's WebXRManager (see the
   * `sessionstart` dispatch around line 362 in WebXRManager.js). */
  startSession: (sources: XRInputSource[]) => void;
  endSession: () => void;
}

interface FakeWebGL {
  xr: FakeXR;
  controllers: THREE.Object3D[];
  grips: THREE.Object3D[];
}

function makeFakeWebGL(): FakeWebGL {
  const controllers = [new THREE.Object3D(), new THREE.Object3D()];
  const grips = [new THREE.Object3D(), new THREE.Object3D()];
  const listeners = new Map<string, Set<(e: { type: string }) => void>>();
  let session: FakeSession | null = null;
  const xr: FakeXR = {
    getController: (i) => controllers[i]!,
    getControllerGrip: (i) => grips[i]!,
    getSession: () => session,
    addEventListener: (type, listener) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (e) => {
      for (const l of listeners.get(e.type) ?? []) l(e);
    },
    startSession: (sources) => {
      session = { inputSources: sources };
      xr.dispatchEvent({ type: 'sessionstart' });
    },
    endSession: () => {
      session = null;
      xr.dispatchEvent({ type: 'sessionend' });
    },
  };
  return { xr, controllers, grips };
}

function fakeInputSource(handedness: 'left' | 'right'): XRInputSource {
  return { handedness } as unknown as XRInputSource;
}

type PulseSpy = (intensity: number, durationMs: number) => Promise<boolean>;
interface FakeGamepadSource {
  handedness: 'left' | 'right';
  gamepad: {
    hapticActuators: { pulse: PulseSpy }[];
  };
}
function fakeInputSourceWithGamepad(
  handedness: 'left' | 'right',
  pulse: PulseSpy,
): XRInputSource {
  const src: FakeGamepadSource = {
    handedness,
    gamepad: { hapticActuators: [{ pulse }] },
  };
  return src as unknown as XRInputSource;
}

/** Three.js EventDispatcher accepts arbitrary-shape event objects as long
 * as they carry a `type` string. The `data` field mirrors what Quest
 * Browser actually delivers with the XRInputSource. We go through `any`
 * because Three.js's Object3DEventMap is a closed union that doesn't
 * include the XR-specific `connected` / `disconnected` types. */
type LooseDispatcher = { dispatchEvent(e: { type: string; data?: unknown }): void };
function dispatchConnected(target: THREE.Object3D, data: XRInputSource): void {
  (target as unknown as LooseDispatcher).dispatchEvent({ type: 'connected', data });
}
function dispatchDisconnected(target: THREE.Object3D, data: XRInputSource): void {
  (target as unknown as LooseDispatcher).dispatchEvent({ type: 'disconnected', data });
}

function makeStarted(): { xr: XrControllers; gl: FakeWebGL; scene: THREE.Scene } {
  const gl = makeFakeWebGL();
  const scene = new THREE.Scene();
  const xr = new XrControllers(
    gl as unknown as THREE.WebGLRenderer,
    scene,
  );
  xr.start();
  return { xr, gl, scene };
}

describe('XrControllers — input source tracking', () => {
  it('starts with both slots null (no controllers connected yet)', () => {
    const { xr } = makeStarted();
    expect(Array.from(xr.currentInputSources)).toEqual([null, null]);
  });

  it('captures the XRInputSource on `connected` into the slot matching the controller index', () => {
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    dispatchConnected(gl.controllers[0]!, leftSrc);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(null);
  });

  it('handles both controllers independently — left does not bleed into right', () => {
    // Ordering-independence is the whole reason this listener exists
    // (see class doc). Reverse-order connect to catch accidental shared-
    // index bugs.
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[1]!, rightSrc);
    dispatchConnected(gl.controllers[0]!, leftSrc);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
  });

  it('clears the slot on `disconnected` (Quest user powers off one controller)', () => {
    const { xr, gl } = makeStarted();
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[1]!, rightSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
    dispatchDisconnected(gl.controllers[1]!, rightSrc);
    expect(xr.currentInputSources[1]).toBe(null);
    // Other slot untouched.
    expect(xr.currentInputSources[0]).toBe(null);
  });

  it('supports reconnection (controller drops out and comes back) without wedging the slot', () => {
    const { xr, gl } = makeStarted();
    const a = fakeInputSource('left');
    const b = fakeInputSource('left');
    dispatchConnected(gl.controllers[0]!, a);
    dispatchDisconnected(gl.controllers[0]!, a);
    dispatchConnected(gl.controllers[0]!, b);
    expect(xr.currentInputSources[0]).toBe(b);
  });

  it('ignores `connected` payloads that lack the `data` field — defensive', () => {
    // Some WebXR polyfills fire events with no `data`. The handler
    // guards on `if (data)`; without that, the slot would get `undefined`
    // and the downstream haptic code would crash trying to read
    // `.gamepad.hapticActuators` off undefined.
    const { xr, gl } = makeStarted();
    (gl.controllers[0]! as unknown as LooseDispatcher).dispatchEvent({ type: 'connected' });
    expect(xr.currentInputSources[0]).toBe(null);
  });

  it('`currentInputSources` getter returns a live view (changes reflect without re-calling start)', () => {
    const { xr, gl } = makeStarted();
    const snap1 = xr.currentInputSources;
    const src = fakeInputSource('right');
    dispatchConnected(gl.controllers[0]!, src);
    // Same underlying array → the earlier reference reflects the new
    // state. Callers (Game's cancel-squeeze poller) rely on this so
    // they can cache the array once and read live state per tick.
    expect(snap1[0]).toBe(src);
  });

  it('inputSourceByHand returns the hand regardless of slot index', () => {
    // If the right controller connects into slot 0, lookups by hand
    // must still return the right one. Guards the loop-marker /
    // left-quit mapping in game.ts from silent inversion on runtimes
    // that don't emit connected events in left-then-right order.
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[0]!, rightSrc);
    dispatchConnected(gl.controllers[1]!, leftSrc);
    expect(xr.inputSourceByHand('left')).toBe(leftSrc);
    expect(xr.inputSourceByHand('right')).toBe(rightSrc);
  });

  it('inputSourceByHand returns null when that hand is disconnected', () => {
    const { xr, gl } = makeStarted();
    dispatchConnected(gl.controllers[0]!, fakeInputSource('right'));
    expect(xr.inputSourceByHand('left')).toBe(null);
  });

  // Haptic routing regression: the slot that detected a hit and the
  // slot whose actuator we pulse must be THE SAME slot. An earlier
  // iteration added a handedness-based lookup between the two that
  // made hit detection slot-indexed but vibration handedness-indexed
  // — any disagreement between the cached-slot handedness and the
  // live-session handedness would buzz the wrong hand. The fix is to
  // always read `inputSources[i]` directly in pulseHaptic, matching
  // what captureSamples(i) does for hit detection.
  it('currentInputSources[i] is the exact reference captured from slot i\'s connected event', () => {
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[0]!, leftSrc);
    dispatchConnected(gl.controllers[1]!, rightSrc);
    // Not just handedness-equal — REFERENCE-equal. pulseHaptic pulls
    // `.gamepad.hapticActuators[0]` off this exact object; if the
    // pulse path ever resolved through a different lookup (e.g. live
    // iteration by handedness), a stale cache could drift and pulse
    // the wrong actuator.
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
  });

  // Directly exercise pulseHaptic's actuator resolution. Each slot gets
  // its own pulse spy; calling pulseHaptic(i) must hit slot i's spy and
  // no other. This is the slot→actuator invariant the 6f5bca6
  // resolveHapticSource helper broke — verified here via the private
  // method so we catch future regressions even if the call site
  // changes.
  it('pulseHaptic(i) hits inputSources[i]\'s actuator and no other slot\'s', async () => {
    const { xr, gl } = makeStarted();
    const leftCalls: Array<[number, number]> = [];
    const rightCalls: Array<[number, number]> = [];
    const leftSrc = fakeInputSourceWithGamepad('left', async (intensity, durationMs) => {
      leftCalls.push([intensity, durationMs]);
      return true;
    });
    const rightSrc = fakeInputSourceWithGamepad('right', async (intensity, durationMs) => {
      rightCalls.push([intensity, durationMs]);
      return true;
    });
    // Intentionally populate reversed: slot 0 gets the RIGHT-handed
    // source, slot 1 gets the LEFT-handed one. A handedness-based
    // reroute (the bug) would then send pulseHaptic(0) to the LEFT
    // actuator. Slot-indexed routing (the fix) pulses slot 0's spy
    // regardless of handedness label.
    dispatchConnected(gl.controllers[0]!, rightSrc);
    dispatchConnected(gl.controllers[1]!, leftSrc);

    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    pulseHaptic(0);
    // Pulse resolves asynchronously; flush microtasks.
    await Promise.resolve();
    expect(rightCalls).toEqual([[0.6, 40]]);
    expect(leftCalls).toEqual([]);

    pulseHaptic(1);
    await Promise.resolve();
    expect(rightCalls).toEqual([[0.6, 40]]);
    expect(leftCalls).toEqual([[0.6, 40]]);
  });

  it('pulseHaptic no-ops silently when the slot is null (no double-buzz, no crash)', () => {
    const { xr } = makeStarted();
    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    expect(() => pulseHaptic(0)).not.toThrow();
    expect(() => pulseHaptic(1)).not.toThrow();
  });

  it('pulseHaptic no-ops when the gamepad exposes no hapticActuators (older runtimes)', () => {
    const { xr, gl } = makeStarted();
    // Gamepad present but hapticActuators absent — early return, no
    // throw. Matches Chrome < 89 / non-Quest runtimes behaviour.
    const src = {
      handedness: 'left',
      gamepad: {} as Gamepad,
    } as unknown as XRInputSource;
    dispatchConnected(gl.controllers[0]!, src);
    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    expect(() => pulseHaptic(0)).not.toThrow();
  });

  it('adds the controllers and grips to the scene (wiring sanity)', () => {
    const { scene, gl } = makeStarted();
    // Both controllers + both grips must end up parented under the scene
    // so Three.js moves them to match the headset pose.
    expect(scene.children).toContain(gl.controllers[0]);
    expect(scene.children).toContain(gl.controllers[1]);
    expect(scene.children).toContain(gl.grips[0]);
    expect(scene.children).toContain(gl.grips[1]);
  });

  it('captures `connected` events that fire BEFORE start() — listener wired in ctor', () => {
    // Regression for the "right hit → left buzz, left hit → nothing"
    // bug. Three.js dispatches the initial `connected` events during
    // the first `onAnimationFrame` of an XR session, not synchronously
    // inside `setSession`. If we attach listeners inside start()
    // (called right after await renderer.enterXR()), the timing
    // race can leave listeners behind the first-frame dispatch on
    // some Quest runtimes — inputSources[i] stays null and
    // pulseHaptic silently no-ops. The fix is to attach listeners in
    // the ctor so they're live across the entire session lifecycle;
    // this test drives that contract directly by dispatching the
    // events BEFORE start() runs.
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const xr = new XrControllers(
      gl as unknown as THREE.WebGLRenderer,
      scene,
    );
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    // Events before start() — matches the real flow where
    // Three.js fires 'connected' during the first XR animation
    // frame and the host's start() runs right after setSession.
    dispatchConnected(gl.controllers[0]!, leftSrc);
    dispatchConnected(gl.controllers[1]!, rightSrc);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
    xr.start();
    // start() must not clobber pre-captured input sources.
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
  });

  it('adds controllers to the scene from the ctor (before start)', () => {
    // Companion to the listener test above: if controllers aren't
    // parented into the scene at ctor time, Three.js won't update
    // their world pose on the first frame — the grip we capture
    // stick samples from would read stale / identity positions and
    // no hits would register even after listeners populate
    // inputSources[i]. Ctor-time scene.add is the other half of the
    // regression fix.
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    new XrControllers(gl as unknown as THREE.WebGLRenderer, scene);
    expect(scene.children).toContain(gl.controllers[0]);
    expect(scene.children).toContain(gl.controllers[1]);
  });

  // Session-level backstop: Three.js WebXRManager subscribes to the
  // session's `inputsourceschange` event and relies on the runtime to
  // deliver a synthetic initial event listing already-connected
  // controllers. Some runtimes / polyfills / device emulators don't —
  // slots stay null and pulseHaptic silently no-ops even though both
  // physical controllers are on. Reading `session.inputSources` on
  // `sessionstart` directly covers this gap without disturbing the
  // primary per-controller connected/disconnected path.
  it('syncs both slots from session.inputSources on sessionstart when per-controller connected events are missed', () => {
    const { xr, gl } = makeStarted();
    expect(Array.from(xr.currentInputSources)).toEqual([null, null]);
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    // Simulate Three.js's setSession: parks session on xr.getSession()
    // and fires sessionstart — but does NOT dispatch per-controller
    // connected events, matching the runtime quirk this backstop is
    // for.
    gl.xr.startSession([leftSrc, rightSrc]);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
  });

  it('sessionstart fills only the empty slot when one connected event already fired', () => {
    // A mixed scenario: runtime delivered one per-controller event but
    // missed the other. The sessionstart sync must fill the null slot
    // without clobbering the already-captured reference (the connected
    // event's XRInputSource is the same object the runtime has in
    // session.inputSources, but we defend against over-writing in case
    // a test or future runtime delivers a distinct object).
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[0]!, leftSrc);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(null);
    gl.xr.startSession([leftSrc, rightSrc]);
    expect(xr.currentInputSources[0]).toBe(leftSrc); // unchanged
    expect(xr.currentInputSources[1]).toBe(rightSrc); // filled by backstop
  });

  it('sessionstart is a no-op when session.inputSources is empty', () => {
    // Runtime entered XR with no controllers on (keyboard-only session,
    // inline mode, or the player hasn't powered them on yet). Backstop
    // must not crash or populate bogus slots; per-controller connected
    // events will fire later as controllers wake up.
    const { xr, gl } = makeStarted();
    gl.xr.startSession([]);
    expect(Array.from(xr.currentInputSources)).toEqual([null, null]);
  });

  it('sessionend clears both slots', () => {
    // Player exits XR → slots must drop references so the next session
    // starts clean and pulseHaptic can't accidentally fire against a
    // stale XRInputSource whose gamepad is no longer live.
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    gl.xr.startSession([leftSrc, rightSrc]);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
    gl.xr.endSession();
    expect(Array.from(xr.currentInputSources)).toEqual([null, null]);
  });

  it('pulseHaptic(i) routes to the slot sessionstart populated — slot↔actuator invariant holds across the backstop path', async () => {
    // The whole reason the backstop exists is so pulseHaptic has a
    // source to pulse. Verify slot alignment end-to-end: session
    // backstop fills slot i, pulseHaptic(i) hits slot i's actuator.
    const { xr, gl } = makeStarted();
    const slot0Calls: Array<[number, number]> = [];
    const slot1Calls: Array<[number, number]> = [];
    const src0 = fakeInputSourceWithGamepad('left', async (intensity, durationMs) => {
      slot0Calls.push([intensity, durationMs]);
      return true;
    });
    const src1 = fakeInputSourceWithGamepad('right', async (intensity, durationMs) => {
      slot1Calls.push([intensity, durationMs]);
      return true;
    });
    gl.xr.startSession([src0, src1]);
    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    pulseHaptic(0);
    await Promise.resolve();
    expect(slot0Calls).toEqual([[0.6, 40]]);
    expect(slot1Calls).toEqual([]);
    pulseHaptic(1);
    await Promise.resolve();
    expect(slot1Calls).toEqual([[0.6, 40]]);
  });
});
