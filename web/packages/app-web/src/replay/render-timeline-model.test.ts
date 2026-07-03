import { describe, it, expect } from 'vitest';
import type { HitEvent, PoseSample } from './recorder-model.js';
import {
  isAutoFiredHit,
  hitPlaybackVolumeMult,
  clampToPoseRange,
  stampFinishedAtSongMs,
} from './render-timeline-model.js';

const hit = (over: Partial<HitEvent>): HitEvent => ({
  songTimeMs: 0,
  lane: 0x11 as HitEvent['lane'],
  source: 'xr-right',
  chipIndex: 0,
  lagMs: 5,
  judgment: 'PERFECT',
  ...over,
});

const pose = (songTimeMs: number): PoseSample => ({
  songTimeMs,
  head: null,
  left: null,
  right: null,
});

describe('isAutoFiredHit', () => {
  it('true only for source=auto AND lagMs=null', () => {
    expect(isAutoFiredHit({ source: 'auto', lagMs: null })).toBe(true);
  });

  it('false for a human strike defensively tagged auto (numeric lag)', () => {
    expect(isAutoFiredHit({ source: 'auto', lagMs: 12 })).toBe(false);
  });

  it('false for manual hands even with null lag (strays)', () => {
    expect(isAutoFiredHit({ source: 'xr-left', lagMs: null })).toBe(false);
    expect(isAutoFiredHit({ source: 'xr-right', lagMs: 3 })).toBe(false);
  });
});

describe('hitPlaybackVolumeMult', () => {
  it('auto-fired chips play at full volume (1.0) like the live game', () => {
    expect(hitPlaybackVolumeMult({ source: 'auto', lagMs: null })).toBe(1);
  });

  it('manual strikes attenuate to 0.7', () => {
    expect(hitPlaybackVolumeMult({ source: 'xr-left', lagMs: 0 })).toBe(0.7);
    expect(hitPlaybackVolumeMult({ source: 'xr-right', lagMs: -8 })).toBe(0.7);
  });

  it('a human hit on an auto-play lane (numeric lag) is still a manual 0.7', () => {
    expect(hitPlaybackVolumeMult({ source: 'auto', lagMs: 9 })).toBe(0.7);
  });

  it('works against a full HitEvent shape', () => {
    expect(hitPlaybackVolumeMult(hit({ source: 'auto', lagMs: null }))).toBe(1);
    expect(hitPlaybackVolumeMult(hit({ source: 'xr-left', lagMs: 4 }))).toBe(0.7);
  });
});

describe('clampToPoseRange', () => {
  it('returns the input unchanged for an empty pose stream', () => {
    expect(clampToPoseRange(1234, [])).toBe(1234);
  });

  it('passes through times within the recorded range', () => {
    const poses = [pose(0), pose(500), pose(1000)];
    expect(clampToPoseRange(0, poses)).toBe(0);
    expect(clampToPoseRange(500, poses)).toBe(500);
    expect(clampToPoseRange(1000, poses)).toBe(1000);
  });

  it('clamps a time past the last sample to the last sample time (avatar holds, not vanishes)', () => {
    const poses = [pose(0), pose(500), pose(1000)];
    // durationMs+6000 tail query lands far past the last (durationMs+500) pose.
    expect(clampToPoseRange(6500, poses)).toBe(1000);
  });

  it('leaves pre-first-sample times alone (avatar absent before play)', () => {
    const poses = [pose(200), pose(400)];
    expect(clampToPoseRange(-50, poses)).toBe(-50);
    expect(clampToPoseRange(100, poses)).toBe(100);
  });
});

describe('stampFinishedAtSongMs', () => {
  it('is null while still playing', () => {
    expect(stampFinishedAtSongMs(null, 1000, false)).toBe(null);
  });

  it('captures the song time on the first finished frame', () => {
    expect(stampFinishedAtSongMs(null, 180_000, true)).toBe(180_000);
  });

  it('holds the FIRST stamp across every later finished frame (does not re-stamp)', () => {
    let prev: number | null = null;
    prev = stampFinishedAtSongMs(prev, 180_000, true); // first finished frame
    prev = stampFinishedAtSongMs(prev, 181_000, true);
    prev = stampFinishedAtSongMs(prev, 186_000, true); // end of 6s tail
    expect(prev).toBe(180_000);
  });

  it('feeding a stable stamp makes the fade age grow with song time', () => {
    const finishedAt = stampFinishedAtSongMs(null, 180_000, true)!;
    // renderer computes age = animClock(songTime) - finishedAt
    expect(180_000 - finishedAt).toBe(0); // first finished frame: age 0
    expect(180_400 - finishedAt).toBe(400); // 400ms later: fully faded in
    expect(186_000 - finishedAt).toBe(6000); // still readable through the tail
  });
});
