import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_CONFIG,
  isPracticeRun,
  loadConfig,
  toggleAutoPlayLane,
} from './config.js';

/**
 * happy-dom gives us a real-ish localStorage out of the box; clear it
 * between cases so stored blobs from one test don't bleed into the
 * next.
 */
beforeEach(() => {
  localStorage.clear();
});

describe('loadConfig — defaults', () => {
  it('returns DEFAULT_CONFIG when storage is empty', () => {
    const cfg = loadConfig();
    expect(cfg.scrollSpeed).toBe(DEFAULT_CONFIG.scrollSpeed);
    expect(cfg.judgeLineY).toBe(DEFAULT_CONFIG.judgeLineY);
    expect(cfg.reverseScroll).toBe(DEFAULT_CONFIG.reverseScroll);
    expect(cfg.showFastSlow).toBe(DEFAULT_CONFIG.showFastSlow);
    expect(cfg.volumeBgm).toBe(DEFAULT_CONFIG.volumeBgm);
    for (const v of Object.values(cfg.autoPlay)) expect(v).toBe(false);
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem('dtxmania.config', '{not valid json');
    const cfg = loadConfig();
    expect(cfg.scrollSpeed).toBe(DEFAULT_CONFIG.scrollSpeed);
    expect(cfg.autoPlay.BD).toBe(false);
  });
});

describe('loadConfig — migrations', () => {
  it('legacy dtxmania.autokick="1" projects onto autoPlay.BD + LBD', () => {
    localStorage.setItem('dtxmania.autokick', '1');
    const cfg = loadConfig();
    expect(cfg.autoPlay.BD).toBe(true);
    expect(cfg.autoPlay.LBD).toBe(true);
    // Other lanes stay off — legacy shortcut only ever meant "BD + LBD".
    expect(cfg.autoPlay.HH).toBe(false);
    expect(cfg.autoPlay.SD).toBe(false);
  });

  it('legacy dtxmania.autokick="0" is treated as absent (no BD/LBD)', () => {
    localStorage.setItem('dtxmania.autokick', '0');
    const cfg = loadConfig();
    expect(cfg.autoPlay.BD).toBe(false);
    expect(cfg.autoPlay.LBD).toBe(false);
  });

  it('legacy key is wiped after load so a second run sees a clean slate', () => {
    localStorage.setItem('dtxmania.autokick', '1');
    loadConfig();
    expect(localStorage.getItem('dtxmania.autokick')).toBeNull();
  });

  it('old blob { autoKick: true } with no autoPlay map migrates to BD + LBD', () => {
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({ autoKick: true, scrollSpeed: 0.6 }),
    );
    const cfg = loadConfig();
    expect(cfg.autoPlay.BD).toBe(true);
    expect(cfg.autoPlay.LBD).toBe(true);
    // Non-autoKick fields from the stored blob survive the merge.
    expect(cfg.scrollSpeed).toBe(0.6);
  });

  it('stored autoPlay map takes precedence; legacy key ignored', () => {
    // Write both: a richer autoPlay map AND the legacy singleton. The
    // richer shape wins.
    localStorage.setItem('dtxmania.autokick', '1');
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({
        autoPlay: {
          LC: false,
          HH: true,
          LP: false,
          SD: false,
          HT: false,
          BD: false,
          LT: false,
          FT: false,
          CY: false,
          RD: false,
          LBD: false,
        },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.autoPlay.HH).toBe(true); // from stored
    expect(cfg.autoPlay.BD).toBe(false); // legacy key didn't override
    expect(cfg.autoPlay.LBD).toBe(false);
  });

  it('stored partial config merges over defaults without losing AutoPlayMap keys', () => {
    // Only set a couple of fields, confirm the rest come from defaults.
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({ volumeBgm: 0.5, showFastSlow: true }),
    );
    const cfg = loadConfig();
    expect(cfg.volumeBgm).toBe(0.5);
    expect(cfg.showFastSlow).toBe(true);
    expect(cfg.scrollSpeed).toBe(DEFAULT_CONFIG.scrollSpeed);
    // AutoPlayMap fully hydrated from defaults since stored blob has
    // no autoPlay field.
    expect(cfg.autoPlay.BD).toBe(false);
    expect(cfg.autoPlay.HH).toBe(false);
  });

  it('new Input/Practice defaults ship on clean storage', () => {
    const cfg = loadConfig();
    expect(cfg.gamepadEnabled).toBe(true);
    expect(cfg.midiEnabled).toBe(true);
    expect(cfg.midiInputId).toBeNull();
    expect(cfg.practiceRate).toBe(1.0);
    expect(cfg.preservePitch).toBe(true);
    expect(cfg.practiceLoopEnabled).toBe(false);
  });

  it('vrLogEnabled defaults off; existing storage without the key migrates to false', () => {
    // Fresh storage → off.
    expect(loadConfig().vrLogEnabled).toBe(false);
    // Old stored config without the key (pre-R6) → shouldn't crash or
    // flip anything else; the field picks up its default.
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({ volumeBgm: 0.75, scrollSpeed: 0.5 }),
    );
    const cfg = loadConfig();
    expect(cfg.vrLogEnabled).toBe(false);
    expect(cfg.volumeBgm).toBe(0.75); // surrounding fields survive merge
    expect(cfg.scrollSpeed).toBe(0.5);
  });

  it('kit-preset defaults: GITADORA Galaxy Wave + zero seat offset on clean storage', () => {
    const cfg = loadConfig();
    expect(cfg.kitPresetId).toBe('gitadora-galaxy-wave');
    expect(cfg.seatYOffset).toBe(0);
  });

  it('pre-arcade-preset blobs (no kitPresetId / seatYOffset) get the new defaults without losing surrounding fields', () => {
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({ volumeBgm: 0.6, scrollSpeed: 0.55 }),
    );
    const cfg = loadConfig();
    expect(cfg.kitPresetId).toBe('gitadora-galaxy-wave');
    expect(cfg.seatYOffset).toBe(0);
    expect(cfg.volumeBgm).toBe(0.6);
    expect(cfg.scrollSpeed).toBe(0.55);
  });

  it('a stored kitPresetId / seatYOffset survives the merge', () => {
    localStorage.setItem(
      'dtxmania.config',
      JSON.stringify({ kitPresetId: 'compact', seatYOffset: 0.4 }),
    );
    const cfg = loadConfig();
    expect(cfg.kitPresetId).toBe('compact');
    expect(cfg.seatYOffset).toBe(0.4);
  });
});

describe('isPracticeRun — best-score gate', () => {
  it('returns false for a plain 1× no-loop config', () => {
    expect(isPracticeRun(DEFAULT_CONFIG)).toBe(false);
  });

  it('returns true when practiceRate !== 1', () => {
    expect(isPracticeRun({ ...DEFAULT_CONFIG, practiceRate: 0.75 })).toBe(true);
    expect(isPracticeRun({ ...DEFAULT_CONFIG, practiceRate: 1.25 })).toBe(true);
  });

  it('returns true when loop is enabled, even at 1× speed', () => {
    expect(
      isPracticeRun({ ...DEFAULT_CONFIG, practiceLoopEnabled: true }),
    ).toBe(true);
  });

  it('returns true when a loop fired during the run (didLoop arg)', () => {
    // Loop toggled off by end-of-song but looped at least once → still
    // practice. Mirrors C# "any PlaySpeed / warp" gate semantics.
    expect(isPracticeRun(DEFAULT_CONFIG, true)).toBe(true);
  });
});

describe('toggleAutoPlayLane — per-lane flip helper', () => {
  // VR auto-play grid + DOM config panel both drive their cell onclick
  // through this helper, so a regression here breaks both UIs at once.

  it('flips false → true for a single lane, leaves others untouched', () => {
    const before = { ...DEFAULT_CONFIG.autoPlay };
    const after = toggleAutoPlayLane(before, 'BD');
    expect(after.BD).toBe(true);
    expect(after.LBD).toBe(false);
    expect(after.HH).toBe(false);
  });

  it('flips true → false symmetrically', () => {
    const before = { ...DEFAULT_CONFIG.autoPlay, HH: true };
    const after = toggleAutoPlayLane(before, 'HH');
    expect(after.HH).toBe(false);
    expect(after.BD).toBe(false);
  });

  it('returns a fresh object — never mutates the input map', () => {
    // updateConfig replaces the whole blob, so in-place mutation would
    // quietly break the subscribe() change-detection in config.ts that
    // relies on reference equality to skip redundant broadcasts.
    const before = { ...DEFAULT_CONFIG.autoPlay };
    const after = toggleAutoPlayLane(before, 'CY');
    expect(after).not.toBe(before);
    expect(before.CY).toBe(false); // input untouched
  });
});
