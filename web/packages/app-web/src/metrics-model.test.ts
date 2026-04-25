/**
 * Tests for the metrics ring-buffer / EWMA logic. The view (DOM
 * badge) is a thin formatter and verified by hand on Cloudflare
 * preview; the math is what would silently rot if the FPS / blit
 * timing went off the rails.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMetricsForTesting,
  recordFrame,
  recordLayerBlit,
  recordPaint,
  setLayerStatus,
  setPaintMode,
  setPaintPending,
  snapshotMetrics,
} from './metrics-model.js';

beforeEach(() => {
  __resetMetricsForTesting();
});

describe('metrics-model', () => {
  it('fps is exactly the count of frames in the last 1000 ms window', () => {
    // Burst 10 frames at t=0..900 (every 100 ms).
    for (let i = 0; i < 10; i++) recordFrame(i * 100);
    // After the 10th frame at t=900, all 10 are still inside the
    // [900-1000, 900] = [-100, 900] window → all kept.
    expect(snapshotMetrics().fps).toBe(10);
  });

  it('drops old frames out of the fps window', () => {
    for (let i = 0; i < 5; i++) recordFrame(i * 100); // t=0..400
    recordFrame(2000); // 1.6 s after the last batch
    // Only the t=2000 frame is in [1000, 2000].
    expect(snapshotMetrics().fps).toBe(1);
  });

  it('worstFrameMs forgets frames older than the 1 s window', () => {
    recordFrame(0);
    recordFrame(50); // dt=50
    recordFrame(100); // dt=50
    recordFrame(2000); // dt=1900 — huge spike
    expect(snapshotMetrics().worstFrameMs).toBe(1900);
    recordFrame(3500); // dt=1500 < 1900 but the 1900 spike is now > 1 s old
    // Implementation: worstFrameMs replaces when dt > current OR the
    // current was sampled > 1 s ago. So the 1500 ms frame replaces.
    expect(snapshotMetrics().worstFrameMs).toBe(1500);
  });

  it('layer blits increment monotonically while active', () => {
    setLayerStatus(true, 1);
    recordLayerBlit(0.5);
    recordLayerBlit(0.7);
    expect(snapshotMetrics().layerBlits).toBe(2);
  });

  it('setLayerStatus(false, …) clears blit counters', () => {
    setLayerStatus(true, 1);
    recordLayerBlit(1.0);
    expect(snapshotMetrics().layerBlits).toBe(1);
    setLayerStatus(false, 0);
    expect(snapshotMetrics().layerBlits).toBe(0);
    expect(snapshotMetrics().layerBlitMs).toBe(0);
  });

  it('paint mode + ms snapshot reflects the latest writes', () => {
    setPaintMode('worker');
    recordPaint(2.5);
    setPaintPending(3);
    const s = snapshotMetrics();
    expect(s.paintMode).toBe('worker');
    expect(s.paintMs).toBeCloseTo(2.5, 5);
    expect(s.paintPending).toBe(3);
  });
});
