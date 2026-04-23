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

const PANEL_W_PX = 960;
const PANEL_H_PX = 480;
/** Wider-and-taller panel in the lower-left of view — fits longer
 * diagnostic lines (e.g. the haptic dump `{"slotIdx":1,"hand":"right",
 * "result":"preempted"}` overflowed the old 720-wide panel and got
 * clipped at the key field names). Word-wrapping takes care of the
 * remainder. */
const PANEL_WORLD_W = 1.4;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(-0.9, 1.05, -1.3);

const VISIBLE_ROWS = 24;
const ROW_H = 17;
const FONT = '11px ui-monospace, monospace';
/** Char width in the 11px monospace font we use. Empirical; Chromium
 * and Quest Browser both render the ui-monospace glyphs at ≈6.6 px. */
const CHAR_W_PX = 6.6;

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

  /** Test-only — the last set of entries the panel would render. Used
   * by `vr-on-screen-log.test.ts` to guard the show()-time seed, the
   * subtle bug fixed in `a3fac0f` where `show()` called `paint()` with
   * `latest` still at the initial `[]` and thus rendered blank on
   * first reveal if console output had already accumulated. */
  peekForTest(): readonly LogEntry[] {
    return this.latest;
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
    // Word-wrap rather than truncate: diagnostic entries like the
    // haptic dump carry key=value pairs at the tail, and clipping
    // those hides the answer the player is reading the log to find.
    // We wrap by char-count (monospace font so each glyph is a fixed
    // CHAR_W_PX) and render the newest entries first so the latest
    // line is always on screen even when a single entry spans 3 rows.
    const maxCharsPerRow = Math.floor((PANEL_W_PX - padX * 2) / CHAR_W_PX);
    const rows: Array<{ text: string; color: string }> = [];
    for (const entry of this.latest) {
      const color = LOG_LEVEL_COLOR[entry.level];
      const text = formatLogEntry(entry);
      for (let off = 0; off < text.length; off += maxCharsPerRow) {
        rows.push({
          text: text.slice(off, off + maxCharsPerRow),
          color,
        });
      }
    }
    const visible = rows.slice(-VISIBLE_ROWS);
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i]!;
      ctx.fillStyle = row.color;
      ctx.fillText(row.text, padX, padY + i * ROW_H);
    }
    this.texture.needsUpdate = true;
  }
}
