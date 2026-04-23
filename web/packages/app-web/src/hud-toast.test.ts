import { afterEach, describe, expect, it } from 'vitest';
import { activeToast, clearToast, showToast } from './hud-toast.js';

/**
 * The module is a singleton so tests share the slot; clear between
 * cases so ordering doesn't matter.
 */
afterEach(() => clearToast());

describe('hud-toast — module-level singleton', () => {
  it('returns null when nothing has been posted', () => {
    expect(activeToast(1000)).toBeNull();
  });

  it('showToast stores text + expiry; activeToast reads it back before expiry', () => {
    showToast('hello', 500, 0);
    expect(activeToast(0)).toEqual({ text: 'hello', expiresAtMs: 500 });
    expect(activeToast(499)).toEqual({ text: 'hello', expiresAtMs: 500 });
  });

  it('auto-clears on read once the clock has passed the expiry', () => {
    showToast('gone', 500, 0);
    expect(activeToast(500)).toBeNull(); // boundary: >= expiry clears
    // After clearing, a subsequent read stays null even if time rewinds.
    expect(activeToast(100)).toBeNull();
  });

  it('posting a second toast replaces the first (latest hotkey wins)', () => {
    showToast('first', 1000, 0);
    showToast('second', 1000, 100);
    const t = activeToast(200);
    expect(t?.text).toBe('second');
    expect(t?.expiresAtMs).toBe(1100);
  });

  it('clearToast drops the current toast immediately', () => {
    showToast('x', 1000, 0);
    clearToast();
    expect(activeToast(0)).toBeNull();
  });

  it('default duration is ~1.8s (1800 ms) when none is specified', () => {
    showToast('default', undefined, 0);
    const t = activeToast(0);
    expect(t?.expiresAtMs).toBe(1800);
  });
});
