/**
 * Persisted user settings shared between the gameplay renderer, the
 * audio engine, and the desktop overlay UI. Single localStorage blob
 * keyed by `dtxmania.config`. Subscribers (renderer, the auto-kick
 * button label) get notified on every updateConfig call so live
 * tweaks (slider drags) propagate without a chart restart.
 *
 * Adding a setting:
 *   1. Extend the Config interface
 *   2. Set its default in DEFAULT_CONFIG
 *   3. Render an input in config-panel.ts
 *   4. Optionally subscribe(...) somewhere to apply it live
 */

/** Per-lane auto-play toggles. Each key is a lane identifier matching
 * the Lane enum names from @dtxmania/input; `true` means Game auto-
 * fires chips on that lane. Mirrors DTXmania's bAutoPlay struct
 * (CConstants.cs:580-595). */
export interface AutoPlayMap {
  LC: boolean;
  HH: boolean;
  LP: boolean;
  SD: boolean;
  HT: boolean;
  BD: boolean;
  LT: boolean;
  FT: boolean;
  CY: boolean;
  RD: boolean;
  LBD: boolean;
}

export const AUTO_PLAY_LANES: readonly (keyof AutoPlayMap)[] = [
  'LC',
  'HH',
  'LP',
  'SD',
  'HT',
  'BD',
  'LT',
  'FT',
  'CY',
  'RD',
  'LBD',
];

export interface Config {
  /** px / ms scroll speed for chip fall. DTXmania "speed=1" works out
   * to ~0.625 px/ms; user-tuneable 0.30..1.50 here. */
  scrollSpeed: number;
  /** Y position of the judgment line on the 1280×720 HUD canvas.
   * 450..620; pad meshes follow. */
  judgeLineY: number;
  /** false = chips fall top→bottom (DTX default).
   * true  = chips rise bottom→top; player should also slide judgeLineY
   *         up to ~150 to make sense of it. */
  reverseScroll: boolean;
  /** Per-lane auto-fire flags (replaces the old autoKick boolean).
   * Migrated on first load: an old `autoKick: true` turns into
   * `autoPlay.BD = autoPlay.LBD = true`. */
  autoPlay: AutoPlayMap;
  /** If true, judgment flashes show a tiny "FAST" / "SLOW" label
   * above the PERFECT/GREAT/... text so the player can see whether
   * they were rushing or dragging. Off by default — distracting
   * for anyone not actively drilling timing. */
  showFastSlow: boolean;
  /** Symmetric dead-band around the target in ms; hits inside
   * ±fastSlowDeadMs are shown as on-time (no label). Matches
   * DTXmania's Ghost / Ghost 縦 feature distance of ~8 ms. */
  fastSlowDeadMs: number;
  /** Master volumes per audio category, 0..1. BGM and drums default to
   * 1; preview defaults to 0.7 so song-select clips don't blast over
   * an active chart. */
  volumeBgm: number;
  volumeDrums: number;
  volumePreview: number;
  /** Poll standard gamepads (non-XR) and route button presses as lane hits.
   * Defaults on so plugging a pad just works. XR sessions disable polling
   * internally so this flag doesn't need to flip per-session. */
  gamepadEnabled: boolean;
  /** Request Web MIDI access on first user gesture and route noteon
   * messages as lane hits. Defaults on; denied/unsupported browsers
   * degrade silently (keyboard + gamepad still work). */
  midiEnabled: boolean;
  /** Limit MIDI routing to a single input port ID. null → every input
   * port routes hits (common case: one e-kit or one DAW). */
  midiInputId: string | null;
  /** Playback-rate multiplier for practice mode. 1.0 = normal; 0.5 =
   * half-speed; capped [0.25, 2.0]. Non-1 values suppress best-score
   * writes (see isPractice). */
  practiceRate: number;
  /** If true, `AudioBufferSourceNode.preservesPitch` is set on BGM +
   * drum samples so slow-downs don't pitch down. Browsers that don't
   * support the flag ignore it silently. */
  preservePitch: boolean;
  /** Loop the window [loopStart, loopEnd] in practice mode. When true
   * and the chart reaches loopEnd, seek back to loopStart. Also
   * suppresses best-score writes. */
  practiceLoopEnabled: boolean;
  /** 0-based measure index for loop start; clamped to [0, lastMeasure]. */
  practiceLoopStartMeasure: number;
  /** 0-based measure index for loop end; null = end of song. */
  practiceLoopEndMeasure: number | null;
}

const EMPTY_AUTO_PLAY: AutoPlayMap = Object.freeze({
  LC: false,
  HH: false,
  LP: false,
  SD: false,
  HT: false,
  BD: false,
  LT: false,
  FT: false,
  CY: false,
  RD: false,
  LBD: false,
});

export const DEFAULT_CONFIG: Config = Object.freeze({
  scrollSpeed: 0.45,
  judgeLineY: 600,
  reverseScroll: false,
  autoPlay: { ...EMPTY_AUTO_PLAY },
  showFastSlow: false,
  fastSlowDeadMs: 8,
  volumeBgm: 1.0,
  volumeDrums: 1.0,
  volumePreview: 0.7,
  gamepadEnabled: true,
  midiEnabled: true,
  midiInputId: null,
  practiceRate: 1.0,
  preservePitch: true,
  practiceLoopEnabled: false,
  practiceLoopStartMeasure: 0,
  practiceLoopEndMeasure: null,
});

/** True when the current run should NOT commit a best-score record.
 * Mirrors DTXmania's `Check PlaySpeed` guard (C# commit d4faf41). */
export function isPracticeRun(cfg: Config, didLoop = false): boolean {
  if (cfg.practiceRate !== 1.0) return true;
  if (cfg.practiceLoopEnabled) return true;
  return didLoop;
}

const STORAGE_KEY = 'dtxmania.config';
const LEGACY_AUTOKICK_KEY = 'dtxmania.autokick';

let current: Config = loadConfig();
const listeners = new Set<(cfg: Config) => void>();

export function getConfig(): Config {
  return current;
}

/**
 * Merge a partial update, persist, and notify subscribers. Pass only
 * the fields that changed; unspecified fields keep their current value.
 */
export function updateConfig(partial: Partial<Config>): void {
  const next: Config = { ...current, ...partial };
  // Cheap equality check so an unchanged drag (range input firing
  // input events with no actual change) doesn't churn listeners.
  let changed = false;
  for (const k of Object.keys(next) as (keyof Config)[]) {
    if (next[k] !== current[k]) {
      changed = true;
      break;
    }
  }
  current = next;
  saveConfig(next);
  if (changed) for (const cb of listeners) cb(current);
}

/** Replace the config wholesale. Used only on first load. */
export function applyConfig(cfg: Config): void {
  current = { ...cfg };
}

/**
 * Subscribe to config changes. Returns an unsubscribe function. The
 * callback fires only on actual changes, not on every updateConfig
 * call (see equality check above).
 */
export function subscribe(cb: (cfg: Config) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Read the persisted config blob off localStorage, applying any
 * legacy-key migrations. Exported so tests can verify migration
 * behaviour in isolation — production calls this exactly once at
 * module import time to seed `current`.
 */
export function loadConfig(): Config {
  // `stored` uses a loose shape because the on-disk blob may predate
  // the current schema (e.g. still carries the old boolean `autoKick`).
  let stored: Partial<Config> & { autoKick?: boolean } = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as typeof stored;
  } catch {
    /* corrupt JSON — fall through to defaults */
  }
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...stored,
    // Avoid object-spread losing AutoPlayMap keys when stored has a
    // partial object or none at all.
    autoPlay: { ...DEFAULT_CONFIG.autoPlay, ...(stored.autoPlay ?? {}) },
  };
  // Migration 1: legacy `dtxmania.autokick` standalone key (commit
  // 538681a). Only honoured when no richer config is stored yet.
  if (!('autoKick' in stored) && !('autoPlay' in stored)) {
    try {
      if (localStorage.getItem(LEGACY_AUTOKICK_KEY) === '1') {
        merged.autoPlay.BD = true;
        merged.autoPlay.LBD = true;
      }
    } catch {
      /* ignore */
    }
  }
  // Migration 2: old stored config with the boolean `autoKick` flag
  // (commits 9af1751 .. a9350f7). Fold into the new per-lane map.
  if (stored.autoKick === true && !('autoPlay' in stored)) {
    merged.autoPlay.BD = true;
    merged.autoPlay.LBD = true;
  }
  try {
    localStorage.removeItem(LEGACY_AUTOKICK_KEY);
  } catch {
    /* ignore */
  }
  return merged;
}

function saveConfig(cfg: Config): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch (e) {
    // localStorage can throw under quota / private mode — log + move on.
    // Lost settings are recoverable; an exception here would be worse.
    console.warn('[config] save failed', e);
  }
}
