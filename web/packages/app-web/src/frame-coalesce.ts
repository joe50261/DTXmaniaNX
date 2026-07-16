/**
 * Pure scheduling helper: coalesces a burst of trigger calls into a
 * single `fn` run on the next scheduler tick.
 *
 * Written for the renderer's ResizeObserver → WebGL-backbuffer-resize
 * path. Resizing the drawing buffer inside the observer callback
 * mutates the observed canvas's layout in the same frame, which the
 * browser reports as "ResizeObserver loop completed with undelivered
 * notifications" — a window.onerror that spams the on-screen log.
 * Deferring the actual resize to the next animation frame breaks the
 * same-cycle feedback loop; coalescing keeps a drag-resize from
 * queueing one resize per observer firing.
 */
export function coalesceToFrame(
  schedule: (cb: () => void) => void,
  fn: () => void
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      fn();
    });
  };
}
