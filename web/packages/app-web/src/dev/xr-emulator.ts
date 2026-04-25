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
 * Operability is provided by `@iwer/devui`, a small React panel that
 * docks into the page corner — drag the head, click controller
 * triggers, etc. without leaving the browser. The panel is rendered
 * as a sibling DOM overlay, so it doesn't interfere with the WebGL
 * canvas or our HUD.
 *
 * Activation:
 *   - Auto-on in `vite dev` when no native `navigator.xr` is present
 *     (i.e. you're on a normal desktop Chrome without an HMD plugged
 *     in). This keeps `pnpm dev` workflows productive by default.
 *   - Manual opt-in anywhere via the `?xr-emu=1` query param. Works
 *     on the Cloudflare Pages preview build, which is the canonical
 *     verification target for in-PR feature reviews.
 *
 * Production protection:
 *   - The whole module is loaded via dynamic `import()` so the
 *     ~2 MB IWER + DevUI bundle is split into a separate chunk and
 *     only fetched when a caller actually invokes activation.
 */

interface InstallResult {
  /** True if IWER took over `navigator.xr` for this page. */
  installed: boolean;
  /** Reason string surfaced for logs / on-screen log. */
  reason: string;
}

/**
 * Decide whether to install IWER + DevUI based on URL params and env.
 * Safe to call before anything else touches `navigator.xr` — must run
 * synchronously enough that subsequent `requestSession` calls see the
 * polyfill, hence the `await` on the dynamic imports happens before
 * any app code runs (see `main.ts`).
 */
export async function maybeInstallXrEmulator(): Promise<InstallResult> {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const queryOptIn = params.get('xr-emu') === '1' || params.has('xr-emu');
  const queryOptOut = params.get('xr-emu') === '0';
  // Auto-install in `vite dev` ONLY when there's no native XR runtime,
  // so plugged-in HMDs on the desk keep their real WebXR path.
  const devAuto =
    import.meta.env.DEV && !queryOptOut && !('xr' in navigator);
  if (!queryOptIn && !devAuto) {
    return { installed: false, reason: 'not requested' };
  }
  if ('xr' in navigator && !queryOptIn) {
    // Hard guard: don't shadow a real WebXR runtime unless the
    // operator explicitly asked for the emulator.
    return { installed: false, reason: 'native xr present' };
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

    try {
      const devui = await import('@iwer/devui');
      device.installDevUI(devui.DevUI);
    } catch (devuiErr) {
      console.warn(
        '[xr-emu] DevUI failed to load — runtime is up but the panel ' +
          'is missing; programmatic control via window.__xrEmu still works.',
        devuiErr,
      );
    }

    const reason = queryOptIn
      ? 'opted-in via ?xr-emu'
      : 'auto-installed (vite dev, no native xr)';
    console.info(`[xr-emu] IWER (Meta Quest 3) ready — ${reason}`);
    return { installed: true, reason };
  } catch (err) {
    console.warn('[xr-emu] IWER install failed', err);
    return { installed: false, reason: `error: ${String(err)}` };
  }
}
