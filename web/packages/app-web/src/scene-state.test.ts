import { describe, expect, it } from 'vitest';
import {
  isGameplayScene,
  nextScene,
  SCENES,
  wantsDesktopOverlay,
  type Scene,
} from './scene-state.js';

describe('nextScene — happy-path flow', () => {
  it('walks the canonical boot → result loop', () => {
    let s: Scene = 'startup';
    s = nextScene(s, { kind: 'boot-complete' });    expect(s).toBe('title');
    s = nextScene(s, { kind: 'menu-play' });        expect(s).toBe('select');
    s = nextScene(s, { kind: 'song-picked' });      expect(s).toBe('loading');
    s = nextScene(s, { kind: 'song-loaded' });      expect(s).toBe('play');
    s = nextScene(s, { kind: 'play-finished' });    expect(s).toBe('result');
    s = nextScene(s, { kind: 'result-dismissed' }); expect(s).toBe('select');
  });

  it('handles cancellation paths', () => {
    expect(nextScene('play', { kind: 'play-cancelled' })).toBe('select');
    expect(nextScene('loading', { kind: 'song-load-failed' })).toBe('select');
    expect(nextScene('select', { kind: 'select-back' })).toBe('title');
  });

  it('routes title → config and back', () => {
    expect(nextScene('title', { kind: 'menu-config' })).toBe('config');
    expect(nextScene('config', { kind: 'config-back' })).toBe('title');
  });

  it('routes title → end', () => {
    expect(nextScene('title', { kind: 'menu-exit' })).toBe('end');
  });
});

describe('nextScene — invalid events are no-ops', () => {
  it('ignores non-applicable events per scene', () => {
    expect(nextScene('startup', { kind: 'menu-play' })).toBe('startup');
    expect(nextScene('title', { kind: 'song-picked' })).toBe('title');
    expect(nextScene('select', { kind: 'play-finished' })).toBe('select');
    expect(nextScene('play', { kind: 'menu-config' })).toBe('play');
    expect(nextScene('result', { kind: 'menu-play' })).toBe('result');
    expect(nextScene('end', { kind: 'menu-play' })).toBe('end');
  });
});

describe('nextScene — reset', () => {
  it('returns startup from any scene', () => {
    for (const s of SCENES) {
      expect(nextScene(s, { kind: 'reset' })).toBe('startup');
    }
  });
});

describe('isGameplayScene', () => {
  it('only returns true for play', () => {
    for (const s of SCENES) {
      expect(isGameplayScene(s)).toBe(s === 'play');
    }
  });
});

describe('wantsDesktopOverlay', () => {
  it('only returns true for select (overlay houses the song-picker)', () => {
    for (const s of SCENES) {
      expect(wantsDesktopOverlay(s)).toBe(s === 'select');
    }
  });
});
