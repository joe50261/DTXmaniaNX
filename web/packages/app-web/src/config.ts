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
  /** Auto-fire BD + LBD chips. Future: per-lane split. */
  autoKick: boolean;
}

export const DEFAULT_CONFIG: Config = Object.freeze({
  scrollSpeed: 0.45,
  judgeLineY: 600,
  reverseScroll: false,
  autoKick: false,
});

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

function loadConfig(): Config {
  let stored: Partial<Config> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Config>;
  } catch {
    /* corrupt JSON — fall through to defaults */
  }
  const merged: Config = { ...DEFAULT_CONFIG, ...stored };
  // One-time migration from the standalone autokick flag (commit
  // 538681a). Once we've folded it into the new blob the legacy key
  // is wiped so older code paths can't fight us.
  if (!('autoKick' in stored)) {
    try {
      const legacy = localStorage.getItem(LEGACY_AUTOKICK_KEY);
      if (legacy === '1') merged.autoKick = true;
    } catch {
      /* ignore */
    }
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
