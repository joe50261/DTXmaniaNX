import { describe, expect, it } from 'vitest';
import { Lane } from '@dtxmania/input';
import {
  BD_HIT_HALF_M,
  detectPadHit,
  HIT_VELOCITY_THRESHOLD_MPS,
  padNormal,
  padTangentV,
} from './hit-detect.js';
import type { PadSpec } from './kit-preset.js';

const flatPad: PadSpec = {
  lane: Lane.SD,
  position: { x: 0, y: 0.8, z: -0.4 },
  size: 0.22,
  tiltDeg: 0,
  shape: 'disc',
  stand: false,
};

const ridePad: PadSpec = {
  lane: Lane.RD,
  position: { x: 0.75, y: 1.15, z: -0.55 },
  size: 0.32,
  tiltDeg: 65,
  shape: 'disc',
  stand: true,
};

const bassPad: PadSpec = {
  lane: Lane.BD,
  position: { x: 0.15, y: 0.35, z: -0.5 },
  size: 0.30,
  tiltDeg: 0,
  shape: 'face',
  stand: false,
};

describe('hit-detect — padNormal / padTangentV geometry contract', () => {
  it('flat pad normal is straight up and tangent points away from player', () => {
    const N = padNormal(0);
    expect(N.x).toBeCloseTo(0, 6);
    expect(N.y).toBeCloseTo(1, 6);
    expect(N.z).toBeCloseTo(0, 6);
    const V = padTangentV(0);
    expect(V.x).toBeCloseTo(0, 6);
    expect(V.y).toBeCloseTo(0, 6);
    expect(V.z).toBeCloseTo(-1, 6);
  });

  it('65° tilted pad normal leans toward the player (+Z), still mostly up', () => {
    const N = padNormal(65);
    expect(N.x).toBeCloseTo(0, 6);
    expect(N.y).toBeCloseTo(Math.cos((65 * Math.PI) / 180), 6);
    expect(N.z).toBeCloseTo(Math.sin((65 * Math.PI) / 180), 6);
    expect(N.z).toBeGreaterThan(0);
    expect(N.y).toBeGreaterThan(0);
  });

  it('vertical pad (90°) normal is horizontal +Z — face-on to the player', () => {
    const N = padNormal(90);
    expect(N.x).toBeCloseTo(0, 6);
    expect(N.y).toBeCloseTo(0, 6);
    expect(N.z).toBeCloseTo(1, 6);
  });

  it('normal and tangent are orthogonal at every angle', () => {
    for (const deg of [0, 18, 45, 65, 90]) {
      const N = padNormal(deg);
      const V = padTangentV(deg);
      const d = N.x * V.x + N.y * V.y + N.z * V.z;
      expect(d).toBeCloseTo(0, 6);
    }
  });
});

describe('hit-detect — flat disc (snare-style)', () => {
  it('detects a downward stick crossing inside the footprint', () => {
    const r = detectPadHit(
      { prev: { x: 0, y: 0.85, z: -0.4 }, curr: { x: 0, y: 0.75, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).not.toBeNull();
    expect(r!.hit.y).toBeCloseTo(0.8, 6);
    expect(r!.speedIntoPad).toBeGreaterThan(HIT_VELOCITY_THRESHOLD_MPS);
  });

  it('rejects an upward swing (stick coming up off a previous strike)', () => {
    const r = detectPadHit(
      { prev: { x: 0, y: 0.75, z: -0.4 }, curr: { x: 0, y: 0.85, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).toBeNull();
  });

  it('rejects a hover that drifts through the plane below the threshold velocity', () => {
    // 0.05 m drift over 200 ms = 0.25 m/s — way below 1 m/s threshold.
    const r = detectPadHit(
      { prev: { x: 0, y: 0.81, z: -0.4 }, curr: { x: 0, y: 0.79, z: -0.4 }, dtSec: 0.20 },
      flatPad,
    );
    expect(r).toBeNull();
  });

  it('rejects a fast crossing that lands outside the footprint', () => {
    const r = detectPadHit(
      { prev: { x: 0.50, y: 0.85, z: -0.4 }, curr: { x: 0.50, y: 0.75, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).toBeNull();
  });

  it('accepts a strike that lands right on the footprint edge (size/2)', () => {
    // size 0.22 → half = 0.11
    const r = detectPadHit(
      { prev: { x: 0.10, y: 0.85, z: -0.4 }, curr: { x: 0.10, y: 0.75, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).not.toBeNull();
  });
});

describe('hit-detect — tilted ride (the regression this PR exists to fix)', () => {
  it('detects a downward strike that crosses the tilted face front-of-centre', () => {
    // Ride centre at y=1.15, tilt 65°. The pad face dips toward player
    // (+Z). A strike at the same world (x, z) as the centre crosses
    // through the centre — the most basic tilt-aware case.
    const r = detectPadHit(
      {
        prev: { x: 0.75, y: 1.20, z: -0.55 },
        curr: { x: 0.75, y: 1.10, z: -0.55 },
        dtSec: 0.016,
      },
      ridePad,
    );
    expect(r).not.toBeNull();
    expect(r!.hit.y).toBeCloseTo(1.15, 6);
  });

  it('rejects the false-positive that the OLD horizontal-plane detector would have fired: a stick well above the centre y=1.15 line but in front of the tilted face is NOT touching the pad yet', () => {
    // For ride at 65°, the front edge of the disc (size 0.32, half 0.16)
    // sits at world Y = centre.y - half * sin(65°) ≈ 1.15 - 0.145 = 1.005,
    // and at world Z = centre.z + half * cos(65°) ≈ -0.55 + 0.068 = -0.482.
    // A stick scrubbing across world Y = 1.05 in front of the disc (z = -0.30,
    // way in front of the face) crosses the OLD horizontal y=1.15 plane on
    // its way down to y=1.05, but is nowhere near the actual pad surface.
    // The new tilt-aware check rejects it.
    const r = detectPadHit(
      {
        prev: { x: 0.75, y: 1.20, z: -0.30 },
        curr: { x: 0.75, y: 1.05, z: -0.30 },
        dtSec: 0.016,
      },
      ridePad,
    );
    expect(r).toBeNull();
  });

  it('rejects a slow drift across the tilted face (below velocity threshold)', () => {
    const r = detectPadHit(
      {
        prev: { x: 0.75, y: 1.155, z: -0.55 },
        curr: { x: 0.75, y: 1.145, z: -0.55 },
        dtSec: 0.20,
      },
      ridePad,
    );
    expect(r).toBeNull();
  });

  it('the speed-into-pad reading is the velocity component along -N, not raw vertical speed', () => {
    // Pure vertical strike at 10 m/s on a 65° tilted pad: the velocity
    // projection onto -N is v · (0, -cos65°, -sin65°) = -10 · (-cos65°)
    // ≈ 4.23 m/s. The old detector would have reported 10 m/s; we want
    // the effort the player actually put through the surface.
    const dt = 0.001;
    const r = detectPadHit(
      {
        prev: { x: 0.75, y: 1.16, z: -0.55 },
        curr: { x: 0.75, y: 1.16 - 10 * dt, z: -0.55 },
        dtSec: dt,
      },
      ridePad,
    );
    expect(r).not.toBeNull();
    expect(r!.speedIntoPad).toBeCloseTo(10 * Math.cos((65 * Math.PI) / 180), 2);
  });
});

describe('hit-detect — bass drum face (stays horizontal-plane special case)', () => {
  it('uses the BD_HIT_HALF_M square footprint, not pad.size/2', () => {
    // size 0.30 → half would be 0.15; BD_HIT_HALF_M is 0.25, so a strike
    // at x = pad.x + 0.20 (outside the visual face but inside the
    // judgement zone) must register.
    expect(BD_HIT_HALF_M).toBeGreaterThan(bassPad.size / 2);
    const r = detectPadHit(
      {
        prev: { x: 0.35, y: 0.40, z: -0.5 },
        curr: { x: 0.35, y: 0.30, z: -0.5 },
        dtSec: 0.016,
      },
      bassPad,
    );
    expect(r).not.toBeNull();
  });

  it('rejects a strike outside the BD_HIT_HALF_M zone', () => {
    const r = detectPadHit(
      {
        prev: { x: 0.50, y: 0.40, z: -0.5 },
        curr: { x: 0.50, y: 0.30, z: -0.5 },
        dtSec: 0.016,
      },
      bassPad,
    );
    expect(r).toBeNull();
  });

  it('reports speedIntoPad as the raw downward vertical speed for a face pad (no tilt projection)', () => {
    // 8 m/s for 5 ms = 4 cm of travel. Start 1 cm above pad y, end 3 cm below.
    const dt = 0.005;
    const r = detectPadHit(
      {
        prev: { x: 0.15, y: 0.36, z: -0.5 },
        curr: { x: 0.15, y: 0.36 - 8 * dt, z: -0.5 },
        dtSec: dt,
      },
      bassPad,
    );
    expect(r).not.toBeNull();
    expect(r!.speedIntoPad).toBeCloseTo(8, 2);
  });
});

describe('hit-detect — defensive', () => {
  it('returns null when dtSec is zero or negative — pathological frame', () => {
    expect(
      detectPadHit(
        { prev: { x: 0, y: 0.85, z: -0.4 }, curr: { x: 0, y: 0.75, z: -0.4 }, dtSec: 0 },
        flatPad,
      ),
    ).toBeNull();
    expect(
      detectPadHit(
        { prev: { x: 0, y: 0.85, z: -0.4 }, curr: { x: 0, y: 0.75, z: -0.4 }, dtSec: -0.016 },
        flatPad,
      ),
    ).toBeNull();
  });

  it('grazing the surface (curr exactly at d=0) still counts as a crossing', () => {
    const r = detectPadHit(
      { prev: { x: 0, y: 0.82, z: -0.4 }, curr: { x: 0, y: 0.80, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).not.toBeNull();
  });

  it('does not match a sample sitting on the −N side at both prev and curr (already past the pad)', () => {
    const r = detectPadHit(
      { prev: { x: 0, y: 0.70, z: -0.4 }, curr: { x: 0, y: 0.60, z: -0.4 }, dtSec: 0.016 },
      flatPad,
    );
    expect(r).toBeNull();
  });
});
