import * as THREE from 'three';
import {
  AUTO_PLAY_LANES,
  getConfig,
  subscribe,
  toggleAutoPlayLane,
  updateConfig,
  type AutoPlayMap,
  type Config,
} from './config.js';

/**
 * In-VR settings panel — the VR-path counterpart of `config-panel.ts`.
 *
 * Settings state already lives in a pure `config.ts` model (getConfig /
 * updateConfig / subscribe), so this class just draws a floating canvas
 * panel and wires its laser-picked buttons straight to `updateConfig`.
 * Both panels update the same config blob — toggling a setting in VR
 * takes effect immediately on the desktop DOM panel too, and vice
 * versa.
 *
 * VR has no keyboard or drag handles, so every adjustable is mapped to
 * either a toggle button (on / off) or a pair of `−` / `+` step
 * buttons. That's less granular than a drag slider but enough for the
 * MVP — the settings the DOM panel exposes through free-form inputs
 * (MIDI port select, numeric measure indices) are intentionally
 * omitted here; players who need them can remove the headset.
 */

const PANEL_W_PX = 1024;
// 1024×1120 (world ≈1.6m × 1.75m) fits Audio + Gameplay + Auto-play
// (11-lane grid) + Practice + Diagnostics without overflow. The
// previous 1024×768 clipped the last section and left no room for the
// auto-play toggles; players reported having to leave VR to enable
// auto-kick.
const PANEL_H_PX = 1120;
const PANEL_WORLD_W = 1.6;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(0, 1.55, -1.5);

const ROW_H = 44;
const SECTION_GAP = 12;
const SECTION_TITLE_H = 32;
const STEP_W = 56;
const STEP_H = 36;
const TOGGLE_W = 100;

/** Footer strip where the "Back" button + hint text live. Everything
 * above must fit in `PANEL_H_PX - FOOTER_H` so content doesn't hide
 * behind the footer. */
const FOOTER_H = 90;
const FOOTER_TOP = PANEL_H_PX - FOOTER_H;

/** Exported layout so the "Back button doesn't sit on top of the hint
 * text" invariant and the "content never overflows into the footer
 * strip" invariant can be asserted independently of the canvas paint.
 * Mirrors VR_MENU_FOOTER's role for the song-picker panel. */
export const VR_CONFIG_LAYOUT = Object.freeze({
  PANEL_W_PX,
  PANEL_H_PX,
  ROW_H,
  SECTION_GAP,
  SECTION_TITLE_H,
  FOOTER_H,
  FOOTER_TOP,
  BACK_BTN_W: 220,
  BACK_BTN_H: 40,
  /** 13px text with hints on lines 1 and 2 of the footer strip. */
  HINT_LINE_1_Y: FOOTER_TOP + 22,
  HINT_LINE_2_Y: FOOTER_TOP + 42,
});

/** Friendly names for auto-play lane toggles. The DOM panel shows the
 * raw lane codes (HH, SD, BD, …) which assumes the player already knows
 * DTXmania's lane abbreviations; the VR panel spells them out because
 * there's no tooltip / manual to fall back on inside the headset.
 * Exported for the unit-test spec so label drift (e.g. rename "Bass
 * (Kick)" → "Kick") stays a one-place change. */
export const AUTO_PLAY_LABELS: Readonly<Record<keyof AutoPlayMap, string>> =
  Object.freeze({
    LC: 'L.Crash',
    HH: 'Hi-Hat',
    LP: 'L.Pedal',
    SD: 'Snare',
    HT: 'Hi Tom',
    BD: 'Bass (Kick)',
    LT: 'Low Tom',
    FT: 'Floor Tom',
    CY: 'Crash',
    RD: 'Ride',
    LBD: 'Left Bass',
  });

/** Footer hint strings, exported so geometry tests can compute their
 * expected widths from `.length` instead of hand-estimating character
 * counts. Kept here (not inside paintFooter) so any edit to the
 * wording automatically re-runs the geometry invariants. */
export const VR_CONFIG_FOOTER_HINTS = Object.freeze({
  line1:
    'Hit the − / + buttons to step a slider. Toggles flip on click. Changes persist instantly.',
  line2:
    'Loop A / B capture lives on the right controller face buttons during play.',
});

interface ButtonHit {
  x: number;
  y: number;
  w: number;
  h: number;
  action: () => void;
}

export class VrConfig {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  /** One laser per controller, attached once in the constructor and
   * toggled visible/invisible on show/hide. Re-creating them on every
   * show() and never removing them was leaking Three.js Line children
   * and event listeners onto the long-lived XR controller objects
   * (`webgl.xr.getController` returns the same Group every call). */
  private readonly lasers: THREE.Line[] = [];
  private readonly controllers: THREE.Group[] = [];
  // Three.js event types (Object3DEventMap) don't know about the
  // WebXR 'connected'/'disconnected' events; handlers are passed
  // through the string-overload of addEventListener and typed loosely
  // here so removeEventListener sees the same signature.
  private readonly onConnectedHandlers: Array<(event: unknown) => void> = [];
  private readonly onDisconnectedHandlers: Array<() => void> = [];
  private readonly inputSources: (XRInputSource | null)[] = [null, null];
  private readonly wasPressed: boolean[] = [false, false];
  private readonly raycaster = new THREE.Raycaster();

  private shown = false;
  private onClose: (() => void) | null = null;
  private hits: ButtonHit[] = [];
  private hoveredIdx = -1;
  /** Coalesce paint calls within a single tick. A trigger-click inside
   * `tick()` runs the button's `action()` → `updateConfig()` → the
   * subscribe listener, hover-change, and the explicit post-action
   * paint — without this flag, one frame could upload the CanvasTexture
   * 2–3 times. Matches VrCalibrate's pattern. */
  private dirty = true;

  private unsubConfig: (() => void) | null = null;

  constructor(
    private readonly webgl: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W_PX;
    this.canvas.height = PANEL_H_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('VrConfig: 2D context unavailable');
    this.ctx = c;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WORLD_W, PANEL_WORLD_H), mat);
    this.mesh.position.copy(PANEL_POS);
    this.mesh.visible = false;
    this.scene.add(this.mesh);

    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const idx = i;
      const onConnected = (event: unknown): void => {
        const data = (event as { data?: XRInputSource }).data;
        if (data) this.inputSources[idx] = data;
      };
      const onDisconnected = (): void => {
        this.inputSources[idx] = null;
      };
      controller.addEventListener('connected', onConnected);
      controller.addEventListener('disconnected', onDisconnected);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -2.5),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffeb3b, transparent: true, opacity: 0.7 })
      );
      line.visible = false;
      controller.add(line);
      // scene.add is idempotent; XrControllers may also add the same
      // controller when its drum kit starts. We don't scene.remove on
      // hide/dispose because XrControllers owns the controller lifetime.
      this.scene.add(controller);
      this.controllers.push(controller);
      this.lasers.push(line);
      this.onConnectedHandlers.push(onConnected);
      this.onDisconnectedHandlers.push(onDisconnected);
    }
  }

  show(onClose: () => void): void {
    this.onClose = onClose;
    this.shown = true;
    this.mesh.visible = true;
    for (const l of this.lasers) l.visible = true;
    // Repaint on any config change (hotkey-driven loop capture, desktop
    // DOM panel touching the same settings, etc.). Flag dirty; the next
    // tick coalesces into a single paint even if multiple state changes
    // fire back-to-back. Unsubscribed in hide.
    this.unsubConfig = subscribe(() => {
      if (this.shown) this.dirty = true;
    });
    this.dirty = true;
    this.paint();
  }

  /** Test-only: trigger the action of whichever button's hit-rect
   * contains (px, py) on the panel canvas. Returns true when a rect
   * was matched. This is what `tick()` does on a trigger-press once
   * the laser-ray hit point is projected into panel UV space; exposing
   * it directly lets vitest drive click behaviour without building a
   * whole XR raycaster + XRSession pose fixture. */
  __testClickAt(px: number, py: number): boolean {
    for (const h of this.hits) {
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
        h.action();
        return true;
      }
    }
    return false;
  }

  /** Test-only: snapshot of the current button hit-rects for assertion.
   * Length varies with which sections `paint()` rendered this frame
   * (e.g. `paintLoopRange` adds no hits on a valid range). */
  __testHits(): ReadonlyArray<{ x: number; y: number; w: number; h: number }> {
    return this.hits.map(({ x, y, w, h }) => ({ x, y, w, h }));
  }

  hide(): void {
    this.shown = false;
    this.mesh.visible = false;
    for (const l of this.lasers) l.visible = false;
    this.unsubConfig?.();
    this.unsubConfig = null;
    this.onClose = null;
  }

  dispose(): void {
    this.hide();
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i]!;
      c.removeEventListener('connected', this.onConnectedHandlers[i]!);
      c.removeEventListener('disconnected', this.onDisconnectedHandlers[i]!);
      c.remove(this.lasers[i]!);
    }
    for (const l of this.lasers) {
      l.geometry.dispose();
      if (Array.isArray(l.material)) l.material.forEach((m) => m.dispose());
      else l.material.dispose();
    }
    this.scene.remove(this.mesh);
    this.lasers.length = 0;
    this.controllers.length = 0;
    this.onConnectedHandlers.length = 0;
    this.onDisconnectedHandlers.length = 0;
    this.texture.dispose();
  }

  tick(): void {
    if (!this.shown) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    let hovered = -1;
    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3(0, 0, -1);
      controller.getWorldPosition(origin);
      direction.applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
      this.raycaster.set(origin, direction);
      const rayHits = this.raycaster.intersectObject(this.mesh, false);
      let hitIdx = -1;
      if (rayHits.length > 0) {
        const uv = rayHits[0]!.uv;
        if (uv) {
          const px = uv.x * PANEL_W_PX;
          const py = (1 - uv.y) * PANEL_H_PX;
          hitIdx = this.hits.findIndex(
            (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h
          );
          if (hitIdx >= 0 && hovered === -1) hovered = hitIdx;
        }
      }
      const src = this.inputSources[i];
      const pressed = src?.gamepad?.buttons[0]?.pressed ?? false;
      if (pressed && !this.wasPressed[i] && hitIdx >= 0) {
        // action() often calls updateConfig(), whose subscribe listener
        // sets this.dirty — so a single paint at tick's tail covers it.
        this.hits[hitIdx]!.action();
        this.dirty = true;
      }
      this.wasPressed[i] = pressed;
    }

    if (hovered !== this.hoveredIdx) {
      this.hoveredIdx = hovered;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.paint();
    }
  }

  private paint(): void {
    const ctx = this.ctx;
    this.hits = [];

    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(0, 0, PANEL_W_PX, PANEL_H_PX);

    // Header
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Settings', PANEL_W_PX / 2, 52);

    const cfg = getConfig();
    let y = 84;

    y = this.paintSection('Audio', y);
    y = this.paintSlider(y, 'BGM volume', cfg.volumeBgm, 0, 1, 0.05, 2, (v) =>
      updateConfig({ volumeBgm: v })
    );
    y = this.paintSlider(y, 'Drums volume', cfg.volumeDrums, 0, 1, 0.05, 2, (v) =>
      updateConfig({ volumeDrums: v })
    );
    y = this.paintSlider(y, 'Preview volume', cfg.volumePreview, 0, 1, 0.05, 2, (v) =>
      updateConfig({ volumePreview: v })
    );

    y += SECTION_GAP;
    y = this.paintSection('Gameplay', y);
    y = this.paintSlider(y, 'Scroll speed', cfg.scrollSpeed, 0.3, 1.5, 0.05, 2, (v) =>
      updateConfig({ scrollSpeed: v })
    );
    y = this.paintSlider(
      y,
      'Judgment line Y',
      cfg.judgeLineY,
      450,
      620,
      5,
      0,
      (v) => updateConfig({ judgeLineY: v }),
      (v) => `${Math.round(v)} px`
    );
    y = this.paintToggle(y, 'Reverse scroll (chips rise)', cfg.reverseScroll, (v) =>
      updateConfig({ reverseScroll: v })
    );
    y = this.paintToggle(y, 'FAST / SLOW indicator', cfg.showFastSlow, (v) =>
      updateConfig({ showFastSlow: v })
    );

    y += SECTION_GAP;
    y = this.paintSection('Auto-play (per lane)', y);
    y = this.paintAutoPlayGrid(y, cfg.autoPlay);

    y += SECTION_GAP;
    y = this.paintSection('Practice', y);
    y = this.paintSlider(
      y,
      'Playback speed',
      cfg.practiceRate,
      0.25,
      2.0,
      0.05,
      2,
      (v) => updateConfig({ practiceRate: v }),
      (v) => `${v.toFixed(2)}×`
    );
    y = this.paintToggle(y, 'Preserve pitch', cfg.preservePitch, (v) =>
      updateConfig({ preservePitch: v })
    );
    y = this.paintToggle(y, 'A–B loop', cfg.practiceLoopEnabled, (v) =>
      updateConfig({ practiceLoopEnabled: v })
    );
    // Loop range readout (capture still happens via right-controller
    // face buttons — no in-panel capture to avoid ambiguity about
    // which song-time to snap when the menu/settings is open).
    y = this.paintLoopRange(y, cfg);

    y += SECTION_GAP;
    y = this.paintSection('Diagnostics', y);
    y = this.paintToggle(y, 'In-VR console log', cfg.vrLogEnabled, (v) =>
      updateConfig({ vrLogEnabled: v })
    );

    // Footer strip — sits below the content region at a fixed Y so its
    // back button + hints don't overlap whatever the last section paints.
    this.paintFooter();

    this.texture.needsUpdate = true;
  }

  private paintFooter(): void {
    const ctx = this.ctx;
    // Divider above the footer so the back button reads as its own strip.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, FOOTER_TOP);
    ctx.lineTo(PANEL_W_PX - 40, FOOTER_TOP);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(VR_CONFIG_FOOTER_HINTS.line1, 40, FOOTER_TOP + 22);
    ctx.fillText(VR_CONFIG_FOOTER_HINTS.line2, 40, FOOTER_TOP + 42);

    this.drawBack();
  }

  private paintSection(title: string, y: number): number {
    const ctx = this.ctx;
    ctx.fillStyle = '#22d3ee';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(title, 40, y + 22);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, y + 30);
    ctx.lineTo(PANEL_W_PX - 40, y + 30);
    ctx.stroke();
    return y + SECTION_TITLE_H;
  }

  private paintSlider(
    y: number,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    digits: number,
    apply: (v: number) => void,
    formatter?: (v: number) => string
  ): number {
    const ctx = this.ctx;
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '15px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, 60, y + 28);

    const valueText = formatter ? formatter(value) : value.toFixed(digits);
    const valX = PANEL_W_PX - 40 - STEP_W - 16 - 80;
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(valueText, valX + 40, y + 28);

    const minusX = valX - STEP_W - 10;
    const plusX = PANEL_W_PX - 40 - STEP_W;
    const btnY = y + (ROW_H - STEP_H) / 2;
    this.drawStepButton('−', minusX, btnY, STEP_W, STEP_H, () =>
      apply(clamp(roundToStep(value - step, step), min, max))
    );
    this.drawStepButton('+', plusX, btnY, STEP_W, STEP_H, () =>
      apply(clamp(roundToStep(value + step, step), min, max))
    );
    return y + ROW_H;
  }

  private paintToggle(
    y: number,
    label: string,
    value: boolean,
    apply: (v: boolean) => void
  ): number {
    const ctx = this.ctx;
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '15px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, 60, y + 28);

    const btnX = PANEL_W_PX - 40 - TOGGLE_W;
    const btnY = y + (ROW_H - STEP_H) / 2;
    const idx = this.hits.length;
    ctx.fillStyle = value ? '#16a34a' : '#475569';
    ctx.fillRect(btnX, btnY, TOGGLE_W, STEP_H);
    ctx.strokeStyle =
      this.hoveredIdx === idx ? '#fbbf24' : value ? '#22c55e' : '#64748b';
    ctx.lineWidth = 2;
    ctx.strokeRect(btnX + 1, btnY + 1, TOGGLE_W - 2, STEP_H - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(value ? 'ON' : 'OFF', btnX + TOGGLE_W / 2, btnY + STEP_H / 2 + 5);
    this.hits.push({
      x: btnX,
      y: btnY,
      w: TOGGLE_W,
      h: STEP_H,
      action: () => apply(!value),
    });
    return y + ROW_H;
  }

  /** Per-lane auto-play grid — mirrors the DOM panel's "Auto-play (by
   * lane)" section. Each cell is a labelled toggle (full lane name +
   * short code) so players don't need to memorise DTXmania's
   * abbreviations. 4-column layout so all 11 lanes fit in 3 rows.
   * "Auto-kick" = BD + LBD both on, which is the most common use of
   * this feature. */
  private paintAutoPlayGrid(y: number, map: AutoPlayMap): number {
    const ctx = this.ctx;
    const cols = 4;
    const cellGap = 8;
    const gridLeft = 60;
    const gridRight = PANEL_W_PX - 40;
    const cellW = Math.floor((gridRight - gridLeft - cellGap * (cols - 1)) / cols);
    const cellH = 36;
    const rows = Math.ceil(AUTO_PLAY_LANES.length / cols);

    for (let i = 0; i < AUTO_PLAY_LANES.length; i++) {
      const lane = AUTO_PLAY_LANES[i]!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = gridLeft + col * (cellW + cellGap);
      const cy = y + row * (cellH + cellGap);
      const value = map[lane];
      const idx = this.hits.length;
      ctx.fillStyle = value ? '#16a34a' : '#1e293b';
      ctx.fillRect(cx, cy, cellW, cellH);
      ctx.strokeStyle =
        this.hoveredIdx === idx ? '#fbbf24' : value ? '#22c55e' : '#475569';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx + 1, cy + 1, cellW - 2, cellH - 2);
      // Two-line label: full name (big) + short code (muted). The short
      // code matches the DOM panel's abbreviations so players who know
      // them aren't relearning the mapping.
      ctx.fillStyle = '#f1f5f9';
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(AUTO_PLAY_LABELS[lane], cx + 10, cy + 16);
      ctx.fillStyle = value ? '#dcfce7' : '#94a3b8';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`${lane} · ${value ? 'ON' : 'OFF'}`, cx + 10, cy + 30);
      this.hits.push({
        x: cx,
        y: cy,
        w: cellW,
        h: cellH,
        action: () =>
          updateConfig({ autoPlay: toggleAutoPlayLane(map, lane) }),
      });
    }
    // Hint line under the grid: quick "kick only" shortcut explanation
    // so players who only want auto-kick (the common case) know which
    // two cells to tap.
    const gridBottom = y + rows * cellH + (rows - 1) * cellGap;
    ctx.fillStyle = '#64748b';
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      'Classic "auto-kick": enable Bass (BD) + Left Bass (LBD).',
      60,
      gridBottom + 16
    );
    return gridBottom + 24;
  }

  private paintLoopRange(y: number, cfg: Config): number {
    const ctx = this.ctx;
    ctx.fillStyle = '#64748b';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    const start = cfg.practiceLoopStartMeasure;
    const end =
      cfg.practiceLoopEndMeasure === null
        ? '—'
        : String(cfg.practiceLoopEndMeasure);
    const invalid =
      cfg.practiceLoopEndMeasure !== null &&
      cfg.practiceLoopEndMeasure <= cfg.practiceLoopStartMeasure;
    ctx.fillText(`Loop range:  A = ${start}   B = ${end}`, 60, y + 20);
    if (invalid) {
      ctx.fillStyle = '#f87171';
      ctx.fillText('Range invalid (B must be after A). Loop disabled.', 60, y + 40);
    }
    return y + (invalid ? 54 : 32);
  }

  private drawStepButton(
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    action: () => void
  ): void {
    const ctx = this.ctx;
    const idx = this.hits.length;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this.hoveredIdx === idx ? '#fbbf24' : '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, y + h / 2 + 7);
    this.hits.push({ x, y, w, h, action });
  }

  private drawBack(): void {
    const ctx = this.ctx;
    const w = VR_CONFIG_LAYOUT.BACK_BTN_W;
    const h = VR_CONFIG_LAYOUT.BACK_BTN_H;
    // Right-aligned inside the footer strip so it sits next to the hint
    // text instead of floating over it. Hint text is left-aligned from
    // x=40; leaving ~24 px gutter at the right edge.
    const x = PANEL_W_PX - 40 - w;
    const y = FOOTER_TOP + FOOTER_H / 2 - h / 2;
    const idx = this.hits.length;
    ctx.fillStyle = '#3355ff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this.hoveredIdx === idx ? '#fbbf24' : '#1e40af';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Back to menu', x + w / 2, y + h / 2 + 5);
    this.hits.push({
      x,
      y,
      w,
      h,
      action: () => this.onClose?.(),
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Snap to the slider's step boundary so repeated +/- presses don't
 * drift off a round value due to float error (0.05 + 0.05 ≠ 0.1 in IEEE
 * 754). Rounds to the nearest multiple of `step`. Exported so the
 * invariant can be asserted independently of the VR view. */
export function roundToStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}
