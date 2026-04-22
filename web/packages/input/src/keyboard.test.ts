import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_MAP,
  DEFAULT_MENU_MAP,
  KeyboardInput,
  Lane,
  type LaneHitEvent,
  type MenuEvent,
} from './keyboard.js';

/**
 * We test against Node's built-in EventTarget (a supertype of Window /
 * HTMLElement). KeyboardInput only uses addEventListener /
 * removeEventListener and casts the dispatched Event to KeyboardEvent,
 * so a plain Event with `.code` / `.repeat` fields attached works.
 */
function makeKeyEvent(code: string, opts: { repeat?: boolean } = {}): Event {
  const e = new Event('keydown', { cancelable: true }) as Event & {
    code: string;
    repeat: boolean;
  };
  e.code = code;
  e.repeat = opts.repeat ?? false;
  return e;
}

function makeTarget(): EventTarget {
  // Plain EventTarget satisfies the Window | HTMLElement surface
  // KeyboardInput actually touches.
  return new EventTarget();
}

describe('DEFAULT_KEY_MAP — sanity', () => {
  it('covers every lane exactly once', () => {
    const laneValues = Object.values(Lane);
    for (const lv of laneValues) {
      expect(DEFAULT_KEY_MAP[lv], `lane 0x${lv.toString(16)}`).toBeDefined();
      expect(DEFAULT_KEY_MAP[lv]!.length, `lane 0x${lv.toString(16)}`).toBeGreaterThan(0);
    }
  });

  it('has no key bound to two different lanes — one key, one meaning', () => {
    // A reverse-lookup collision would make a single keystroke fire two
    // lanes at once, which is silent nonsense. Pin the invariant so a
    // refactor of DEFAULT_KEY_MAP trips it.
    const seen = new Map<string, number>();
    for (const [lane, keys] of Object.entries(DEFAULT_KEY_MAP)) {
      for (const k of keys) {
        const prev = seen.get(k);
        expect(prev, `${k} collides with lane 0x${prev?.toString(16)}`).toBeUndefined();
        seen.set(k, Number(lane));
      }
    }
  });

  it('does not overlap with DEFAULT_MENU_MAP — a menu key never triggers a drum', () => {
    // Pressing ArrowUp while on the song wheel must NOT also fire a
    // lane. Enforce disjointness.
    const laneKeys = new Set<string>();
    for (const keys of Object.values(DEFAULT_KEY_MAP)) for (const k of keys) laneKeys.add(k);
    for (const menuKey of Object.keys(DEFAULT_MENU_MAP)) {
      expect(laneKeys.has(menuKey), `${menuKey} shared with a lane`).toBe(false);
    }
  });
});

describe('KeyboardInput', () => {
  let target: EventTarget;
  let kb: KeyboardInput;
  let laneHits: LaneHitEvent[];
  let menuHits: MenuEvent[];

  beforeEach(() => {
    target = makeTarget();
    kb = new KeyboardInput({ target: target as unknown as Window });
    laneHits = [];
    menuHits = [];
    kb.onLaneHit((e) => laneHits.push(e));
    kb.onMenu((e) => menuHits.push(e));
    kb.attach();
  });

  afterEach(() => {
    kb.detach();
  });

  it('dispatches a lane hit for a default-mapped lane key', () => {
    target.dispatchEvent(makeKeyEvent('KeyH'));
    expect(laneHits).toHaveLength(1);
    expect(laneHits[0]?.lane).toBe(Lane.HH);
    expect(laneHits[0]?.key).toBe('KeyH');
    expect(typeof laneHits[0]?.timestampMs).toBe('number');
    expect(menuHits).toHaveLength(0);
  });

  it('both default keys for a multi-key lane fire the same lane', () => {
    target.dispatchEvent(makeKeyEvent('KeyS'));
    target.dispatchEvent(makeKeyEvent('KeyD'));
    expect(laneHits.map((h) => h.lane)).toEqual([Lane.SD, Lane.SD]);
  });

  it('dispatches menu actions for default menu keys', () => {
    target.dispatchEvent(makeKeyEvent('ArrowUp'));
    target.dispatchEvent(makeKeyEvent('Enter'));
    target.dispatchEvent(makeKeyEvent('Escape'));
    expect(menuHits.map((m) => m.action)).toEqual(['up', 'confirm', 'cancel']);
    expect(laneHits).toHaveLength(0);
  });

  it('drops events with e.repeat === true (OS auto-repeat)', () => {
    // A held-down key must not spam hit events at the OS repeat rate —
    // that would look like a perfect-timing roll to the matcher.
    target.dispatchEvent(makeKeyEvent('KeyH', { repeat: true }));
    target.dispatchEvent(makeKeyEvent('ArrowUp', { repeat: true }));
    expect(laneHits).toHaveLength(0);
    expect(menuHits).toHaveLength(0);
  });

  it('ignores unmapped keys (no lane, no menu dispatch)', () => {
    target.dispatchEvent(makeKeyEvent('F13'));
    target.dispatchEvent(makeKeyEvent('NumpadAdd'));
    expect(laneHits).toHaveLength(0);
    expect(menuHits).toHaveLength(0);
  });

  it('calls preventDefault on handled events so the browser does not scroll/type', () => {
    // Without preventDefault, Space (BD) would also scroll the page and
    // ArrowUp (menu) would scroll the scrollbar. Verify via
    // defaultPrevented flag after dispatch.
    const spaceEv = makeKeyEvent('Space');
    target.dispatchEvent(spaceEv);
    expect(spaceEv.defaultPrevented).toBe(true);

    const arrowEv = makeKeyEvent('ArrowUp');
    target.dispatchEvent(arrowEv);
    expect(arrowEv.defaultPrevented).toBe(true);

    // Unmapped key must NOT have preventDefault called — we don't want
    // to eat keys we don't own (e.g. DevTools shortcuts).
    const ignoredEv = makeKeyEvent('F13');
    target.dispatchEvent(ignoredEv);
    expect(ignoredEv.defaultPrevented).toBe(false);
  });

  it('keyMap override merges with defaults (not replacement)', () => {
    const local = makeTarget();
    const k = new KeyboardInput({
      target: local as unknown as Window,
      keyMap: { [Lane.HH]: ['KeyQ'] }, // remap HH to Q
    });
    k.attach();
    const hits: LaneHitEvent[] = [];
    k.onLaneHit((e) => hits.push(e));

    local.dispatchEvent(makeKeyEvent('KeyQ'));
    expect(hits[0]?.lane).toBe(Lane.HH);

    // Other lanes still work via defaults — the merge keeps them.
    local.dispatchEvent(makeKeyEvent('Space'));
    expect(hits[1]?.lane).toBe(Lane.BD);

    k.detach();
  });

  it('attach is idempotent and detach is idempotent', () => {
    // Catches a double-subscribe that would fire each hit twice.
    const spy = vi.spyOn(target, 'addEventListener');
    kb.attach();
    kb.attach();
    expect(spy).toHaveBeenCalledTimes(0); // already attached from beforeEach, no new calls
    spy.mockRestore();

    kb.detach();
    kb.detach(); // no throw
    target.dispatchEvent(makeKeyEvent('KeyH'));
    // No handler after detach → no hit delivered.
    expect(laneHits).toHaveLength(0);
  });

  it('onLaneHit / onMenu unsubscribers stop further deliveries', () => {
    const extra: LaneHitEvent[] = [];
    const unsub = kb.onLaneHit((e) => extra.push(e));

    target.dispatchEvent(makeKeyEvent('KeyH'));
    expect(extra).toHaveLength(1);
    unsub();
    target.dispatchEvent(makeKeyEvent('KeyS'));
    // The base handler from beforeEach still fires (laneHits = 2 total),
    // but the unsubscribed one should stay at 1.
    expect(extra).toHaveLength(1);
    expect(laneHits).toHaveLength(2);
  });
});
