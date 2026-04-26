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
