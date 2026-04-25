import { describe, expect, it } from 'vitest';
import {
  applySeatYOffset,
  clampSeatYOffset,
  DEFAULT_KIT_PRESET_ID,
  getKitPreset,
  KIT_PRESETS,
  SEAT_Y_OFFSET_MAX,
  SEAT_Y_OFFSET_MIN,
  SEAT_Y_OFFSET_SIT,
  SEAT_Y_OFFSET_STAND,
  type PadSpec,
} from './kit-preset.js';
import { Lane } from '@dtxmania/input';

describe('kit-preset — registry', () => {
  it('exposes at least one preset and the GITADORA Galaxy Wave is the default', () => {
    expect(KIT_PRESETS.length).toBeGreaterThan(0);
    expect(DEFAULT_KIT_PRESET_ID).toBe('gitadora-galaxy-wave');
    expect(getKitPreset(DEFAULT_KIT_PRESET_ID).id).toBe(DEFAULT_KIT_PRESET_ID);
  });

  it('every preset covers every DTX lane exactly once — chart playback would break otherwise', () => {
    const expected = [
      Lane.LC, Lane.HH, Lane.LP, Lane.SD, Lane.HT,
      Lane.BD, Lane.LT, Lane.FT, Lane.CY, Lane.RD,
    ];
    for (const preset of KIT_PRESETS) {
      const lanes = preset.pads.map((p) => p.lane).sort();
      expect(lanes).toEqual([...expected].sort());
      expect(new Set(preset.pads.map((p) => p.lane)).size).toBe(preset.pads.length);
    }
  });

  it('preset ids are unique — the picker keys on id', () => {
    const ids = KIT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the first preset when id is unknown / null / empty', () => {
    expect(getKitPreset('').id).toBe(KIT_PRESETS[0]!.id);
    expect(getKitPreset(null).id).toBe(KIT_PRESETS[0]!.id);
    expect(getKitPreset(undefined).id).toBe(KIT_PRESETS[0]!.id);
    expect(getKitPreset('nope-not-a-real-preset').id).toBe(KIT_PRESETS[0]!.id);
  });
});

describe('kit-preset — Galaxy Wave arcade calibration', () => {
  // These pin the arcade-matching invariants. If a future tweak loosens
  // them (bigger pad, flatter tilt) it must come with a deliberate
  // justification in the PR; arcade-muscle-memory transfer is the whole
  // point of this preset.
  const galaxy = getKitPreset('gitadora-galaxy-wave');
  const find = (l: number): PadSpec =>
    galaxy.pads.find((p) => p.lane === l)!;

  it('TP-65-class pads (HH/SD/Toms) are ~22 cm — the arcade rubber pad spec', () => {
    for (const lane of [Lane.HH, Lane.SD, Lane.HT, Lane.LT, Lane.FT]) {
      expect(find(lane).size).toBeCloseTo(0.22, 2);
    }
  });

  it('cymbal pads (LC/CY) are 28 cm and ride is 32 cm — arcade KCK spec', () => {
    expect(find(Lane.LC).size).toBeCloseTo(0.28, 2);
    expect(find(Lane.CY).size).toBeCloseTo(0.28, 2);
    expect(find(Lane.RD).size).toBeCloseTo(0.32, 2);
  });

  it('ride sits at the steep arcade tilt (~65°) — flat ride is what the previous build got wrong', () => {
    expect(find(Lane.RD).tiltDeg).toBeGreaterThanOrEqual(60);
    expect(find(Lane.RD).tiltDeg).toBeLessThanOrEqual(70);
  });

  it('toms tilt at ~45° and snare at ~18° — matches reported arcade ergonomics', () => {
    expect(find(Lane.HT).tiltDeg).toBeCloseTo(45, 0);
    expect(find(Lane.LT).tiltDeg).toBeCloseTo(45, 0);
    expect(find(Lane.SD).tiltDeg).toBeCloseTo(18, 0);
  });

  it('BD remains a horizontal-plane "face" hit — VR has no foot tracking, so kick stays a stick-strike abstraction', () => {
    expect(find(Lane.BD).shape).toBe('face');
    expect(find(Lane.BD).tiltDeg).toBe(0);
  });

  it('LP is a pedal at floor height — its visual is a stick-target abstraction, never tilted', () => {
    expect(find(Lane.LP).shape).toBe('pedal');
    expect(find(Lane.LP).tiltDeg).toBe(0);
    expect(find(Lane.LP).position.y).toBeLessThan(0.30);
  });

  it('whole kit fits inside a 2 m wide play space — Quest 3 default guardian', () => {
    const xs = galaxy.pads.map((p) => p.position.x);
    const widths = galaxy.pads.map((p) => Math.abs(p.position.x) + p.size / 2);
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeLessThan(2.0);
    // No pad's outer edge crosses ±1 m from origin (centred kit).
    expect(Math.max(...widths)).toBeLessThan(1.0);
  });
});

describe('kit-preset — applySeatYOffset', () => {
  const base: readonly PadSpec[] = [
    { lane: Lane.SD, position: { x: 0, y: 0.80, z: -0.4 }, size: 0.22, tiltDeg: 18, shape: 'disc',  stand: false },
    { lane: Lane.BD, position: { x: 0, y: 0.35, z: -0.5 }, size: 0.30, tiltDeg:  0, shape: 'face',  stand: false },
  ];

  it('shifts every pad by the same Y offset', () => {
    const out = applySeatYOffset(base, 0.5);
    expect(out[0]!.position.y).toBeCloseTo(1.30, 6);
    expect(out[1]!.position.y).toBeCloseTo(0.85, 6);
  });

  it('preserves x and z exactly so kit-relative geometry (muscle memory anchor) never drifts', () => {
    const out = applySeatYOffset(base, 0.5);
    for (let i = 0; i < base.length; i++) {
      expect(out[i]!.position.x).toBe(base[i]!.position.x);
      expect(out[i]!.position.z).toBe(base[i]!.position.z);
      expect(out[i]!.size).toBe(base[i]!.size);
      expect(out[i]!.tiltDeg).toBe(base[i]!.tiltDeg);
      expect(out[i]!.shape).toBe(base[i]!.shape);
    }
  });

  it('returns the input array reference unchanged when offset is exactly 0 (avoids needless allocation)', () => {
    expect(applySeatYOffset(base, 0)).toBe(base);
  });

  it('does not mutate the input array', () => {
    const snapshot = JSON.stringify(base);
    applySeatYOffset(base, 0.5);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('handles negative offsets (short / child player sinks the kit slightly)', () => {
    const out = applySeatYOffset(base, -0.1);
    expect(out[0]!.position.y).toBeCloseTo(0.70, 6);
  });
});

describe('kit-preset — clampSeatYOffset', () => {
  it('passes values inside the supported range through unchanged', () => {
    expect(clampSeatYOffset(0)).toBe(0);
    expect(clampSeatYOffset(0.25)).toBe(0.25);
    expect(clampSeatYOffset(SEAT_Y_OFFSET_MIN)).toBe(SEAT_Y_OFFSET_MIN);
    expect(clampSeatYOffset(SEAT_Y_OFFSET_MAX)).toBe(SEAT_Y_OFFSET_MAX);
  });

  it('clamps below-min and above-max to the bounds — slider drag and keyboard fuzzing both stay in range', () => {
    expect(clampSeatYOffset(SEAT_Y_OFFSET_MIN - 0.5)).toBe(SEAT_Y_OFFSET_MIN);
    expect(clampSeatYOffset(SEAT_Y_OFFSET_MAX + 0.5)).toBe(SEAT_Y_OFFSET_MAX);
    expect(clampSeatYOffset(99)).toBe(SEAT_Y_OFFSET_MAX);
    expect(clampSeatYOffset(-99)).toBe(SEAT_Y_OFFSET_MIN);
  });

  it('quick-preset constants sit inside the supported range', () => {
    expect(SEAT_Y_OFFSET_SIT).toBeGreaterThanOrEqual(SEAT_Y_OFFSET_MIN);
    expect(SEAT_Y_OFFSET_SIT).toBeLessThanOrEqual(SEAT_Y_OFFSET_MAX);
    expect(SEAT_Y_OFFSET_STAND).toBeGreaterThanOrEqual(SEAT_Y_OFFSET_MIN);
    expect(SEAT_Y_OFFSET_STAND).toBeLessThanOrEqual(SEAT_Y_OFFSET_MAX);
    expect(SEAT_Y_OFFSET_STAND).toBeGreaterThan(SEAT_Y_OFFSET_SIT);
  });
});
