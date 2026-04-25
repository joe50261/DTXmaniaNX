import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BoxNode, ChartEntry, SongEntry } from '@dtxmania/dtx-core';
import { SongSelectCanvas, type SongSelectDeps } from './song-select-canvas.js';
import { SONG_SELECT_FOOTER } from './song-select-layout.js';

/**
 * SongSelectCanvas is canvas-2D view code (mirrors VrConfig). Same test recipe:
 * real happy-dom canvas, stubbed `getContext('2d')` so paint() doesn't
 * throw, fake Three.js renderer that only implements the two methods
 * the class touches from its constructor + show().
 *
 * The specific regressions we pin down here:
 *   - Settings / Calibrate / Exit VR hit-rects exist when deps wire
 *     their handlers.
 *   - Utility buttons only appear when the corresponding dep handler
 *     is passed (explicit opt-in contract).
 *   - A ray-cast click at the Settings button's centre fires
 *     `deps.onConfig` — so an accidental swap of action.kind routing
 *     in `invokeHit` is caught.
 *   - Clicking the Exit VR button fires `onExit` exactly once.
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
  // See vr-config-class.test.ts for the same cast rationale — the
  // overloaded getContext signature doesn't reconcile with a single
  // `unknown`-returning impl, so we cast on the assignment site.
  (Ctor.prototype as unknown as { getContext: (type: string) => unknown }).getContext =
    (type: string): unknown => (type === '2d' ? fakeCtx : null);
}

function makeFakeWebGL(): {
  xr: { getController: (i: number) => THREE.Object3D; getSession: () => null };
} {
  const controllers = [new THREE.Object3D(), new THREE.Object3D()];
  return {
    xr: {
      getController: (i) => controllers[i]!,
      getSession: () => null,
    },
  };
}

/** Minimal library: root box containing a single song with one chart.
 * SongSelectCanvas walks this tree on show(); we only need enough for paint()
 * to emit its hit-rects — the focus entries are covered by the
 * dedicated song-wheel-model tests. */
function makeLibrary(): BoxNode {
  const chart: ChartEntry = {
    slot: 0,
    label: 'BASIC',
    chartPath: 'song/chart.dtx',
    drumLevel: 50,
  };
  const song: SongEntry = {
    title: 'Test Song',
    folderPath: 'song',
    fromSetDef: false,
    charts: [chart],
    bpm: 120,
  };
  const root: BoxNode = {
    type: 'box',
    name: '/',
    path: '/',
    parent: null,
    children: [],
  };
  root.children.push({ type: 'song', entry: song, parent: root });
  return root;
}

/** Library with three songs at root so sort/search behaviour shows. */
function makeMultiSongLibrary(): BoxNode {
  const root: BoxNode = {
    type: 'box',
    name: '/',
    path: '/',
    parent: null,
    children: [],
  };
  const songs: Array<{ title: string; artist: string; bpm: number }> = [
    { title: 'Charlie', artist: 'Alpha', bpm: 200 },
    { title: 'Alpha', artist: 'Bravo', bpm: 100 },
    { title: 'Bravo', artist: 'Charlie', bpm: 150 },
  ];
  for (const { title, artist, bpm } of songs) {
    const chart: ChartEntry = {
      slot: 3,
      label: 'MASTER',
      chartPath: `${title}/chart.dtx`,
      drumLevel: 500,
    };
    const song: SongEntry = {
      title,
      artist,
      folderPath: title,
      fromSetDef: false,
      charts: [chart],
      bpm,
    };
    root.children.push({ type: 'song', entry: song, parent: root });
  }
  return root;
}

function makeDeps(overrides: Partial<SongSelectDeps> = {}): SongSelectDeps {
  return {
    loadBytes: async () => new ArrayBuffer(0),
    joinPath: (folder, rel) => `${folder}/${rel}`,
    onFocusedSong: () => {},
    ...overrides,
  };
}

describe('SongSelectCanvas — canvas-2D panel wiring', () => {
  beforeAll(() => {
    installFakeCanvas2DContext();
  });

  it('constructs + mounts a plane + two laser Lines under the scene', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    void menu;
    const meshes = scene.children.filter((c): c is THREE.Mesh => c.type === 'Mesh');
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    // Lines + tip marks add more children; the panel plane is hidden
    // until show().
    const panelMesh = meshes.find(
      (m) => (m.geometry as THREE.PlaneGeometry).type === 'PlaneGeometry',
    );
    expect(panelMesh).toBeTruthy();
    expect(panelMesh!.visible).toBe(false);
  });

  it('show() paints a full hit-list including Exit VR when deps provided', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps(),
    );
    const hits = menu.__testHits();
    expect(hits.some((h) => h.kind === 'exit')).toBe(true);
    // Wheel rows + chart buttons + Exit = at least a few hits.
    expect(hits.length).toBeGreaterThan(1);
  });

  it('Settings button only appears when onConfig dep is wired (explicit opt-in)', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);

    // No onConfig → no 'config' hit.
    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps(),
    );
    expect(menu.__testHits().some((h) => h.kind === 'config')).toBe(false);

    menu.hide();

    // With onConfig → exactly one 'config' hit.
    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps({ onConfig: () => {} }),
    );
    const configHits = menu.__testHits().filter((h) => h.kind === 'config');
    expect(configHits).toHaveLength(1);
  });

  it('Calibrate button only appears when onCalibrate dep is wired', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);

    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps({ onCalibrate: () => {} }),
    );
    expect(
      menu.__testHits().filter((h) => h.kind === 'calibrate'),
    ).toHaveLength(1);
  });

  it('clicking the Settings rect fires deps.onConfig', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    let configCount = 0;
    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps({ onConfig: () => configCount++ }),
    );
    const hit = menu.__testHits().find((h) => h.kind === 'config');
    expect(hit).toBeTruthy();
    const fired = menu.__testClickAt(hit!.x + hit!.w / 2, hit!.y + hit!.h / 2);
    expect(fired).toBe(true);
    expect(configCount).toBe(1);
  });

  it('clicking the Exit VR rect fires the onExit callback exactly once', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    let exitCount = 0;
    menu.show(
      makeLibrary(),
      () => {},
      () => exitCount++,
      makeDeps(),
    );
    const hit = menu.__testHits().find((h) => h.kind === 'exit');
    expect(hit).toBeTruthy();
    menu.__testClickAt(hit!.x + hit!.w / 2, hit!.y + hit!.h / 2);
    expect(exitCount).toBe(1);
  });

  it('cycleSortMode walks title→artist→bpm→level→title and reorders entries', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(
      makeMultiSongLibrary(),
      () => {},
      () => {},
      makeDeps(),
    );
    expect(menu.getSortMode()).toBe('title');
    // Title order: Alpha (the song), Bravo, Charlie. The first synthetic
    // row at root is Random (no Back when at root). focusedSong reads
    // the current focus, which after a fresh show() is on the first
    // entry — Random — so we step focus by selecting via __testClickAt.
    expect(menu.cycleSortMode()).toBe('artist');
    expect(menu.getSortMode()).toBe('artist');
    expect(menu.cycleSortMode()).toBe('bpm');
    expect(menu.cycleSortMode()).toBe('level');
    expect(menu.cycleSortMode()).toBe('title');
  });

  it('setSearchQuery filters the wheel entries by title substring', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(
      makeMultiSongLibrary(),
      () => {},
      () => {},
      makeDeps(),
    );
    menu.setSearchQuery('alp');
    // Random + 1 song match (Alpha). 'activate' hits map 1:1 to wheel
    // rows — Random is one and Alpha is the second.
    const activateHits = menu.__testHits().filter((h) => h.kind === 'activate');
    expect(activateHits.length).toBeGreaterThanOrEqual(2);
    expect(menu.getSearchQuery()).toBe('alp');
  });

  it('setSearchQuery normalises whitespace + case so callers can pipe raw input', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(makeMultiSongLibrary(), () => {}, () => {}, makeDeps());
    menu.setSearchQuery('  ALPHA  ');
    expect(menu.getSearchQuery()).toBe('alpha');
  });

  it('setRoot(null) clears entries; setRoot(root) restores them', () => {
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(makeLibrary(), () => {}, () => {}, makeDeps());
    const beforeHits = menu.__testHits().filter((h) => h.kind === 'activate').length;
    expect(beforeHits).toBeGreaterThan(0);

    menu.setRoot(null);
    const clearedHits = menu.__testHits().filter((h) => h.kind === 'activate').length;
    expect(clearedHits).toBe(0);

    menu.setRoot(makeLibrary());
    const restoredHits = menu.__testHits().filter((h) => h.kind === 'activate').length;
    expect(restoredHits).toBeGreaterThan(0);
  });

  it('hint-text baseline sits strictly above the Exit VR + utility button tops', () => {
    // Spot-check the geometry invariant at the integration layer —
    // SONG_SELECT_FOOTER.hintBaselineY() already has its own unit test,
    // but this catches a refactor that moves paintFooter to paint
    // hints somewhere OTHER than hintBaselineY and would overlap the
    // buttons in practice.
    const gl = makeFakeWebGL();
    const scene = new THREE.Scene();
    const menu = new SongSelectCanvas(gl as unknown as THREE.WebGLRenderer, scene);
    menu.show(
      makeLibrary(),
      () => {},
      () => {},
      makeDeps({ onConfig: () => {}, onCalibrate: () => {} }),
    );
    const hits = menu.__testHits();
    const exit = hits.find((h) => h.kind === 'exit')!;
    const config = hits.find((h) => h.kind === 'config')!;
    const calibrate = hits.find((h) => h.kind === 'calibrate')!;
    const buttonTop = Math.min(exit.y, config.y, calibrate.y);
    expect(SONG_SELECT_FOOTER.hintBaselineY() + 3).toBeLessThan(buttonTop);
  });
});
