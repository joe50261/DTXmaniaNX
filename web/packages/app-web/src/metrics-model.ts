/**
 * Live performance + mode telemetry, shared between a desktop DOM
 * badge and (planned) an in-VR canvas readout. Built so reviewers
 * verifying a PR on Cloudflare Pages have actual numbers to look at
 * instead of just "the screen looks right".
 *
 * What we track:
 *   - **fps / frame ms / worst frame ms** — top-level "is the render
 *     loop healthy" signal. Worst-frame catches GC pauses that the
 *     EWMA average would smooth over.
 *   - **layer.active / panels / blits / blit ms** — verifies commit
 *     2's quad-layer code actually ran (vs falling back to the mesh
 *     path) and how long each blit takes. `blits` is a monotonic
 *     counter — if it's 0 after entering VR, the layer never engaged.
 *   - **paint.mode / ms / pending** — wired by commit 6 (HUD-paint
 *     worker) so reviewers can confirm the worker actually owns the
 *     canvas vs the main-thread fallback.
 *
 * Subscribers are notified at most once per `update tick` (we
 * coalesce per-frame writes into a single broadcast in the view).
 *
 * Numbers stay small + bounded: counters cap at Number.MAX_SAFE_INTEGER
 * and EWMAs use alpha=0.1 (a ~10-frame window at 60 Hz).
 */

const EWMA_ALPHA = 0.1;
const FPS_WINDOW_MS = 1000;

export type PaintMode = 'main' | 'worker';

export interface MetricsSnapshot {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  layerActive: boolean;
  layerPanels: number;
  layerBlits: number;
  layerBlitMs: number;
  paintMode: PaintMode;
  paintMs: number;
  paintPending: number;
}

interface MetricsState {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  worstFrameAtMs: number;
  lastFrameAtMs: number;
  /** Sliding window of frame timestamps (performance.now()) so fps
   * is exactly "frames in last 1000 ms". */
  frameTimes: number[];
  layerActive: boolean;
  layerPanels: number;
  layerBlits: number;
  layerBlitMs: number;
  paintMode: PaintMode;
  paintMs: number;
  paintPending: number;
}

const state: MetricsState = {
  fps: 0,
  frameMs: 0,
  worstFrameMs: 0,
  worstFrameAtMs: 0,
  lastFrameAtMs: 0,
  frameTimes: [],
  layerActive: false,
  layerPanels: 0,
  layerBlits: 0,
  layerBlitMs: 0,
  paintMode: 'main',
  paintMs: 0,
  paintPending: 0,
};

const listeners = new Set<(s: MetricsSnapshot) => void>();

export function subscribeMetrics(cb: (s: MetricsSnapshot) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function snapshotMetrics(): MetricsSnapshot {
  return {
    fps: state.fps,
    frameMs: state.frameMs,
    worstFrameMs: state.worstFrameMs,
    layerActive: state.layerActive,
    layerPanels: state.layerPanels,
    layerBlits: state.layerBlits,
    layerBlitMs: state.layerBlitMs,
    paintMode: state.paintMode,
    paintMs: state.paintMs,
    paintPending: state.paintPending,
  };
}

/**
 * Note: we deliberately do NOT broadcast on every frame — view code
 * polls or installs its own rAF. Per-frame `for (cb of listeners)`
 * is harmless at one DOM subscriber but would compound if more
 * surfaces subscribe later, and the eye can't tell 60 fps from 60.x
 * fps anyway.
 */
export function recordFrame(nowMs: number): void {
  if (state.lastFrameAtMs > 0) {
    const dt = nowMs - state.lastFrameAtMs;
    state.frameMs = state.frameMs === 0 ? dt : state.frameMs * (1 - EWMA_ALPHA) + dt * EWMA_ALPHA;
    if (dt > state.worstFrameMs || nowMs - state.worstFrameAtMs > FPS_WINDOW_MS) {
      state.worstFrameMs = dt;
      state.worstFrameAtMs = nowMs;
    }
  }
  state.lastFrameAtMs = nowMs;
  const cutoff = nowMs - FPS_WINDOW_MS;
  state.frameTimes.push(nowMs);
  while (state.frameTimes.length > 0 && state.frameTimes[0]! < cutoff) {
    state.frameTimes.shift();
  }
  state.fps = state.frameTimes.length;
}

export function recordLayerBlit(durationMs: number): void {
  state.layerBlits = (state.layerBlits + 1) % Number.MAX_SAFE_INTEGER;
  state.layerBlitMs =
    state.layerBlitMs === 0
      ? durationMs
      : state.layerBlitMs * (1 - EWMA_ALPHA) + durationMs * EWMA_ALPHA;
}

export function setLayerStatus(active: boolean, panels: number): void {
  state.layerActive = active;
  state.layerPanels = panels;
  if (!active) {
    // Reset blit counters when the layer path goes inactive so a
    // subsequent attach doesn't show stale numbers.
    state.layerBlits = 0;
    state.layerBlitMs = 0;
  }
}

export function setPaintMode(mode: PaintMode): void {
  state.paintMode = mode;
}

export function recordPaint(durationMs: number): void {
  state.paintMs =
    state.paintMs === 0
      ? durationMs
      : state.paintMs * (1 - EWMA_ALPHA) + durationMs * EWMA_ALPHA;
}

export function setPaintPending(count: number): void {
  state.paintPending = count;
}

/** Push a snapshot to all subscribers. Called by the view's own
 * polling loop, typically at 4–10 Hz. */
export function broadcastMetrics(): void {
  if (listeners.size === 0) return;
  const s = snapshotMetrics();
  for (const cb of listeners) cb(s);
}

/**
 * Reset every counter to its initial value. Test-only — production
 * code should never call this; the singleton is meant to live for
 * the page session.
 */
export function __resetMetricsForTesting(): void {
  state.fps = 0;
  state.frameMs = 0;
  state.worstFrameMs = 0;
  state.worstFrameAtMs = 0;
  state.lastFrameAtMs = 0;
  state.frameTimes.length = 0;
  state.layerActive = false;
  state.layerPanels = 0;
  state.layerBlits = 0;
  state.layerBlitMs = 0;
  state.paintMode = 'main';
  state.paintMs = 0;
  state.paintPending = 0;
}
