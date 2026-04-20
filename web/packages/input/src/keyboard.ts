/**
 * Keyboard → DTX drum lane mapping with `performance.now()` timestamps.
 *
 * Lane identifiers match `@dtxmania/dtx-core`'s Channel numeric codes.
 * Default mapping is a transcription of CConfigIni.cs:4199-4247 to
 * KeyboardEvent.code strings.
 */

export const Lane = {
  LC: 0x1a,  // Left Cymbal
  HH: 0x11,  // HiHat close
  HHO: 0x18, // HiHat open
  LP: 0x1b,  // Left Pedal
  SD: 0x12,  // Snare
  HT: 0x14,  // High Tom
  BD: 0x13,  // Bass Drum
  LT: 0x15,  // Low Tom
  FT: 0x17,  // Floor Tom
  CY: 0x16,  // Cymbal (crash right)
  RD: 0x19,  // Ride
  LBD: 0x1c, // Left Bass Drum (double-pedal right)
} as const;

export type LaneValue = (typeof Lane)[keyof typeof Lane];

export interface LaneHitEvent {
  lane: LaneValue;
  /** performance.now() at the time of key down. */
  timestampMs: number;
  /** KeyboardEvent.code that triggered it, for debug/UX. */
  key: string;
}

export type LaneHitHandler = (e: LaneHitEvent) => void;

export interface MenuEvent {
  action: 'up' | 'down' | 'left' | 'right' | 'confirm' | 'cancel';
  key: string;
  timestampMs: number;
}

export type MenuHandler = (e: MenuEvent) => void;

/** Default mapping. Values are arrays because DTXMania exposes 2 keys per lane. */
export const DEFAULT_KEY_MAP: Readonly<Record<LaneValue, readonly string[]>> = {
  [Lane.HH]:  ['KeyH'],
  [Lane.SD]:  ['KeyS', 'KeyD'],
  [Lane.BD]:  ['Space', 'KeyZ'],
  [Lane.HT]:  ['KeyU', 'KeyO'],
  [Lane.LT]:  ['KeyA', 'KeyP'],
  [Lane.FT]:  ['KeyG', 'BracketLeft'],
  [Lane.CY]:  ['KeyF', 'Semicolon'],
  [Lane.HHO]: ['KeyK'],
  [Lane.RD]:  ['Quote', 'Backslash'],
  [Lane.LC]:  ['KeyJ', 'ShiftLeft'],
  [Lane.LP]:  ['AltLeft'],
  [Lane.LBD]: ['AltRight'],
};

export const DEFAULT_MENU_MAP: Readonly<Record<string, MenuEvent['action']>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  Escape: 'cancel',
};

export interface KeyboardInputOptions {
  /** Override or extend DEFAULT_KEY_MAP. Values are key codes. */
  keyMap?: Partial<Record<LaneValue, readonly string[]>>;
  /** Override or extend DEFAULT_MENU_MAP. */
  menuMap?: Readonly<Record<string, MenuEvent['action']>>;
  /** Target element. Defaults to window. */
  target?: Window | HTMLElement;
}

export class KeyboardInput {
  private readonly keyToLane: Map<string, LaneValue>;
  private readonly keyToMenu: Record<string, MenuEvent['action']>;
  private readonly target: Window | HTMLElement;
  private readonly laneHandlers = new Set<LaneHitHandler>();
  private readonly menuHandlers = new Set<MenuHandler>();
  private attached = false;

  private readonly onKeyDown = (evt: Event): void => {
    const e = evt as KeyboardEvent;
    if (e.repeat) return;

    const lane = this.keyToLane.get(e.code);
    if (lane !== undefined) {
      const hit: LaneHitEvent = { lane, timestampMs: performance.now(), key: e.code };
      for (const h of this.laneHandlers) h(hit);
      e.preventDefault();
      return;
    }

    const action = this.keyToMenu[e.code];
    if (action !== undefined) {
      const m: MenuEvent = { action, key: e.code, timestampMs: performance.now() };
      for (const h of this.menuHandlers) h(m);
      e.preventDefault();
    }
  };

  constructor(options: KeyboardInputOptions = {}) {
    this.target = options.target ?? window;
    const merged: Record<number, readonly string[]> = { ...DEFAULT_KEY_MAP };
    if (options.keyMap) Object.assign(merged, options.keyMap);

    this.keyToLane = new Map();
    for (const [laneStr, keys] of Object.entries(merged)) {
      const lane = Number(laneStr) as LaneValue;
      for (const key of keys) this.keyToLane.set(key, lane);
    }

    this.keyToMenu = { ...DEFAULT_MENU_MAP, ...(options.menuMap ?? {}) };
  }

  attach(): void {
    if (this.attached) return;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.attached = false;
  }

  onLaneHit(handler: LaneHitHandler): () => void {
    this.laneHandlers.add(handler);
    return () => this.laneHandlers.delete(handler);
  }

  onMenu(handler: MenuHandler): () => void {
    this.menuHandlers.add(handler);
    return () => this.menuHandlers.delete(handler);
  }
}
