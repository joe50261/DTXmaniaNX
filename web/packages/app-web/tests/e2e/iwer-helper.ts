import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { BrowserContext } from '@playwright/test';

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
            installRuntime: () => void;
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
    device.installRuntime();
    (window as unknown as { __iwerDevice: typeof device }).__iwerDevice = device;
  });
}
