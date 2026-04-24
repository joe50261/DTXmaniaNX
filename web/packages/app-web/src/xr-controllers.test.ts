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
interface FakeWebGL {
  xr: {
    getController: (i: number) => THREE.Object3D;
    getControllerGrip: (i: number) => THREE.Object3D;
    getSession: () => FakeSession | null;
  };
  /** Mutable live input-source array — tests mirror `dispatchConnected`
   * calls here to simulate `session.inputSources` as seen from
   * `webgl.xr.getSession()`. pulseHaptic looks up the LIVE source by
   * handedness via this array (not via `this.inputSources[slot]`),
   * mirroring what Quest Browser returns. */
  session: FakeSession;
  controllers: THREE.Object3D[];
  grips: THREE.Object3D[];
}

function makeFakeWebGL(): FakeWebGL {
  const controllers = [new THREE.Object3D(), new THREE.Object3D()];
  const grips = [new THREE.Object3D(), new THREE.Object3D()];
  const session: FakeSession = { inputSources: [] };
  return {
    xr: {
      getController: (i) => controllers[i]!,
      getControllerGrip: (i) => grips[i]!,
      getSession: () => session,
    },
    session,
    controllers,
    grips,
  };
}

/** Connect an input source to both the `connected` event listener (which
 * populates `this.inputSources[slot]`) AND the fake session's live
 * `inputSources` array. Matches the real Quest Browser ordering where an
 * `inputsourceschange` both seats the source into `session.inputSources`
 * and fires `connected` on the matching controller. */
function connectAndSeat(gl: FakeWebGL, slot: number, src: XRInputSource): void {
  dispatchConnected(gl.controllers[slot]!, src);
  gl.session.inputSources[slot] = src;
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

type PlayEffectParams = {
  startDelay?: number;
  duration: number;
  weakMagnitude?: number;
  strongMagnitude?: number;
};
type PlayEffectSpy = (type: 'dual-rumble', params: PlayEffectParams) => Promise<string>;
interface FakeVibrationSource {
  handedness: 'left' | 'right';
  gamepad: {
    vibrationActuator: { playEffect: PlayEffectSpy };
    // hapticActuators intentionally absent so the fallback branch can't
    // accidentally satisfy a playEffect-targeted assertion.
  };
}
function fakeInputSourceWithVibration(
  handedness: 'left' | 'right',
  playEffect: PlayEffectSpy,
): XRInputSource {
  const src: FakeVibrationSource = {
    handedness,
    gamepad: { vibrationActuator: { playEffect } },
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

  // Cache identity: the `connected`-event cache must retain the exact
  // XRInputSource reference per slot. Game.ts's face-button poller
  // (leaveSong, loop-marker capture) reads `.gamepad.buttons` off this
  // cached reference; `.buttons` is a live list per the Gamepad spec,
  // so reading it off a stable cache is fine. (Haptic routing, by
  // contrast, has stopped using this cache after PR #15 — see the
  // session-inputSources live-lookup tests below for why.)
  it('currentInputSources[i] is the exact reference captured from slot i\'s connected event', () => {
    const { xr, gl } = makeStarted();
    const leftSrc = fakeInputSource('left');
    const rightSrc = fakeInputSource('right');
    dispatchConnected(gl.controllers[0]!, leftSrc);
    dispatchConnected(gl.controllers[1]!, rightSrc);
    expect(xr.currentInputSources[0]).toBe(leftSrc);
    expect(xr.currentInputSources[1]).toBe(rightSrc);
  });

  // Fallback path: runtimes that expose only the legacy hapticActuators
  // array (pre-`vibrationActuator` Chrome / non-Quest WebXR backends)
  // must still pulse the correct hand's actuator. Resolution goes
  // slot → cachedHand → live session → matching live source → legacy
  // actuator. Populate slot 0 with the RIGHT-handed source and slot 1
  // with the LEFT-handed source (reversed on purpose) so an accidental
  // regression to raw slot-indexed lookup would buzz the wrong hand.
  it('pulseHaptic(i) bridges slot → cached handedness → live session → legacy actuator', async () => {
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
    connectAndSeat(gl, 0, rightSrc);
    connectAndSeat(gl, 1, leftSrc);

    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    // Slot 0's cached handedness is 'right' → live lookup finds rightSrc
    // → rightCalls fires. leftCalls must stay empty.
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

  // Primary haptic path: the standards-compliant
  // `gamepad.vibrationActuator.playEffect('dual-rumble', ...)`.
  // When it's available on the live input source, it must run and the
  // legacy fallback must stay inert.
  it('pulseHaptic prefers vibrationActuator.playEffect over legacy hapticActuators[0].pulse', async () => {
    const { xr, gl } = makeStarted();
    const playEffectCalls: Array<['dual-rumble', PlayEffectParams]> = [];
    const pulseCalls: Array<[number, number]> = [];
    const src = {
      handedness: 'right',
      gamepad: {
        vibrationActuator: {
          playEffect: async (type: 'dual-rumble', params: PlayEffectParams) => {
            playEffectCalls.push([type, params]);
            return 'complete';
          },
        },
        hapticActuators: [
          {
            pulse: async (intensity: number, durationMs: number) => {
              pulseCalls.push([intensity, durationMs]);
              return true;
            },
          },
        ],
      },
    } as unknown as XRInputSource;
    connectAndSeat(gl, 1, src);
    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    pulseHaptic(1);
    await Promise.resolve();
    expect(playEffectCalls).toEqual([
      ['dual-rumble', { duration: 40, strongMagnitude: 0.6, weakMagnitude: 0.6 }],
    ]);
    // Legacy path must be inert while playEffect is available.
    expect(pulseCalls).toEqual([]);
  });

  // Parallel to the legacy-path routing test above, but for the
  // vibrationActuator path. Each hand gets its own playEffect spy;
  // pulseHaptic(i) must resolve slot i to the matching-handedness live
  // source and hit exactly that spy.
  it('pulseHaptic(i) bridges slot → cached handedness → live session → playEffect', async () => {
    const { xr, gl } = makeStarted();
    const leftCalls: Array<['dual-rumble', PlayEffectParams]> = [];
    const rightCalls: Array<['dual-rumble', PlayEffectParams]> = [];
    const leftSrc = fakeInputSourceWithVibration('left', async (t, p) => {
      leftCalls.push([t, p]);
      return 'complete';
    });
    const rightSrc = fakeInputSourceWithVibration('right', async (t, p) => {
      rightCalls.push([t, p]);
      return 'complete';
    });
    connectAndSeat(gl, 0, rightSrc);
    connectAndSeat(gl, 1, leftSrc);
    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    pulseHaptic(0);
    await Promise.resolve();
    expect(rightCalls.length).toBe(1);
    expect(leftCalls.length).toBe(0);
    pulseHaptic(1);
    await Promise.resolve();
    expect(rightCalls.length).toBe(1);
    expect(leftCalls.length).toBe(1);
  });

  // The point of PR #15: when Quest Browser retains our cached
  // XRInputSource reference but swaps the live `session.inputSources`
  // entry (same handedness, different object, different gamepad /
  // actuator reference underneath), pulseHaptic MUST pulse the LIVE
  // actuator, not the stale cached one. Before this fix, three PRs worth
  // of diagnostic logs showed slot↔handedness was correct and both
  // `hapticActuators[0].pulse` AND `vibrationActuator.playEffect` on the
  // cached source routed to the wrong physical controller on Quest 3
  // Touch Plus.
  it('pulseHaptic follows the LIVE session.inputSources entry, not the cached one', async () => {
    const { xr, gl } = makeStarted();
    const staleCalls: Array<['dual-rumble', PlayEffectParams]> = [];
    const liveCalls: Array<['dual-rumble', PlayEffectParams]> = [];
    const staleRight = fakeInputSourceWithVibration('right', async (t, p) => {
      staleCalls.push([t, p]);
      return 'complete';
    });
    const liveRight = fakeInputSourceWithVibration('right', async (t, p) => {
      liveCalls.push([t, p]);
      return 'complete';
    });
    // Cache the STALE reference via the `connected` event listener.
    dispatchConnected(gl.controllers[1]!, staleRight);
    // Seat a DIFFERENT-object right-handed source as the live session
    // entry — this is the Quest Browser behaviour we're guarding against
    // (same handedness, different XRInputSource object, different
    // gamepad/actuator references under the hood).
    gl.session.inputSources[1] = liveRight;

    const pulseHaptic = (xr as unknown as { pulseHaptic: (i: number) => void }).pulseHaptic.bind(xr);
    pulseHaptic(1);
    await Promise.resolve();
    expect(liveCalls.length).toBe(1);
    expect(staleCalls.length).toBe(0);
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
    connectAndSeat(gl, 0, src);
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
});
