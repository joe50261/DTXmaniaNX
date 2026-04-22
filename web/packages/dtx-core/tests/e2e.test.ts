import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDtx } from '../src/parser/parser.js';
import { computeTiming } from '../src/timing/timing.js';
import { Channel, isDrumLane } from '../src/model/channel.js';
import { Judgment } from '../src/scoring/judgment.js';
import { ScoreTracker, computeAchievementRate, computeRank } from '../src/scoring/score.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('end-to-end: simple-rock.dtx', () => {
  const text = readFileSync(join(here, 'fixtures', 'simple-rock.dtx'), 'utf-8');
  const song = computeTiming(parseDtx(text));

  it('parses metadata', () => {
    expect(song.title).toBe('Simple Rock');
    expect(song.artist).toBe('Test');
    expect(song.baseBpm).toBe(120);
    expect(song.drumLevel).toBe(300);
  });

  it('defines four WAV entries', () => {
    expect(song.wavTable.size).toBe(4);
    expect(song.wavTable.get(1)?.path).toBe('kick.wav');
    expect(song.wavTable.get(4)?.path).toBe('crash.wav');
  });

  it('computes plausible durations with mid-song BPM change', () => {
    // Measures 0-1 at 120 BPM: 4000ms
    // Measure 2 at 240 BPM: 1000ms
    // Measure 3 at 120 BPM (after ch.03 reset): 2000ms
    // Expected total ~ 7000ms.
    expect(song.durationMs).toBeGreaterThan(6900);
    expect(song.durationMs).toBeLessThan(7100);
  });

  it('places the crash on beat 1 of measure 3 exactly at 5000ms', () => {
    // Measure 0+1 = 4000ms @ 120BPM
    // Measure 2 = 1000ms @ 240BPM
    // Measure 3 tick 0 = 5000ms
    const crash = song.chips.find((c) => c.channel === Channel.Cymbal);
    expect(crash).toBeDefined();
    expect(crash!.playbackTimeMs).toBeCloseTo(5000, 1);
  });

  it('counts drum chips correctly across all four measures', () => {
    const drumChips = song.chips.filter(
      (c) => c.channel >= Channel.HiHatClose && c.channel <= Channel.LeftBassDrum
    );
    // m0: 4 BD + 2 SD + 8 HH = 14
    // m1: 8 BD = 8
    // m2: 4 BD = 4
    // m3: 1 CY = 1
    expect(drumChips.length).toBe(14 + 8 + 4 + 1);
  });

  it('perfect-all run scores exactly 1,000,000', () => {
    const notes = song.chips.filter(
      (c) => c.channel >= Channel.HiHatClose && c.channel <= Channel.LeftBassDrum
    );
    const tracker = new ScoreTracker(notes.length);
    for (let i = 0; i < notes.length; i++) tracker.record(Judgment.PERFECT);
    expect(tracker.snapshot().score).toBe(1_000_000);
  });

  it('all-miss run scores 0', () => {
    const notes = song.chips.filter(
      (c) => c.channel >= Channel.HiHatClose && c.channel <= Channel.LeftBassDrum
    );
    const tracker = new ScoreTracker(notes.length);
    for (let i = 0; i < notes.length; i++) tracker.record(Judgment.MISS);
    expect(tracker.snapshot().score).toBe(0);
    expect(tracker.snapshot().maxCombo).toBe(0);
  });

  it('all-auto playthrough: every drum chip counted as auto; rank collapses to E', () => {
    // Simulates the in-game auto-play path with every lane enabled —
    // matches what Game.autoFireLanes would do with autoPlayLanes set
    // to the full drum-channel set. Exercises the full parse → timing
    // → ScoreTracker.recordAuto → rank pipeline without touching any
    // of the renderer / audio / DOM layer.
    const playables = song.chips.filter((c) => isDrumLane(c.channel));
    expect(playables.length).toBeGreaterThan(0);
    const tracker = new ScoreTracker(playables.length);
    for (let i = 0; i < playables.length; i++) tracker.recordAuto();
    const snap = tracker.snapshot();
    expect(snap.totalNotes).toBe(playables.length);
    expect(snap.autoCount).toBe(playables.length);
    // effective denominator = totalNotes - autoCount = 0, so both score
    // and achievement rate collapse to 0 — matches the DTXmania
    // convention where a fully-autoplayed run earns nothing.
    expect(snap.score).toBe(0);
    expect(snap.counts[Judgment.PERFECT]).toBe(0);
    expect(snap.counts[Judgment.MISS]).toBe(0);
    expect(snap.maxCombo).toBe(0);
    const rate = computeAchievementRate(snap);
    expect(rate).toBe(0);
    expect(computeRank(rate, snap.totalNotes)).toBe('E');
  });
});
