import * as THREE from 'three';
import {
  getConfig,
  subscribe,
  updateConfig,
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
const PANEL_H_PX = 768;
const PANEL_WORLD_W = 1.6;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(0, 1.45, -1.5);

const ROW_H = 50;
const SECTION_GAP = 14;
const SECTION_TITLE_H = 34;
const STEP_W = 56;
const STEP_H = 40;
const TOGGLE_W = 100;

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

  private readonly lasers: THREE.Line[] = [];
  private readonly addedControllers: THREE.Group[] = [];
  private readonly inputSources: (XRInputSource | null)[] = [null, null];
  private readonly wasPressed: boolean[] = [false, false];
  private readonly raycaster = new THREE.Raycaster();

  private shown = false;
  private onClose: (() => void) | null = null;
  private hits: ButtonHit[] = [];
  private hoveredIdx = -1;

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
  }

  show(onClose: () => void): void {
    this.onClose = onClose;
    this.shown = true;
    this.mesh.visible = true;
    if (!this.scene.children.includes(this.mesh)) this.scene.add(this.mesh);

    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const idx = i;
      controller.addEventListener('connected', (event) => {
        const data = (event as unknown as { data?: XRInputSource }).data;
        if (data) this.inputSources[idx] = data;
      });
      controller.addEventListener('disconnected', () => {
        this.inputSources[idx] = null;
      });
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -2.5),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffeb3b, transparent: true, opacity: 0.7 })
      );
      controller.add(line);
      this.scene.add(controller);
      this.addedControllers.push(controller);
      this.lasers.push(line);
    }

    // Repaint on any config change (e.g. hotkey-driven loop capture,
    // desktop DOM panel touching the same settings).
    this.unsubConfig = subscribe(() => {
      if (this.shown) this.paint();
    });
    this.paint();
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
    this.scene.remove(this.mesh);
    for (const c of this.addedControllers) this.scene.remove(c);
    this.lasers.length = 0;
    this.addedControllers.length = 0;
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
        this.hits[hitIdx]!.action();
        this.paint();
      }
      this.wasPressed[i] = pressed;
    }

    if (hovered !== this.hoveredIdx) {
      this.hoveredIdx = hovered;
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
    let y = 90;

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
    y = this.paintToggle(y, 'Reverse scroll (chips rise)', cfg.reverseScroll, (v) =>
      updateConfig({ reverseScroll: v })
    );
    y = this.paintToggle(y, 'FAST / SLOW indicator', cfg.showFastSlow, (v) =>
      updateConfig({ showFastSlow: v })
    );

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

    // Footer hints
    ctx.fillStyle = '#64748b';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      'Hit the − / + buttons to step a slider. Toggles flip on click. ' +
        'Changes persist instantly.',
      40,
      PANEL_H_PX - 82
    );
    ctx.fillText(
      'Loop A / B capture lives on the right controller face buttons during play.',
      40,
      PANEL_H_PX - 62
    );

    // Back / Close button
    this.drawBack();

    this.texture.needsUpdate = true;
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
    const w = 220;
    const h = 56;
    const x = PANEL_W_PX / 2 - w / 2;
    const y = PANEL_H_PX - 40 - h;
    const idx = this.hits.length;
    ctx.fillStyle = '#3355ff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this.hoveredIdx === idx ? '#fbbf24' : '#1e40af';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Back to menu', x + w / 2, y + h / 2 + 6);
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
 * 754). Rounds to the nearest multiple of `step`. */
function roundToStep(v: number, step: number): number {
  return Math.round(v / step) * step;
}
