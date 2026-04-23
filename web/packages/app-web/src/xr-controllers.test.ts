import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { XrControllers, resolveHapticSource } from './xr-controllers.js';

/**
 * These tests don't touch Three.js's WebXR wiring — no WebGLRenderer, no
 * XRSession, no GL context. We only exercise the `connected` /
 * `disconnected` event branch, which is pure event bookkeeping on
 * Three.js Object3D (EventDispatcher). That branch is responsible for
 * matching the right XRInputSource to the right hand; getting it wrong
 * meant a left-hand strike rumbled the right controller (see the class
 * doc comment on `inputSources`).
 */

interface FakeWebGL {
  xr: {
    getController: (i: number) => THREE.Object3D;
    getControllerGrip: (i: number) => THREE.Object3D;
    getSession: () => null;
  };
  controllers: THREE.Object3D[];
  grips: THREE.Object3D[];
}

function makeFakeWebGL(): FakeWebGL {
  const controllers = [new THREE.Object3D(), new THREE.Object3D()];
  const grips = [new THREE.Object3D(), new THREE.Object3D()];
  return {
    xr: {
      getController: (i) => controllers[i]!,
      getControllerGrip: (i) => grips[i]!,
      getSession: () => null,
    },
    controllers,
    grips,
  };
}

function fakeInputSource(handedness: 'left' | 'right'): XRInputSource {
  return { handedness } as unknown as XRInputSource;
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

  it('resolveHapticSource prefers the live source with matching handedness over the cached slot entry', () => {
    // Scenario: a brief right-controller disconnect/reconnect re-seats
    // it into slot 0, so the live session has a NEW right input source
    // while the cached slot-1 entry still points at the stale (now-
    // disconnected) right source. Pulsing the cached entry would go to
    // a dead gamepad — resolveHapticSource must pick the live one.
    const staleRight = { handedness: 'right' } as unknown as XRInputSource;
    const liveRight = { handedness: 'right' } as unknown as XRInputSource;
    const liveLeft = { handedness: 'left' } as unknown as XRInputSource;
    const liveSources: XRInputSource[] = [liveRight, liveLeft];
    expect(resolveHapticSource(liveSources, staleRight)).toBe(liveRight);
  });

  it('resolveHapticSource returns null when the live list has no matching hand (stale cache would be wrong)', () => {
    // Guards against the specific bug the helper was written to fix:
    // a slot caching a now-disconnected input source while the live
    // session has only the other hand. Pulsing the cached entry would
    // fire a dead gamepad at best and the wrong hand at worst.
    // Returning null tells the caller to skip the pulse.
    const cachedLeft = { handedness: 'left' } as unknown as XRInputSource;
    const liveRight = { handedness: 'right' } as unknown as XRInputSource;
    expect(resolveHapticSource([liveRight], cachedLeft)).toBe(null);
  });

  it('resolveHapticSource returns null for slots with no tracked hand', () => {
    // handedness='none' (trackers, some hand-tracking entries) has no
    // actuator we want to pulse. Callers skip the pulse on null.
    const trackerSrc = { handedness: 'none' } as unknown as XRInputSource;
    expect(resolveHapticSource([trackerSrc], trackerSrc)).toBe(null);
    expect(resolveHapticSource([], null)).toBe(null);
  });

  it('resolveHapticSource picks the correctly-handed source even if live list is reordered', () => {
    // The class doc comment flags this specifically — slot index ≠
    // session.inputSources order on all runtimes. Handedness is the
    // only authoritative key.
    const cachedRight = { handedness: 'right' } as unknown as XRInputSource;
    const liveLeft = { handedness: 'left' } as unknown as XRInputSource;
    const liveRight = { handedness: 'right' } as unknown as XRInputSource;
    // Left first in the live list; the cached slot is 'right'. Must
    // still return the right-handed live source, not the first entry.
    expect(resolveHapticSource([liveLeft, liveRight], cachedRight)).toBe(liveRight);
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
});
