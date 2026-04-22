import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from './config.js';

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
});
