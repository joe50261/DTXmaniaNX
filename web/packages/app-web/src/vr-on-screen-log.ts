import * as THREE from 'three';
import {
  formatLogEntry,
  getLog,
  LOG_LEVEL_COLOR,
  subscribeLog,
  type LogEntry,
} from './on-screen-log-model.js';

/**
 * In-VR on-screen log — floating panel pinned to the bottom-left of
 * the player's view so diagnostics are visible in-headset.
 *
 * Quest Browser has no DevTools, and the desktop `on-screen-log`
 * DOM panel is invisible inside an immersive WebXR session. A player
 * hunting a VR-only bug (input routing, session lifecycle, texture
 * load) previously had no way to see `console.log` without removing
 * the headset; this view fixes that.
 *
 * The visual is intentionally small and off to the side — screenshots
 * inside a headset are awkward so the log's long-term persistence
 * value is limited, but it's still useful for live diagnosis while
 * the player (or reviewer) is wearing the device. The panel is
 * gated behind a config toggle (`config.vrLogEnabled`) so players
 * who don't want clutter can keep it off.
 */

const PANEL_W_PX = 720;
const PANEL_H_PX = 360;
/** Narrow panel in the lower-left corner of view — big enough for
 * 20-ish rows of monospace text at the chosen font size. */
const PANEL_WORLD_W = 1.0;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(-0.9, 1.05, -1.3);

const VISIBLE_ROWS = 18;
const ROW_H = 17;
const FONT = '11px ui-monospace, monospace';

export class VrOnScreenLog {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  private shown = false;
  private unsubLog: (() => void) | null = null;
  private latest: readonly LogEntry[] = [];

  constructor(private readonly scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W_PX;
    this.canvas.height = PANEL_H_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('VrOnScreenLog: 2D context unavailable');
    this.ctx = c;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WORLD_W, PANEL_WORLD_H),
      mat
    );
    this.mesh.position.copy(PANEL_POS);
    this.mesh.visible = false;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.mesh.visible = true;
    if (!this.scene.children.includes(this.mesh)) this.scene.add(this.mesh);
    // Seed from the current ring buffer before the first paint —
    // `subscribeLog` doesn't replay, so without this the panel would
    // render blank on VR entry even if console lines were already
    // captured pre-session. The DOM view does the same in
    // `installOnScreenLog()`.
    this.latest = getLog();
    this.unsubLog = subscribeLog((entries) => {
      this.latest = entries;
      this.paint();
    });
    this.paint();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.mesh.visible = false;
    this.unsubLog?.();
    this.unsubLog = null;
  }

  dispose(): void {
    this.hide();
    this.scene.remove(this.mesh);
    this.texture.dispose();
  }

  private paint(): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10, 15, 24, 0.88)';
    ctx.fillRect(0, 0, PANEL_W_PX, PANEL_H_PX);

    ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, PANEL_W_PX - 1, PANEL_H_PX - 1);

    ctx.font = FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    const padX = 8;
    const padY = 6;
    const entries = this.latest.slice(-VISIBLE_ROWS);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      ctx.fillStyle = LOG_LEVEL_COLOR[entry.level];
      const text = formatLogEntry(entry);
      // Truncate to fit the panel width — monospace so a char-count
      // cap is a close-enough proxy for measureText.
      const maxChars = 96;
      const line = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
      ctx.fillText(line, padX, padY + i * ROW_H);
    }
    this.texture.needsUpdate = true;
  }
}
