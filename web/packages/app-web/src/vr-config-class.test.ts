import * as THREE from 'three';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, getConfig, loadConfig, updateConfig } from './config.js';
import {
  KIT_PRESETS,
  SEAT_Y_OFFSET_SIT,
  SEAT_Y_OFFSET_STAND,
} from './kit-preset.js';
import { AUTO_PLAY_LABELS, VR_CONFIG_LAYOUT, VrConfig } from './vr-config.js';

/**
 * VrConfig is canvas-2D view code — it paints to an HTMLCanvasElement
 * that's wrapped in a THREE.CanvasTexture for the VR panel. Per
 * CLAUDE.md we test it with a fake Three.js renderer: happy-dom gives
 * us the canvas, `webgl.xr.getController(i)` is stubbed the same way
 * `xr-controllers.test.ts` does it, and we exercise the round-trip
 *
 *   show() → paint() populates this.hits
 *           → __testClickAt(px, py) finds the matching rect
 *           → action() calls updateConfig
 *           → config store reflects the toggle
 *
 * No real WebGL context is ever allocated; this catches the "auto-play
 * lane cell doesn't actually wire through to config" regression at
 * unit-test speed.
 *
 * happy-dom's HTMLCanvasElement.getContext returns null by default
 * (it doesn't ship a full canvas2d implementation). We install a
 * no-op stub context so `paint()` can drive fillRect / fillText /
 * strokeRect without throwing — we're not asserting on pixels, only
 * on the hit-rects that `paint()` pushes into the class's `hits`
 * array as a side-effect of laying the buttons out.
 */

function installFakeCanvas2DContext(): void {
  const Ctor = globalThis.HTMLCanvasElement;
  if (!Ctor) return;
  const fakeCtx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    drawImage: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    measureText: (text: string) => ({ width: text.length * 7 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
  };
  // Cast to `any` on the assignment: HTMLCanvasElement.getContext has
  // several overloads TS can't reconcile with a single impl. We're
  // intentionally returning a stub CanvasRenderingContext2D-shape
  // object whose methods are all no-ops — safe because `paint()` only
  // invokes the methods we stubbed above.
  (Ctor.prototype as unknown as { getContext: (type: string) => unknown }).getContext =
    (type: string): unknown => (type === '2d' ? fakeCtx : null);
}

interface FakeWebGL {
  xr: {
    getController: (i: number) => THREE.Object3D;
    getSession: () => XRSession | null;
  };
  controllers: THREE.Object3D[];
}

function makeFakeWebGL(): FakeWebGL {
  const controllers = [new THREE.Object3D(), new THREE.Object3D()];
  return {
    xr: {
      getController: (i) => controllers[i]!,
      getSession: () => null,
    },
    controllers,
  };
}

function makeConfigPanel(): {
  panel: VrConfig;
  scene: THREE.Scene;
  gl: FakeWebGL;
} {
  const gl = makeFakeWebGL();
  const scene = new THREE.Scene();
  const panel = new VrConfig(gl as unknown as THREE.WebGLRenderer, scene);
  return { panel, scene, gl };
}

/** Cell centre in panel-canvas coordinates for the auto-play grid's
 * i-th lane, matching the layout in `paintAutoPlayGrid`. Used to find
 * a click point without depending on the exact layout constants. */
function autoPlayCellPoint(
  hits: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  laneIdx: number,
): { px: number; py: number } {
  // The auto-play cells are emitted in AUTO_PLAY_LANES order, starting
  // AFTER the 3 Audio sliders' step buttons (3 × 2 = 6 hits) and the
  // Gameplay section's 2 slider-step-pairs + 2 toggles (4 + 2 = 6
  // hits), plus whatever sections come before. Rather than hard-code
  // that offset, locate the grid by its 4-column geometry: cells are
  // ~225 wide + 8 gap, vs the 100 wide toggles / 56 wide step
  // buttons, so the first 4-column cluster is the auto-play grid.
  // This keeps the test robust against section reordering.
  const gridStart = hits.findIndex((h, i, arr) => {
    if (h.w < 180 || h.w > 240) return false;
    const next3 = arr.slice(i, i + 4);
    if (next3.length < 4) return false;
    const allSameWidth = next3.every((c) => Math.abs(c.w - h.w) < 2);
    const allSameY = next3.every((c) => c.y === h.y);
    return allSameWidth && allSameY;
  });
  if (gridStart < 0) throw new Error('auto-play grid not found in hits');
  const cell = hits[gridStart + laneIdx];
  if (!cell) throw new Error(`auto-play lane ${laneIdx} missing`);
  return { px: cell.x + cell.w / 2, py: cell.y + cell.h / 2 };
}

describe('VrConfig — canvas-2D panel wiring', () => {
  beforeAll(() => {
    installFakeCanvas2DContext();
  });

  beforeEach(() => {
    localStorage.clear();
    // Reset the in-memory config singleton so one test's updateConfig
    // doesn't leak into the next. `loadConfig()` re-reads localStorage
    // (now empty) and pushes defaults into the subscribe bus.
    updateConfig(loadConfig());
  });

  it('constructs without throwing and mounts a mesh into the scene', () => {
    const { scene } = makeConfigPanel();
    // The panel plane is scene.add()ed in the constructor, initially
    // hidden. Just checking it's attached so `hide()` has something to
    // toggle.
    const meshes = scene.children.filter((c): c is THREE.Mesh => c.type === 'Mesh');
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    const panelMesh = meshes.find(
      (m) => (m.geometry as THREE.PlaneGeometry).type === 'PlaneGeometry',
    );
    expect(panelMesh).toBeTruthy();
    expect(panelMesh!.visible).toBe(false);
  });

  it('show() paints and flips the mesh visible; hide() reverts', () => {
    const { panel, scene } = makeConfigPanel();
    const panelMesh = scene.children.find(
      (c) => c.type === 'Mesh' && (c as THREE.Mesh).geometry.type === 'PlaneGeometry',
    ) as THREE.Mesh;

    panel.show(() => {});
    expect(panelMesh.visible).toBe(true);
    expect(panel.__testHits().length).toBeGreaterThan(0);

    panel.hide();
    expect(panelMesh.visible).toBe(false);
  });

  it('paint emits exactly 11 auto-play cells, one per AUTO_PLAY_LANES entry', () => {
    // Count the 4-column cluster of same-width, same-y rects. If a
    // refactor drops a lane or duplicates one, this catches it before
    // anyone boots a headset.
    const { panel } = makeConfigPanel();
    panel.show(() => {});
    const hits = panel.__testHits();

    const start = hits.findIndex((h, i, arr) => {
      if (h.w < 180 || h.w > 240) return false;
      return arr.slice(i, i + 4).every((c) => c.y === h.y && Math.abs(c.w - h.w) < 2);
    });
    expect(start).toBeGreaterThanOrEqual(0);

    // Walk forward while we're still inside the grid (same approximate
    // width, monotonically increasing x or wrapping to next row).
    const cellW = hits[start]!.w;
    let count = 0;
    for (let i = start; i < hits.length; i++) {
      const h = hits[i]!;
      if (Math.abs(h.w - cellW) > 2) break;
      count++;
    }
    expect(count).toBe(11);
  });

  it('clicking the Bass (BD) auto-play cell flips config.autoPlay.BD on', () => {
    const { panel } = makeConfigPanel();
    panel.show(() => {});
    expect(getConfig().autoPlay.BD).toBe(false);

    // BD is index 5 in AUTO_PLAY_LANES (LC, HH, LP, SD, HT, BD, …).
    // Sanity-check the label matches what the panel paints so a future
    // rename in AUTO_PLAY_LABELS doesn't silently break this test.
    expect(AUTO_PLAY_LABELS.BD).toBe('Bass (Kick)');

    const { px, py } = autoPlayCellPoint(panel.__testHits(), 5);
    const fired = panel.__testClickAt(px, py);
    expect(fired).toBe(true);
    expect(getConfig().autoPlay.BD).toBe(true);
    // Sibling lanes untouched — guards the shared toggleAutoPlayLane
    // contract at the integration layer.
    expect(getConfig().autoPlay.LBD).toBe(false);
    expect(getConfig().autoPlay.HH).toBe(false);
  });

  it('clicking the same cell twice toggles back off (symmetric)', () => {
    const { panel } = makeConfigPanel();
    panel.show(() => {});

    const cellFor = (): { px: number; py: number } =>
      autoPlayCellPoint(panel.__testHits(), 5);
    panel.__testClickAt(cellFor().px, cellFor().py);
    expect(getConfig().autoPlay.BD).toBe(true);
    // `paint()` re-runs on config change (subscribe → dirty flag),
    // but __testHits() snapshots whatever the last paint produced. In
    // the test context we call __testClickAt directly which only
    // flipped the action; for a second click to find the same cell
    // we need paint() to have re-run. `show()` forces an immediate
    // repaint, so call it again or drive `dirty` via the public tick
    // surface. Simplest: call show again (idempotent flip of flags).
    panel.show(() => {});
    panel.__testClickAt(cellFor().px, cellFor().py);
    expect(getConfig().autoPlay.BD).toBe(false);
  });

  // Drum-kit section: preset picker + seat-Y offset slider + Sit/Stand
  // quick buttons. These wire through to the same updateConfig path as
  // the auto-play grid above, so the integration test exercises the
  // round trip rather than the geometry. Geometry stays inside the
  // generic "every hit-rect inside the panel" sweep further down.

  it('preset picker emits one button per registered kit preset', () => {
    const { panel } = makeConfigPanel();
    panel.show(() => {});
    const hits = panel.__testHits();
    // Preset buttons are >= 200 px wide (full preset.label fits) and
    // share a y-coord. They sit before the auto-play grid (cells
    // ~225 wide) so we walk forward looking for the first run of
    // wide same-y rects whose count matches KIT_PRESETS.length and
    // whose width is well above the auto-play cell width — preset
    // bar takes the full content area minus the label gutter, so
    // each button is much wider than ~225.
    let foundRun = false;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      // Preset buttons are wider than auto-play cells — they share the
      // full content area, so they'll be ≥ 240 px wide for the current
      // KIT_PRESETS.length of 2.
      if (h.w < 240) continue;
      const run = hits
        .slice(i, i + KIT_PRESETS.length)
        .filter((c) => c.y === h.y && Math.abs(c.w - h.w) < 2);
      if (run.length === KIT_PRESETS.length) {
        // Sanity: next hit (if any) should be on a different y or a
        // different width — we picked up the whole preset bar, not a
        // sub-run of the auto-play grid (which is 4-wide, narrower).
        foundRun = true;
        break;
      }
    }
    expect(foundRun).toBe(true);
  });

  it('clicking the second preset button switches kitPresetId in the config blob', () => {
    const { panel } = makeConfigPanel();
    panel.show(() => {});
    const initial = getConfig().kitPresetId;
    expect(initial).toBe(KIT_PRESETS[0]!.id);

    // Find the preset bar by its hallmark: the first run of
    // KIT_PRESETS.length same-y rects each ≥ 240 px wide. Click the
    // SECOND button to switch from the default preset to the next
    // one.
    const hits = panel.__testHits();
    let firstButtonIdx = -1;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      if (h.w < 240) continue;
      const run = hits
        .slice(i, i + KIT_PRESETS.length)
        .filter((c) => c.y === h.y && Math.abs(c.w - h.w) < 2);
      if (run.length === KIT_PRESETS.length) {
        firstButtonIdx = i;
        break;
      }
    }
    expect(firstButtonIdx).toBeGreaterThanOrEqual(0);
    const second = hits[firstButtonIdx + 1]!;
    const fired = panel.__testClickAt(second.x + second.w / 2, second.y + second.h / 2);
    expect(fired).toBe(true);
    expect(getConfig().kitPresetId).toBe(KIT_PRESETS[1]!.id);
    expect(getConfig().kitPresetId).not.toBe(initial);
  });

  it('Sit / Stand quick buttons set seatYOffset to the SIT / STAND constants', () => {
    const { panel } = makeConfigPanel();
    panel.show(() => {});

    // Prime the slider away from both quick-set values so we can prove
    // each button is doing the assignment rather than no-op'ing.
    updateConfig({ seatYOffset: 0.25 });
    panel.show(() => {}); // re-paint with new value

    // Sit / Stand are the only 32-px-tall pills in the Drum kit
    // section (auto-play cells are 36 px tall, step buttons are
    // ~36 px). Identify them by row geometry: same y, h=32, and
    // h-rect width either 84 (Sit) or 132 (Stand · NNN cm) — Stand
    // is wider because its label carries the standing-stature hint.
    const hits = panel.__testHits();
    const pills = hits.filter(
      (h) => h.h === 32 && (h.w === 84 || h.w === 132),
    );
    expect(pills.length).toBe(2);

    // Sit is the narrower one (no embedded cm number).
    const sit = pills.find((p) => p.w === 84)!;
    const stand = pills.find((p) => p.w === 132)!;
    expect(sit.y).toBe(stand.y); // same row

    panel.__testClickAt(sit.x + sit.w / 2, sit.y + sit.h / 2);
    expect(getConfig().seatYOffset).toBe(SEAT_Y_OFFSET_SIT);

    panel.show(() => {}); // re-paint after the click
    panel.__testClickAt(stand.x + stand.w / 2, stand.y + stand.h / 2);
    expect(getConfig().seatYOffset).toBe(SEAT_Y_OFFSET_STAND);
  });

  it('the Back-to-menu button fires the onClose callback exactly once', () => {
    const { panel } = makeConfigPanel();
    let closed = 0;
    panel.show(() => {
      closed++;
    });

    // Back button lives in the right-aligned footer strip; pick its
    // centre point from VR_CONFIG_LAYOUT rather than guessing at raw
    // pixel coords.
    const backCenterX =
      VR_CONFIG_LAYOUT.PANEL_W_PX - 40 - VR_CONFIG_LAYOUT.BACK_BTN_W / 2;
    const backCenterY =
      VR_CONFIG_LAYOUT.FOOTER_TOP + VR_CONFIG_LAYOUT.FOOTER_H / 2;
    const fired = panel.__testClickAt(backCenterX, backCenterY);
    expect(fired).toBe(true);
    expect(closed).toBe(1);
  });

  it('every auto-play cell stays inside the panel canvas', () => {
    // Catches a refactor that shrinks the panel but forgets to resize
    // the grid — the last row would spill off the bottom edge and
    // become unclickable in VR.
    const { panel } = makeConfigPanel();
    panel.show(() => {});
    for (const h of panel.__testHits()) {
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeGreaterThanOrEqual(0);
      expect(h.x + h.w).toBeLessThanOrEqual(VR_CONFIG_LAYOUT.PANEL_W_PX);
      expect(h.y + h.h).toBeLessThanOrEqual(VR_CONFIG_LAYOUT.PANEL_H_PX);
    }
  });

  it('show()/paint() reads live config so an externally-updated autoPlay paints coloured', () => {
    // Covers the subscribe() bus: a keyboard shortcut or desktop DOM
    // panel flipping `autoPlay.BD = true` while the VR panel is up
    // must repaint the cell as ON. We can't easily assert pixel
    // colour, but we CAN assert that the hit-rect's action flips
    // correctly (click → off), which depends on paint() having
    // captured the current value.
    updateConfig({ autoPlay: { ...DEFAULT_CONFIG.autoPlay, BD: true } });
    const { panel } = makeConfigPanel();
    panel.show(() => {});

    const { px, py } = autoPlayCellPoint(panel.__testHits(), 5);
    panel.__testClickAt(px, py);
    // Paint captured BD=true; click action sent `{ ...true-map, BD: false }`.
    expect(getConfig().autoPlay.BD).toBe(false);
  });
});
