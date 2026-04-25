/**
 * Top-right corner DOM badge that surfaces live metrics from
 * `metrics-model.ts`. Sized small enough to not cover the HUD score
 * (which lives at the playfield's right edge inside the WebGL
 * canvas), pinned via `position: fixed` so it survives the WebGL
 * canvas being resized.
 *
 * Why DOM and not the HUD canvas: telemetry needs to be visible
 * BEFORE the player enters VR, including during loading / config
 * states where the HUD canvas isn't even being painted. After they
 * enter a real Quest session DOM overlays disappear, but desktop /
 * IWER preview reviews are exactly where this is most useful — and
 * an in-VR canvas readout is a cheap follow-up using the same model.
 */
import {
  broadcastMetrics,
  snapshotMetrics,
  subscribeMetrics,
  type MetricsSnapshot,
} from './metrics-model.js';

const PANEL_ID = 'metrics-badge';

export function installMetricsBadge(): void {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    width: '170px',
    padding: '6px 8px',
    background: 'rgba(15, 23, 42, 0.85)',
    color: '#e5e7eb',
    border: '1px solid rgba(80, 120, 255, 0.4)',
    borderRadius: '5px',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '10px',
    lineHeight: '1.4',
    zIndex: '9000',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'pre',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(panel);

  const render = (s: MetricsSnapshot): void => {
    panel.textContent = formatSnapshot(s);
  };
  subscribeMetrics(render);
  render(snapshotMetrics());

  // Drive the broadcast at ~5 Hz — fast enough that fps changes
  // feel live, slow enough to not flood layout work. The renderer
  // updates the model every frame, this loop only flushes.
  const tick = (): void => {
    broadcastMetrics();
    setTimeout(tick, 200);
  };
  tick();
}

function formatSnapshot(s: MetricsSnapshot): string {
  const layerLine = s.layerActive
    ? `layer: ${s.layerPanels}p · ${s.layerBlits}× · ${s.layerBlitMs.toFixed(2)}ms`
    : 'layer: mesh-fallback';
  return [
    `fps: ${s.fps}  Δ${s.frameMs.toFixed(1)}ms  worst ${s.worstFrameMs.toFixed(1)}`,
    layerLine,
    `paint: ${s.paintMode}  ${s.paintMs.toFixed(2)}ms  q${s.paintPending}`,
  ].join('\n');
}
