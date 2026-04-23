/**
 * Mid-play toast feedback shared between desktop and VR.
 *
 * DOM overlays are invisible inside an immersive WebXR session, so the
 * toast state lives in a module-level singleton and is painted onto
 * the shared HUD canvas from `Renderer.paintHud()`. Because the HUD
 * canvas is both the desktop ortho quad AND the VR floating panel,
 * both paths get the toast for free.
 *
 * Writers (hotkey handlers in `main.ts`, in-VR feedback sources) call
 * `showToast`. The renderer's state builder in `Game` calls
 * `activeToast(now)` each frame and puts the result into `RenderState`.
 * Expired toasts auto-clear on the next read so callers don't need a
 * timer.
 */
export interface Toast {
  text: string;
  /** performance.now() timestamp at which the toast should vanish. */
  expiresAtMs: number;
}

let current: Toast | null = null;

/** Post a toast. If one is already showing, it is replaced (the new
 * message is what the player most recently acted on). */
export function showToast(text: string, durationMs = 1800, nowMs = performance.now()): void {
  current = { text, expiresAtMs: nowMs + durationMs };
}

/** Read the active toast, auto-clearing when expired. `nowMs` is passed
 * explicitly so tests can control time; production callers use the
 * default. */
export function activeToast(nowMs = performance.now()): Toast | null {
  if (current === null) return null;
  if (nowMs >= current.expiresAtMs) {
    current = null;
    return null;
  }
  return current;
}

/** Test-only: drop the current toast without waiting for expiry. */
export function clearToast(): void {
  current = null;
}
