import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Shared helpers for e2e specs that need a real WebXR runtime via Meta's
 * IWER (Immersive Web Emulation Runtime). Injects the UMD bundle + a
 * Quest-3-shaped device BEFORE the app boots, so `main.ts` sees a fully
 * spec-compliant `navigator.xr` and `game.enterXR()` can ride the real
 * three.js `WebXRManager.setSession` path.
 *
 * Also stashes a reference to the emulated device on
 * `window.__iwerDevice` so specs can script controller poses + button
 * presses without re-instantiating the runtime.
 */

const require_ = createRequire(import.meta.url);
const IWER_BUNDLE_PATH = require_.resolve('iwer/build/iwer.min.js');

/** IWER's internal short id for the trigger button. NOT the WebXR
 * Gamepad standard mapping name (`'xr-standard-trigger'`); IWER's
 * Meta Quest controller config uses its own short ids — see
 * `iwer/lib/device/configs/controller/meta.js`. Configured with
 * `eventTrigger: 'select'` so a press(1) → release(0) cycle fires
 * `selectstart → select → selectend` on the input source, which is
 * what `xr-controllers.ts` listens to for laser-ray clicks. */
const TRIGGER_BUTTON_ID = 'trigger';

/** Press duration for `pulseTrigger`. Long enough that IWER's
 * per-frame input-source pump definitely sees both the press and the
 * release across the same XR session, short enough that specs don't
 * pay it as wallclock cost when chained. */
const TRIGGER_PRESS_MS = 120;

let cachedBundle: string | null = null;
async function readIwerBundle(): Promise<string> {
  if (cachedBundle === null) cachedBundle = await readFile(IWER_BUNDLE_PATH, 'utf8');
  return cachedBundle;
}

/** Prepare `context` so every subsequent `page.goto` loads iwer + a
 * Meta-Quest-3 emulated device BEFORE any page script runs. Safe to
 * call once per test context. */
export async function installIwerRuntime(context: BrowserContext): Promise<void> {
  const bundle = await readIwerBundle();
  // Two separate init scripts so a syntax issue in our installer
  // surfaces with a clear stack instead of pretending iwer itself threw.
  await context.addInitScript(bundle);
  await context.addInitScript(() => {
    const iwer = (
      window as unknown as {
        IWER: {
          XRDevice: new (cfg: unknown) => {
            installRuntime: (opts?: {
              globalObject?: unknown;
              polyfillLayers?: boolean;
            }) => void;
            controllers: Record<
              'left' | 'right',
              | {
                  position: { set(x: number, y: number, z: number): unknown };
                  quaternion: { set(x: number, y: number, z: number, w: number): unknown };
                  updateButtonValue(id: string, v: number): void;
                  setButtonValueImmediate(id: string, v: number): void;
                  /** iwer's per-frame axis update — value lands on
                   * `inputSource.gamepad.axes` on the next pump. */
                  updateAxes(id: string, x: number, y: number): void;
                }
              | undefined
            >;
          };
          metaQuest3: unknown;
        };
      }
    ).IWER;
    const device = new iwer.XRDevice(iwer.metaQuest3);
    // `globalObject: globalThis` is the explicit polyfill target (also
    // the IWER default; making it explicit removes ambiguity if a
    // future spec runs the install in a worker / iframe context).
    // `polyfillLayers: true` routes XRWebGLBinding / XRQuadLayer
    // through `webxr-layers-polyfill` (already an iwer transitive
    // dep), so a future spec that exercises layer-promoted panels
    // works without re-touching this helper.
    device.installRuntime({ globalObject: globalThis, polyfillLayers: true });
    (window as unknown as { __iwerDevice: typeof device }).__iwerDevice = device;
  });
}

/** Fire a single trigger press-release pulse on the named hand,
 * waiting `TRIGGER_PRESS_MS` between press and release. Resolves
 * after the release. Use this in preference to manual
 * `setButtonValueImmediate(0)` / `setButtonValueImmediate(1)` pairs —
 * keeping press and release in one round-trip avoids inter-evaluate
 * gaps where the trigger sits at 1 indefinitely (which can re-fire
 * `select` on the next frame after the spec's first assertion). */
export async function pulseTrigger(page: Page, hand: 'left' | 'right'): Promise<void> {
  await page.evaluate(
    async ({ hand: h, holdMs, buttonId }) => {
      const device = (
        window as unknown as {
          __iwerDevice?: {
            controllers: Record<
              'left' | 'right',
              { setButtonValueImmediate(id: string, v: number): void } | undefined
            >;
          };
        }
      ).__iwerDevice;
      const c = device?.controllers[h];
      if (!c) throw new Error(`pulseTrigger: no ${h} controller on emulated device`);
      c.setButtonValueImmediate(buttonId, 1);
      await new Promise((r) => setTimeout(r, holdMs));
      c.setButtonValueImmediate(buttonId, 0);
    },
    { hand, holdMs: TRIGGER_PRESS_MS, buttonId: TRIGGER_BUTTON_ID },
  );
}

/** IWER's stick id on the Meta Quest controller config. Like
 * `'trigger'`, this is the IWER-internal short id (see
 * `iwer/lib/device/configs/controller/meta.js` — both x-axis and
 * y-axis axes share `id: 'thumbstick'`). The WebXR Gamepad standard
 * exposes the stick on `gamepad.axes[2]`/`[3]`, which is what the
 * app reads. */
const THUMBSTICK_ID = 'thumbstick';

/** Set the named controller's thumbstick to (x, y). x ∈ [-1, 1]
 * left↔right, y ∈ [-1, 1] up↔down (DTXmania convention: +y = focus
 * down, -y = focus up; matches Quest's stock orientation). The
 * value lands on `inputSource.gamepad.axes` on the next iwer pump,
 * which the app's tick reads via `axes[2]/[3]`. Schmitt-trigger
 * latching in `song-select-input.ts:stepStickAxis` means a single
 * call fires AT MOST one `moveFocus`/`cycleDifficulty` event per
 * direction — to fire again, release first via `releaseStick`. */
export async function setStickAxes(
  page: Page,
  hand: 'left' | 'right',
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ({ hand: h, x: xv, y: yv, id }) => {
      const device = (
        window as unknown as {
          __iwerDevice?: {
            controllers: Record<
              'left' | 'right',
              { updateAxes(id: string, x: number, y: number): void } | undefined
            >;
          };
        }
      ).__iwerDevice;
      const c = device?.controllers[h];
      if (!c) throw new Error(`setStickAxes: no ${h} controller`);
      c.updateAxes(id, xv, yv);
    },
    { hand, x, y, id: THUMBSTICK_ID },
  );
}

/** Convenience: zero the stick so the next push fires a fresh edge.
 * Equivalent to `setStickAxes(page, hand, 0, 0)`. */
export async function releaseStick(page: Page, hand: 'left' | 'right'): Promise<void> {
  await setStickAxes(page, hand, 0, 0);
}

/** Set the named controller's pose directly. Useful for laser-aim
 * specs that need the ray to start from a known origin pointing at
 * a known panel coordinate. The default IWER Quest 3 pose puts the
 * controllers near the player's chest aiming forward; for tests
 * that need to hit a specific panel, call this with the desired
 * `(x, y, z)` (world metres) and orientation quaternion. */
export async function setControllerPose(
  page: Page,
  hand: 'left' | 'right',
  pos: { x: number; y: number; z: number },
  quat: { x: number; y: number; z: number; w: number },
): Promise<void> {
  await page.evaluate(
    ({ hand: h, pos: p, quat: q }) => {
      const device = (
        window as unknown as {
          __iwerDevice?: {
            controllers: Record<
              'left' | 'right',
              | {
                  position: { set(x: number, y: number, z: number): unknown };
                  quaternion: { set(x: number, y: number, z: number, w: number): unknown };
                }
              | undefined
            >;
          };
        }
      ).__iwerDevice;
      const c = device?.controllers[h];
      if (!c) throw new Error(`setControllerPose: no ${h} controller`);
      c.position.set(p.x, p.y, p.z);
      c.quaternion.set(q.x, q.y, q.z, q.w);
    },
    { hand, pos, quat },
  );
}

/** Identity quaternion — controller pointing along its local -Z
 * axis, i.e. straight forward in world space if the controller
 * sits at the origin. Convenient default for laser specs. */
export const QUAT_IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** Geometry of a flat panel mesh facing +Z (the layout used by
 * song-select and vr-config). Pixels are panel-local with origin at
 * top-left; world is metres with origin at panel CENTRE. The
 * conversion mirrors the panel's tick code:
 *   px = uv.x * pixelW
 *   py = (1 - uv.y) * pixelH
 * so a pixel near (0,0) sits near (worldPos.x - worldW/2,
 * worldPos.y + worldH/2) and a pixel near (pixelW, pixelH) sits at
 * (worldPos.x + worldW/2, worldPos.y - worldH/2). */
export interface PanelGeometry {
  worldPos: { x: number; y: number; z: number };
  worldW: number;
  worldH: number;
  pixelW: number;
  pixelH: number;
}

/** Convert a panel-pixel point to a world-space coordinate. The
 * z-coordinate is the panel face (mesh sits flush against this z).
 * Use the result with `setControllerPose(... QUAT_IDENTITY ...)` and
 * an origin offset of +0.5 m on z to fire a forward-pointing ray
 * that strikes the requested pixel. */
export function panelPixelToWorld(
  panel: PanelGeometry,
  px: number,
  py: number,
): { x: number; y: number; z: number } {
  const ux = px / panel.pixelW;
  const uy = 1 - py / panel.pixelH;
  return {
    x: panel.worldPos.x + (ux - 0.5) * panel.worldW,
    y: panel.worldPos.y + (uy - 0.5) * panel.worldH,
    z: panel.worldPos.z,
  };
}
