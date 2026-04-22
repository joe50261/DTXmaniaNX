/**
 * Standard-mapped gamepad → DTX drum lane + menu events.
 *
 * Polling model: the Gamepad API has no event surface, so `attach()` starts
 * a requestAnimationFrame loop that snapshots `navigator.getGamepads()`
 * every frame and fires on rising edges (pressed ← 0 → 1). Held buttons
 * do NOT re-fire — otherwise the matcher would see an OS-repeat-style
 * roll on every frame the button is down.
 *
 * XR gating: VR sessions run their own controller path via XrControllers.
 * When `isGated()` returns true we early-return and clear the pressed-state
 * cache, so a button held across XR enter/exit doesn't dump a phantom hit
 * on the first non-XR frame.
 */

import {
  Lane,
  type LaneValue,
  type LaneHitEvent,
  type LaneHitHandler,
  type MenuEvent,
  type MenuHandler,
} from './keyboard.js';

/** Button index → DTX lane. Based on the "standard" gamepad mapping
 * (Xbox-layout): 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT,
 * 8=Back, 9=Start, 10=LS-click, 11=RS-click, 12-15=dpad. */
export const DEFAULT_GAMEPAD_MAP: Readonly<Record<number, LaneValue>> = {
  0: Lane.BD,   // A
  1: Lane.SD,   // B
  2: Lane.HT,   // X
  3: Lane.LT,   // Y
  4: Lane.HH,   // LB
  5: Lane.CY,   // RB
  6: Lane.HHO,  // LT
  7: Lane.RD,   // RT
  10: Lane.LP,  // LS-click
  11: Lane.LBD, // RS-click
};

/** Button index → menu nav action. Dpad + Start/Back.
 * 8=Back → cancel, 9=Start → confirm, 12=up, 13=down, 14=left, 15=right. */
export const DEFAULT_GAMEPAD_MENU_MAP: Readonly<Record<number, MenuEvent['action']>> = {
  8: 'cancel',
  9: 'confirm',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

export interface GamepadInputOptions {
  buttonMap?: Partial<Record<number, LaneValue>>;
  menuMap?: Partial<Record<number, MenuEvent['action']>>;
  /** True while an XR session is active → skip polling. */
  isGated?: () => boolean;
}

/** Analog triggers (LT/RT) report `value` in 0..1 with `pressed` staying
 * false until full depression on some browsers. Treat them as pressed
 * past this threshold so e-kit hot-foot gamers can light-tap. */
const BUTTON_PRESSED_THRESHOLD = 0.5;

export class GamepadInput {
  private readonly buttonMap: Partial<Record<number, LaneValue>>;
  private readonly menuMap: Partial<Record<number, MenuEvent['action']>>;
  private readonly isGated: () => boolean;
  private readonly laneHandlers = new Set<LaneHitHandler>();
  private readonly menuHandlers = new Set<MenuHandler>();
  /** Per-gamepad-index button-pressed snapshot from the previous frame,
   * for rising-edge detection. */
  private readonly prevPressed = new Map<number, boolean[]>();
  /** True while the gate was active on the previous tick. Drives a
   * one-frame re-arm pass on gate release so a button held across XR
   * enter/exit doesn't fire a phantom hit on the first non-XR frame. */
  private wasGated = false;
  /** One-shot warn latch per gamepad index whose `mapping !== 'standard'`
   * — we deliver events anyway (the default map may still be usable) but
   * the player should know their pad doesn't match the documented layout. */
  private readonly nonStandardWarned = new Set<number>();
  private rafId: number | null = null;

  constructor(options: GamepadInputOptions = {}) {
    this.buttonMap = { ...DEFAULT_GAMEPAD_MAP, ...(options.buttonMap ?? {}) };
    this.menuMap = { ...DEFAULT_GAMEPAD_MENU_MAP, ...(options.menuMap ?? {}) };
    this.isGated = options.isGated ?? (() => false);
  }

  attach(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    const loop = (now: number): void => {
      this._tick(now, this.readGamepads());
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  detach(): void {
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.prevPressed.clear();
  }

  onLaneHit(handler: LaneHitHandler): () => void {
    this.laneHandlers.add(handler);
    return () => this.laneHandlers.delete(handler);
  }

  onMenu(handler: MenuHandler): () => void {
    this.menuHandlers.add(handler);
    return () => this.menuHandlers.delete(handler);
  }

  /** Advance one frame against an explicit snapshot. Exposed so tests can
   * drive the edge detector deterministically without requestAnimationFrame
   * or a real navigator.getGamepads(). */
  _tick(now: number, pads: readonly (Gamepad | null)[]): void {
    if (this.isGated()) {
      this.prevPressed.clear();
      this.wasGated = true;
      return;
    }
    if (this.wasGated) {
      // Re-arm: seed prevPressed from the current snapshot without
      // firing events. Without this, a button held through the gate
      // (XR session exit with a thumb still on A) would look like a
      // rising edge on the first post-gate frame.
      this.wasGated = false;
      for (const pad of pads) {
        if (!pad) continue;
        this.prevPressed.set(pad.index, snapshotButtons(pad));
      }
      return;
    }
    for (const pad of pads) {
      if (!pad) continue;
      if (pad.mapping !== 'standard' && !this.nonStandardWarned.has(pad.index)) {
        this.nonStandardWarned.add(pad.index);
        console.warn(
          `[gamepad] pad ${pad.index} "${pad.id}" has mapping="${pad.mapping}"; ` +
            `default button map assumes Standard layout and may mis-route.`,
        );
      }
      const prev = this.prevPressed.get(pad.index) ?? [];
      const next: boolean[] = [];
      for (let i = 0; i < pad.buttons.length; i++) {
        const btn = pad.buttons[i];
        if (!btn) {
          next[i] = false;
          continue;
        }
        const pressed = btn.pressed || btn.value > BUTTON_PRESSED_THRESHOLD;
        next[i] = pressed;
        const wasPressed = prev[i] ?? false;
        if (!pressed || wasPressed) continue;

        const lane = this.buttonMap[i];
        if (lane !== undefined) {
          const e: LaneHitEvent = { lane, timestampMs: now, key: `gamepad-${i}` };
          for (const h of this.laneHandlers) h(e);
          continue;
        }
        const action = this.menuMap[i];
        if (action !== undefined) {
          const m: MenuEvent = { action, key: `gamepad-${i}`, timestampMs: now };
          for (const h of this.menuHandlers) h(m);
        }
      }
      this.prevPressed.set(pad.index, next);
    }
  }

  private readGamepads(): (Gamepad | null)[] {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    return Array.from(navigator.getGamepads());
  }
}

/** Snapshot a Gamepad's button-pressed booleans in the same shape prevPressed
 * stores. Separate from the main loop so the re-arm path can reuse the
 * threshold + safe-indexing logic. */
function snapshotButtons(pad: Gamepad): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < pad.buttons.length; i++) {
    const btn = pad.buttons[i];
    out[i] = btn ? btn.pressed || btn.value > BUTTON_PRESSED_THRESHOLD : false;
  }
  return out;
}
