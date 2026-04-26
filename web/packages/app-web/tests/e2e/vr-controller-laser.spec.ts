import { test, expect, type Page } from '@playwright/test';
import {
  installIwerRuntime,
  panelPixelToWorld,
  pulseTrigger,
  QUAT_IDENTITY,
  setControllerPose,
  type PanelGeometry,
} from './iwer-helper';

/**
 * Real `THREE.Raycaster` against the in-VR panel meshes — the gap
 * `xr-controllers.test.ts` and `song-select-canvas-class.test.ts`
 * cannot fill on their own. The unit tests cover button-rect math
 * with synthetic UV inputs; this spec proves the RAY pipeline:
 *
 *   iwer XRController pose → XRSession.inputSources[i] →
 *   three.js controller worldMatrix → ray origin + direction →
 *   raycaster.intersectObject(panel.mesh) → uv → panel pixel →
 *   findHitByRect → action()
 *
 * A regression in any one of those (e.g. the `setControllerPose`
 * → targetRaySpace pump breaking, or a wrong worldMatrix on the
 * panel mesh after a layout refactor) silently breaks every
 * in-VR click and leaves players stuck pointing at unresponsive
 * buttons.
 *
 * Three phases, all real raycast:
 *   1. Aim at song-select Settings button → opens VR config panel
 *      (`Game.vrConfigShown` flips true).
 *   2. Aim at vr-config Sit button → `seatYOffset` config flips
 *      to `SEAT_Y_OFFSET_SIT` (read from localStorage).
 *   3. Aim at vr-config BD auto-play cell → `autoPlay.BD` flips
 *      to true (read from localStorage). Pins the auto-play grid
 *      cell-rect math too: a layout regression that shifted the
 *      grid would have ray missing the cell, not silently writing
 *      a different lane.
 */

interface FakeLibrarySpec {
  songs: Array<{ title: string; charts: Array<{ slot: number; label: string; level?: number }> }>;
}

async function installFakeLibrary(page: Page, spec: FakeLibrarySpec): Promise<void> {
  await page.evaluate(async (s) => {
    const hook = (window as unknown as {
      __dtxmaniaTest?: { installFakeLibrary?: (spec: unknown) => Promise<void> };
    }).__dtxmaniaTest;
    if (!hook?.installFakeLibrary) throw new Error('installFakeLibrary hook missing');
    await hook.installFakeLibrary(s);
  }, spec);
}

type HookShape = {
  __dtxmaniaTest?: {
    game?: {
      inXR: boolean;
      songSelectShown: boolean;
      vrConfigShown: boolean;
      vrConfigHits: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
    };
  };
};

async function pollFlag(
  page: Page,
  flag: 'inXR' | 'songSelectShown' | 'vrConfigShown',
  expected: boolean,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (k: 'inXR' | 'songSelectShown' | 'vrConfigShown') =>
            (window as unknown as HookShape).__dtxmaniaTest?.game?.[k] ?? null,
          flag,
        ),
      { timeout: 5_000 },
    )
    .toBe(expected);
}

// Mirrors `song-select-layout.ts` / `song-select-canvas.ts`. Hardcoded
// rather than imported so a layout change that breaks the spec fails
// loudly with "ray missed Settings" rather than silently passing
// against a stale geometry. See the cross-reference comments next
// to each constant.
const SONG_SELECT_PANEL: PanelGeometry = {
  // PANEL_POS in song-select-canvas.ts (PANEL_POS_Y/Z from
  // song-select-layout.ts).
  worldPos: { x: 0, y: 1.45, z: -1.5 },
  // PANEL_WORLD_W / PANEL_WORLD_H in song-select-layout.ts.
  worldW: 1.92,
  worldH: 1.08,
  // PANEL_W_PX / PANEL_H_PX in song-select-layout.ts.
  pixelW: 1280,
  pixelH: 720,
};

// Settings (FOOTER_CONFIG_X=40, FOOTER_UTIL_BTN_Y=682, w=160, h=30
// from song-select-layout.ts) — centre at (120, 697).
const SETTINGS_BUTTON_CENTER_PX = { x: 120, y: 697 };

// vr-config panel constants (vr-config.ts).
const VR_CONFIG_PANEL: PanelGeometry = {
  worldPos: { x: 0, y: 1.55, z: -1.5 },
  worldW: 1.6,
  // worldH = worldW * (pixelH / pixelW) = 1.6 * (1260 / 1024) = 1.96875.
  worldH: (1.6 * 1260) / 1024,
  pixelW: 1024,
  pixelH: 1260,
};

// SEAT_Y_OFFSET_SIT in kit-preset.ts. If this drifts the spec
// reports the actual stored value, which is enough to point at the
// renamed/retuned constant.
const SEAT_Y_OFFSET_SIT = 0;

const STORAGE_KEY = 'dtxmania.config';

/** Aim the right controller so its forward laser hits the requested
 * panel-pixel coordinate. Place the controller 0.5 m in front of the
 * panel (z = panel.z + 0.5) at the same XY as the target world
 * point; identity quaternion → ray dir (0,0,-1) → strikes the panel
 * at exactly that XY. */
async function aimRightAt(page: Page, panel: PanelGeometry, px: number, py: number): Promise<void> {
  const target = panelPixelToWorld(panel, px, py);
  await setControllerPose(
    page,
    'right',
    { x: target.x, y: target.y, z: target.z + 0.5 },
    QUAT_IDENTITY,
  );
}

test.describe('VR controller laser — real raycast clicks panel buttons', () => {
  test('right-controller laser hits Settings → VR config opens; Sit → seatYOffset = SIT; BD cell → autoPlay.BD = true', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');

    // Reset config before the test so a previous run's seatYOffset
    // doesn't pre-satisfy the Sit assertion. The page reads
    // localStorage on first import; clear before evaluating any app
    // code that would write a default blob back.
    await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
    await page.reload();

    await installFakeLibrary(page, {
      songs: [{ title: 'Alpha', charts: [{ slot: 1, label: 'REG', level: 300 }] }],
    });
    await expect(page.locator('#enter-xr')).toBeVisible();
    await page.locator('#enter-xr').click();
    await pollFlag(page, 'inXR', true);
    await pollFlag(page, 'songSelectShown', true);
    await pollFlag(page, 'vrConfigShown', false);

    // ── Phase 1: aim at Settings button on the song-select panel ──
    // Place controller 0.5 m in front of the Settings rect centre
    // with identity quaternion. The forward ray strikes the panel
    // mesh at the exact world point matching pixel (120, 697),
    // which falls inside FOOTER_CONFIG (40-200, 682-712).
    await aimRightAt(
      page,
      SONG_SELECT_PANEL,
      SETTINGS_BUTTON_CENTER_PX.x,
      SETTINGS_BUTTON_CENTER_PX.y,
    );
    // Give iwer a frame to pump the new pose into inputSources before
    // the trigger pulse arrives — the raycast needs the new pose,
    // not the previous chest-front default.
    await page.waitForTimeout(50);
    await pulseTrigger(page, 'right');

    // SongSelectCanvas.tick on the press edge calls findHitByRect
    // → the Settings hit's action() → deps.onConfig → main.ts
    // hides the menu and shows the VR config panel.
    await pollFlag(page, 'songSelectShown', false);
    await pollFlag(page, 'vrConfigShown', true);

    // ── Phase 2: aim at Sit button on the vr-config panel ──
    // Sit is the only 84×32 px hit on the panel (vr-config-class.test
    // identifies it the same way — see the comment there). Read the
    // live hits[] so a layout shift that moves the row Y still works.
    const sitHit = await page.evaluate(
      () =>
        (window as unknown as HookShape).__dtxmaniaTest?.game?.vrConfigHits.find(
          (h) => h.w === 84 && h.h === 32,
        ) ?? null,
    );
    expect(sitHit, 'Sit hit not found in vrConfigHits').not.toBeNull();
    const sit = sitHit!;

    await aimRightAt(page, VR_CONFIG_PANEL, sit.x + sit.w / 2, sit.y + sit.h / 2);
    await page.waitForTimeout(50);
    await pulseTrigger(page, 'right');

    // VrConfig.tick on the press edge runs hits[idx].action() →
    // updateConfig({ seatYOffset: SEAT_Y_OFFSET_SIT }) → localStorage
    // is written immediately. Poll the persisted blob (same pattern
    // as config-panel.spec.ts) to give iwer's input pump time to
    // land the press edge.
    await expect
      .poll(
        () =>
          page.evaluate((k) => {
            const raw = localStorage.getItem(k);
            if (raw === null) return null;
            try {
              return (JSON.parse(raw) as { seatYOffset?: number }).seatYOffset ?? null;
            } catch {
              return null;
            }
          }, STORAGE_KEY),
        { timeout: 3_000 },
      )
      .toBe(SEAT_Y_OFFSET_SIT);

    // ── Phase 3: aim at the BD (Bass Kick) auto-play cell ──
    // Auto-play cells form a 4-column grid further down the panel.
    // Locate the grid by its 4-cells-in-a-row geometry (same robust
    // approach `vr-config-class.test.ts:autoPlayCellPoint` uses), then
    // index BD by its position in AUTO_PLAY_LANES (LC, HH, LP, SD,
    // HT, BD, …) — index 5. The cells are ~225 px wide on a 1024 px
    // panel; everything else is narrower (toggles 100, step buttons
    // ~56, Sit/Stand 84/132). The lane order + label is pinned in
    // the unit test.
    const bdHit = await page.evaluate(() => {
      const hits =
        (window as unknown as HookShape).__dtxmaniaTest?.game?.vrConfigHits ?? [];
      const gridStart = hits.findIndex((h, i, arr) => {
        if (h.w < 180 || h.w > 240) return false;
        const next4 = arr.slice(i, i + 4);
        if (next4.length < 4) return false;
        return (
          next4.every((c) => Math.abs(c.w - h.w) < 2) &&
          next4.every((c) => c.y === h.y)
        );
      });
      if (gridStart < 0) return null;
      // BD is the 6th lane (idx 5) in AUTO_PLAY_LANES.
      return hits[gridStart + 5] ?? null;
    });
    expect(bdHit, 'BD auto-play cell not found in vrConfigHits').not.toBeNull();
    const bd = bdHit!;

    // Sanity-check the auto-play row geometry the spec relies on —
    // a layout change that doubled cell height to 72 px would still
    // pick *some* hit at gridStart+5 but quietly stop hitting BD.
    expect(bd.h).toBe(36);

    // Pre-flight assertion: BD starts off. Without this a previous
    // run that happened to leave BD on (race against the localStorage
    // reset earlier in this test) would mask a no-op click.
    const bdBefore = await page.evaluate(
      (k) =>
        (JSON.parse(localStorage.getItem(k) ?? '{}') as {
          autoPlay?: { BD?: boolean };
        }).autoPlay?.BD ?? false,
      STORAGE_KEY,
    );
    expect(bdBefore).toBe(false);

    await aimRightAt(page, VR_CONFIG_PANEL, bd.x + bd.w / 2, bd.y + bd.h / 2);
    await page.waitForTimeout(50);
    await pulseTrigger(page, 'right');

    // Click toggles autoPlay.BD on. The persisted blob is the
    // observable side effect; this also implicitly verifies that the
    // shared `toggleAutoPlayLane` path the unit test covers ran for
    // real through raycast → hit dispatch → updateConfig.
    await expect
      .poll(
        () =>
          page.evaluate(
            (k) =>
              (JSON.parse(localStorage.getItem(k) ?? '{}') as {
                autoPlay?: { BD?: boolean };
              }).autoPlay?.BD ?? false,
            STORAGE_KEY,
          ),
        { timeout: 3_000 },
      )
      .toBe(true);

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
