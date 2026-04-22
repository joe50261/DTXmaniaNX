import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAMEPAD_MAP,
  DEFAULT_GAMEPAD_MENU_MAP,
  GamepadInput,
} from './gamepad.js';
import { Lane, type LaneHitEvent, type MenuEvent } from './keyboard.js';

/** Build a fake Gamepad snapshot matching the Gamepad API surface we read. */
function makePad(
  buttons: readonly { pressed: boolean; value?: number }[],
  index = 0,
): Gamepad {
  return {
    id: 'test-pad',
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [],
    buttons: buttons.map((b) => ({
      pressed: b.pressed,
      touched: b.pressed,
      value: b.value ?? (b.pressed ? 1 : 0),
    })),
    vibrationActuator: null,
    hapticActuators: [],
  } as unknown as Gamepad;
}

/** Array of N released buttons, then overlay the specified pressed set. */
function releasedPad(size: number, pressed: readonly number[] = [], index = 0): Gamepad {
  const arr = Array.from({ length: size }, () => ({ pressed: false, value: 0 }));
  for (const i of pressed) {
    const slot = arr[i];
    if (slot) {
      slot.pressed = true;
      slot.value = 1;
    }
  }
  return makePad(arr, index);
}

describe('DEFAULT_GAMEPAD_MAP — sanity', () => {
  it('does not share an index between lane and menu maps', () => {
    for (const idx of Object.keys(DEFAULT_GAMEPAD_MAP)) {
      expect(DEFAULT_GAMEPAD_MENU_MAP[Number(idx)]).toBeUndefined();
    }
  });
});

describe('GamepadInput._tick — edge detection', () => {
  it('fires LaneHitEvent on 0→1 edge only, not while held', () => {
    const gp = new GamepadInput();
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    // Frame 1: all released.
    gp._tick(0, [releasedPad(16)]);
    expect(hits).toHaveLength(0);

    // Frame 2: A pressed. Expect one BD hit.
    gp._tick(16, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.lane).toBe(Lane.BD);
    expect(hits[0]?.timestampMs).toBe(16);

    // Frame 3: A still held. No new hit.
    gp._tick(32, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(1);

    // Frame 4: release + re-press → new hit.
    gp._tick(48, [releasedPad(16)]);
    gp._tick(64, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(2);
  });

  it('maps multiple simultaneous presses to their lanes in one frame', () => {
    const gp = new GamepadInput();
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    gp._tick(0, [releasedPad(16)]);
    // A (BD) + B (SD) + LB (HH) pressed at once.
    gp._tick(16, [releasedPad(16, [0, 1, 4])]);

    expect(hits.map((h) => h.lane).sort()).toEqual([Lane.BD, Lane.SD, Lane.HH].sort());
  });

  it('fires MenuEvent for dpad + Start/Back, not LaneHitEvent', () => {
    const gp = new GamepadInput();
    const laneHits: LaneHitEvent[] = [];
    const menuHits: MenuEvent[] = [];
    gp.onLaneHit((e) => laneHits.push(e));
    gp.onMenu((e) => menuHits.push(e));

    gp._tick(0, [releasedPad(16)]);
    gp._tick(16, [releasedPad(16, [8])]);  // Back → cancel
    gp._tick(16, [releasedPad(16)]);
    gp._tick(32, [releasedPad(16, [12])]); // dpad up
    gp._tick(32, [releasedPad(16)]);
    gp._tick(48, [releasedPad(16, [9])]);  // Start → confirm

    expect(laneHits).toHaveLength(0);
    expect(menuHits.map((m) => m.action)).toEqual(['cancel', 'up', 'confirm']);
  });

  it('isGated=true suppresses all events and drops held-state cache', () => {
    let gated = false;
    const gp = new GamepadInput({ isGated: () => gated });
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    // Press A while ungated → fires.
    gp._tick(0, [releasedPad(16)]);
    gp._tick(16, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(1);

    // Gate on: hold + tick → no event.
    gated = true;
    gp._tick(32, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(1);

    // Gate off with A still held. Because gate cleared the cache, A looks
    // like a fresh edge again — this matches keyboard behaviour after a
    // focus loss, where the browser stops reporting repeat keys. Document
    // the behaviour so a regression flips the test, not silently fires a
    // phantom hit.
    gated = false;
    gp._tick(48, [releasedPad(16, [0])]);
    expect(hits).toHaveLength(2);
  });

  it('tracks separate edge state per gamepad.index', () => {
    const gp = new GamepadInput();
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    // Pad 0 releases A, pad 1 presses A on the same frame.
    gp._tick(0, [releasedPad(16, [0], 0), releasedPad(16, [], 1)]);
    expect(hits).toHaveLength(1); // pad 0 edge

    gp._tick(16, [releasedPad(16, [0], 0), releasedPad(16, [0], 1)]);
    expect(hits).toHaveLength(2); // pad 1 edge; pad 0 still held, no repeat
  });

  it('honours buttonMap override (merged with defaults)', () => {
    const gp = new GamepadInput({ buttonMap: { 0: Lane.CY } });
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    gp._tick(0, [releasedPad(16)]);
    gp._tick(16, [releasedPad(16, [0])]); // overridden → CY
    gp._tick(16, [releasedPad(16)]);
    gp._tick(32, [releasedPad(16, [1])]); // default → SD

    expect(hits.map((h) => h.lane)).toEqual([Lane.CY, Lane.SD]);
  });

  it('treats analog trigger value > 0.5 as pressed even when pressed=false', () => {
    const gp = new GamepadInput();
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    // 16 slots: trigger at index 6 (LT → HHO) with value only.
    const arr = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    gp._tick(0, [makePad(arr)]);
    const lightTap = arr.map((b, i) =>
      i === 6 ? { pressed: false, value: 0.75 } : b,
    );
    gp._tick(16, [makePad(lightTap)]);

    expect(hits.map((h) => h.lane)).toEqual([Lane.HHO]);
  });

  it('ignores null slots in the gamepad array (disconnected pads)', () => {
    const gp = new GamepadInput();
    const hits: LaneHitEvent[] = [];
    gp.onLaneHit((e) => hits.push(e));

    // All four slots polled; only slot 2 has a pad. getGamepads returns
    // nulls for empty slots — the poller must not crash on them.
    // Frame 0 primes prev state via a fully-released snapshot.
    gp._tick(0, [null, null, releasedPad(16, [], 2), null]);
    gp._tick(16, [null, null, releasedPad(16, [0], 2), null]);
    expect(hits.map((h) => h.lane)).toEqual([Lane.BD]);

    // Hold → no repeat.
    gp._tick(32, [null, null, releasedPad(16, [0], 2), null]);
    expect(hits).toHaveLength(1);
  });
});
