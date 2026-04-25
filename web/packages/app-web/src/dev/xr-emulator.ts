/**
 * Optional WebXR emulation runtime (IWER, by Meta) for desktop /
 * Cloudflare-preview verification of VR features.
 *
 * Why this exists: Quest Browser ships no DevTools, so the only way
 * to verify in-VR behaviour from a workstation is either to push +
 * sideload + open the headset, or to run the same WebXR-using code
 * inside an emulator on the desktop browser. IWER does the latter —
 * it installs an `XRDevice` on `navigator.xr` so any code that calls
 * `requestSession('immersive-vr', ...)` gets a fully synthetic
 * headset + controllers, complete with `XRWebGLBinding` and the
 * `'layers'` feature (via `webxr-layers-polyfill` which IWER bundles).
 *
 * Activation modes (URL `?xr-emu=` query):
 *   - `1` / present: install runtime ONLY (default). No global event
 *     listeners are added — the app's own UI keeps working unchanged
 *     and you can `Enter VR` to drive the emulated session. The
 *     `XRDevice` is exposed on `window.__xrEmu` for console-driven
 *     pose / controller manipulation.
 *   - `devui`: also install `@iwer/devui`, the React-based control
 *     panel that owns global mouse + keyboard for FPS-style head /
 *     controller manipulation. Caveat: DevUI hooks `document.keydown`,
 *     `window.mousedown` etc. inside its `InputLayer`, which races
 *     the app's own `[` / `]` / `\` practice-loop hotkeys. Use it
 *     when you need controller-button verification (menu / config /
 *     calibrate); skip it when you only need to enter the session
 *     to inspect the HUD panel.
 *   - `0` / `off`: opt out even when `pnpm dev` would have
 *     auto-installed (e.g. if a real HMD is plugged in afterwards).
 *
 * Auto-install: `vite dev` without a real `navigator.xr` falls into
 * the `1` mode automatically, since localhost dev nearly always
 * means "I'm coding, not playing a real session".
 *
 * Production protection: the whole module is loaded via dynamic
 * `import()` so the ~2 MB IWER + DevUI bundle is split into a
 * separate chunk and only fetched when a caller actually invokes
 * activation.
 */

interface InstallResult {
  /** True if IWER took over `navigator.xr` for this page. */
  installed: boolean;
  /** Reason string surfaced for logs / on-screen log. */
  reason: string;
  /** Whether the heavy DevUI panel was installed too. */
  withDevUI: boolean;
}

type ActivationMode = 'off' | 'runtime' | 'runtime+devui';

function parseMode(): ActivationMode {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const raw = params.get('xr-emu');
  if (raw === '0' || raw === 'off') return 'off';
  if (raw === 'devui') return 'runtime+devui';
  if (raw === '1' || raw === '' || params.has('xr-emu')) return 'runtime';
  // Auto-install in `vite dev` ONLY when there's no native XR runtime,
  // so plugged-in HMDs on the desk keep their real WebXR path.
  if (import.meta.env.DEV && !('xr' in navigator)) return 'runtime';
  return 'off';
}

/**
 * Decide whether to install IWER + DevUI based on URL params and env.
 * Safe to call before anything else touches `navigator.xr` — must run
 * synchronously enough that subsequent `requestSession` calls see the
 * polyfill, hence the `await` on the dynamic imports happens before
 * any app code runs (see `main.ts`).
 */
export async function maybeInstallXrEmulator(): Promise<InstallResult> {
  const mode = parseMode();
  if (mode === 'off') {
    return { installed: false, reason: 'not requested', withDevUI: false };
  }
  if ('xr' in navigator && !globalThis.location?.search.includes('xr-emu')) {
    // Hard guard: don't shadow a real WebXR runtime unless the
    // operator explicitly asked for the emulator via query string.
    return { installed: false, reason: 'native xr present', withDevUI: false };
  }

  try {
    const iwer = await import('iwer');
    const device = new iwer.XRDevice(iwer.metaQuest3);
    // `globalObject` is the target the polyfill mutates; `globalThis`
    // is correct for both browser and worker contexts. `polyfillLayers`
    // routes XRWebGLBinding / XRQuadLayer through `webxr-layers-polyfill`
    // so commit 2's composition-layer code path is exercised end-to-end.
    device.installRuntime({ globalObject: globalThis, polyfillLayers: true });
    // Stash for console-driven debugging — the user can poke
    // `window.__xrEmu.controllers.right.position.set(...)` etc.
    (globalThis as unknown as { __xrEmu: unknown }).__xrEmu = device;

    let withDevUI = false;
    if (mode === 'runtime+devui') {
      try {
        const devui = await import('@iwer/devui');
        device.installDevUI(devui.DevUI);
        withDevUI = true;
      } catch (devuiErr) {
        console.warn(
          '[xr-emu] DevUI failed to load — runtime is up but the panel ' +
            'is missing; programmatic control via window.__xrEmu still works.',
          devuiErr,
        );
      }
    } else {
      // Runtime-only path: install the lightweight in-page panel so
      // the operator at least has Trigger L / R + Recenter + head-Y
      // step buttons to drive menu / panel verification, without
      // DevUI's global event hijack.
      try {
        const { installMiniPanel } = await import('./xr-emu-panel.js');
        if (document.body) {
          installMiniPanel(device);
        } else {
          window.addEventListener('DOMContentLoaded', () => installMiniPanel(device), { once: true });
        }
      } catch (panelErr) {
        console.warn('[xr-emu] mini-panel failed to load', panelErr);
      }
    }

    console.info(
      `[xr-emu] IWER (Meta Quest 3) ready — mode=${mode}` +
        (withDevUI ? ' (+devui)' : ''),
    );
    return { installed: true, reason: mode, withDevUI };
  } catch (err) {
    console.warn('[xr-emu] IWER install failed', err);
    return { installed: false, reason: `error: ${String(err)}`, withDevUI: false };
  }
}

