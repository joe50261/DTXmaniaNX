import { describe, it, expect } from 'vitest';
import {
  BROADCAST_CAMERA,
  BROADCAST_ASPECT,
  PLAYFIELD_PANEL,
  projectToNdc,
  computeFraming,
  type Vec3,
} from './broadcast-camera-model.js';
import {
  KIT_PRESETS,
  applySeatYOffset,
  SEAT_Y_OFFSET_MIN,
  SEAT_Y_OFFSET_MAX,
  SEAT_Y_OFFSET_SIT,
  SEAT_Y_OFFSET_STAND,
} from '../kit-preset.js';

/** Sample the note-highway panel as a 5×5 grid of world points. */
function panelPoints(): Vec3[] {
  const [cx, cy, cz] = PLAYFIELD_PANEL.center;
  const hw = PLAYFIELD_PANEL.width / 2;
  const hh = PLAYFIELD_PANEL.height / 2;
  const pts: Vec3[] = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      pts.push([cx + (i / 2) * hw, cy + (j / 2) * hh, cz]);
    }
  }
  return pts;
}

/** Every pad's square footprint (centre ± half-size in X and Y) for a preset
 *  at a given seat offset. Chrome stands run to the floor and are allowed to
 *  clip off the bottom edge, so they are intentionally excluded. */
function padFootprintPoints(presetId: string, seatOffset: number): Vec3[] {
  const preset = KIT_PRESETS.find((p) => p.id === presetId)!;
  const pads = applySeatYOffset(preset.pads, seatOffset);
  const pts: Vec3[] = [];
  for (const pad of pads) {
    const h = pad.size / 2;
    for (const dx of [-h, 0, h]) {
      for (const dy of [-h, 0, h]) {
        pts.push([pad.position.x + dx, pad.position.y + dy, pad.position.z]);
      }
    }
  }
  return pts;
}

const SEAT_OFFSETS = [
  SEAT_Y_OFFSET_MIN,
  SEAT_Y_OFFSET_SIT,
  SEAT_Y_OFFSET_STAND,
  SEAT_Y_OFFSET_MAX,
];

describe('projectToNdc', () => {
  it('places the playfield-panel centre on the vertical axis, in front of the camera', () => {
    const n = projectToNdc(PLAYFIELD_PANEL.center);
    expect(Math.abs(n.x)).toBeLessThan(1e-9); // dead-centre horizontally
    expect(n.viewZ).toBeLessThan(0); // in front of the camera
    // Panel centre sits in the upper half of the frame (kit fills below it).
    expect(n.y).toBeGreaterThan(0.2);
    expect(n.y).toBeLessThan(0.7);
  });

  it('never returns NaN/Infinity, even for a point on the camera plane', () => {
    const onPlane: Vec3 = [
      BROADCAST_CAMERA.position[0],
      BROADCAST_CAMERA.position[1],
      BROADCAST_CAMERA.position[2],
    ];
    const n = projectToNdc(onPlane);
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
  });
});

describe('broadcast camera framing', () => {
  it('keeps the whole kit + highway in-frame for every preset and seat offset', () => {
    for (const preset of KIT_PRESETS) {
      for (const seat of SEAT_OFFSETS) {
        const points = [...panelPoints(), ...padFootprintPoints(preset.id, seat)];
        const f = computeFraming(points);
        expect(
          f.allInFrame,
          `${preset.id} @ seat ${seat} clipped: ndc=${JSON.stringify(f.ndc)}`,
        ).toBe(true);
      }
    }
  });

  it('leaves only a small black margin top and bottom in the default sit setup', () => {
    const points = [
      ...panelPoints(),
      ...padFootprintPoints(KIT_PRESETS[0]!.id, SEAT_Y_OFFSET_SIT),
    ];
    const f = computeFraming(points);
    // The black-bar complaint: top/bottom must be tight (~5%), not the
    // ~20% the earlier 95° FOV produced.
    expect(f.black.top).toBeLessThan(0.08);
    expect(f.black.bottom).toBeLessThan(0.08);
    // …which means the subject fills most of the frame height.
    const verticalFill = (f.ndc.yMax - f.ndc.yMin) / 2;
    expect(verticalFill).toBeGreaterThan(0.85);
  });

  it('fills vertically first — side pillarbox is the residual, not top/bottom', () => {
    // Documents the deliberate tradeoff: the kit+highway is portrait-shaped
    // in a 16:9 frame, so filling it vertically leaves side margin. Guards
    // against a regression that would crop the sides to kill pillarbox and
    // in doing so re-introduce top/bottom black or clip the outer pads.
    const points = [
      ...panelPoints(),
      ...padFootprintPoints(KIT_PRESETS[0]!.id, SEAT_Y_OFFSET_SIT),
    ];
    const f = computeFraming(points);
    expect(f.black.left).toBeGreaterThan(f.black.top);
    expect(f.black.right).toBeGreaterThan(f.black.bottom);
  });

  it('is markedly tighter than the earlier wide-FOV framing', () => {
    // The fix was a vertical-FOV reduction. Prove the model captures the
    // difference: the old 95° angle left big top/bottom bars; the shipped
    // camera does not.
    const points = [
      ...panelPoints(),
      ...padFootprintPoints(KIT_PRESETS[0]!.id, SEAT_Y_OFFSET_SIT),
    ];
    const wide = computeFraming(points, { ...BROADCAST_CAMERA, fovDeg: 95 });
    const shipped = computeFraming(points);
    expect(wide.black.top).toBeGreaterThan(0.15);
    expect(shipped.black.top).toBeLessThan(wide.black.top - 0.1);
  });
});

describe('framing constants stay consistent with render.ts', () => {
  it('uses the 16:9 aspect the video is encoded at', () => {
    expect(BROADCAST_ASPECT).toBeCloseTo(1280 / 720, 10);
  });

  it('exposes a vertical FOV that is a sane broadcast angle', () => {
    expect(BROADCAST_CAMERA.fovDeg).toBeGreaterThan(30);
    expect(BROADCAST_CAMERA.fovDeg).toBeLessThan(90);
    expect(BROADCAST_CAMERA.near).toBeLessThan(BROADCAST_CAMERA.far);
  });
});
