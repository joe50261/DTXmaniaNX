import * as THREE from 'three';
import type { ChartEntry, SongEntry } from '@dtxmania/dtx-core';

/**
 * In-VR song-selection panel.
 *
 * Renders the song / chart list to an offscreen 2D canvas, uploads it as a
 * CanvasTexture on a floating Three.js plane, and lets the player point one
 * of their controllers at a row and pull the trigger to pick it. The rest
 * of the shell UI (folder picker, calibration) stays DOM-only — those
 * require a desktop gesture or a keyboard, neither of which the headset
 * can fake.
 *
 * Why re-render the canvas: anything displayed in VR has to be part of the
 * Three.js scene, DOM overlays aren't visible in the headset. We already
 * paint the gameplay HUD that way (see renderer.ts) so the pattern is
 * familiar.
 */

const PANEL_W_PX = 1024;
const PANEL_H_PX = 768;
const PANEL_WORLD_W = 1.6;   // metres
const PANEL_WORLD_H = PANEL_W_PX ? (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX : 1.2;
const PANEL_POS = new THREE.Vector3(0, 1.45, -1.5);

const ROW_H = 78;
const CHART_BTN_W = 116;
const CHART_BTN_H = 48;

interface ButtonHit {
  action: 'chart';
  song: SongEntry;
  chart: ChartEntry;
}
interface ActionButtonHit {
  action: 'exit';
}
type HitRecord = (ButtonHit | ActionButtonHit) & { x: number; y: number; w: number; h: number };

export interface VrMenuPick {
  song: SongEntry;
  chart: ChartEntry;
}

export class VrMenu {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  /** Laser pointers (one per controller) — visible only while menu is open. */
  private readonly lasers: THREE.Line[] = [];
  /** Tip markers that follow each laser's hit point. */
  private readonly tipMarks: THREE.Mesh[] = [];
  /** Per-controller previous trigger state, for edge-triggered clicks. */
  private readonly wasPressed: boolean[] = [false, false];
  /** Bound XRInputSource per controller index, same as XrControllers'. */
  private readonly inputSources: (XRInputSource | null)[] = [null, null];

  private hits: HitRecord[] = [];
  private hoveredIdx = -1;
  private songs: SongEntry[] = [];
  private onPick: ((pick: VrMenuPick) => void) | null = null;
  private onExit: (() => void) | null = null;
  private shown = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly addedControllers: THREE.Group[] = [];

  constructor(private readonly webgl: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W_PX;
    this.canvas.height = PANEL_H_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('VrMenu: 2D context unavailable');
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

  show(songs: SongEntry[], onPick: (pick: VrMenuPick) => void, onExit: () => void): void {
    this.songs = songs;
    this.onPick = onPick;
    this.onExit = onExit;
    this.hoveredIdx = -1;
    this.shown = true;
    this.mesh.visible = true;
    if (!this.scene.children.includes(this.mesh)) this.scene.add(this.mesh);

    // Spawn laser pointers + input-source capture.
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

      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffeb3b })
      );
      tip.visible = false;
      this.scene.add(tip);
      this.tipMarks.push(tip);
    }
    this.paint();
  }

  hide(): void {
    this.shown = false;
    this.mesh.visible = false;
    for (const l of this.lasers) l.visible = false;
    for (const t of this.tipMarks) t.visible = false;
  }

  dispose(): void {
    this.hide();
    this.scene.remove(this.mesh);
    for (const c of this.addedControllers) this.scene.remove(c);
    for (const t of this.tipMarks) this.scene.remove(t);
    this.lasers.length = 0;
    this.tipMarks.length = 0;
    this.addedControllers.length = 0;
    this.texture.dispose();
  }

  /** Poll controller rays + trigger state; repaint if hover changed. */
  tick(): void {
    if (!this.shown) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    let hovered = -1;
    let firstHitPoint: THREE.Vector3 | null = null;
    let firstHitCtrl = -1;

    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const laser = this.lasers[i];
      const tipMark = this.tipMarks[i];
      if (!laser || !tipMark) continue;

      // World-space ray forward from controller.
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3(0, 0, -1);
      controller.getWorldPosition(origin);
      direction.applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
      this.raycaster.set(origin, direction);
      const hits = this.raycaster.intersectObject(this.mesh, false);
      if (hits.length === 0) {
        tipMark.visible = false;
        continue;
      }
      const hit = hits[0]!;
      tipMark.visible = true;
      tipMark.position.copy(hit.point);
      if (firstHitPoint === null) {
        firstHitPoint = hit.point;
        firstHitCtrl = i;
      }

      // UV → canvas pixel.
      const uv = hit.uv;
      if (!uv) continue;
      const px = uv.x * PANEL_W_PX;
      const py = (1 - uv.y) * PANEL_H_PX;
      const idx = this.hits.findIndex(
        (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h
      );
      if (idx >= 0 && hovered === -1) hovered = idx;

      // Trigger edge detect for click.
      const src = this.inputSources[i];
      const pressed = src?.gamepad?.buttons[0]?.pressed ?? false;
      if (pressed && !this.wasPressed[i] && idx >= 0) {
        this.activate(idx);
      }
      this.wasPressed[i] = pressed;
    }

    if (hovered !== this.hoveredIdx) {
      this.hoveredIdx = hovered;
      this.paint();
    }

    // Silence unused variable lint.
    void firstHitPoint;
    void firstHitCtrl;
  }

  private activate(idx: number): void {
    const hit = this.hits[idx];
    if (!hit) return;
    if (hit.action === 'chart' && this.onPick) {
      this.onPick({ song: hit.song, chart: hit.chart });
    } else if (hit.action === 'exit' && this.onExit) {
      this.onExit();
    }
  }

  private paint(): void {
    const ctx = this.ctx;
    this.hits = [];

    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(0, 0, PANEL_W_PX, PANEL_H_PX);

    // Header
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 34px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Song Library', 40, 60);
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(
      'Point a controller at a difficulty button and press the trigger.',
      40, 90
    );

    // Song rows
    const listTop = 130;
    const visibleRows = Math.floor((PANEL_H_PX - listTop - 80) / ROW_H);
    const songs = this.songs.slice(0, visibleRows);
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i]!;
      const y = listTop + i * ROW_H;
      // Title + meta
      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.fillText(song.title, 40, y + 28);
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillStyle = '#64748b';
      const meta: string[] = [];
      if (song.artist) meta.push(song.artist);
      if (song.bpm) meta.push(`BPM ${Math.round(song.bpm)}`);
      if (meta.length) ctx.fillText(meta.join(' · '), 40, y + 52);

      // Chart buttons
      const btnY = y + 10;
      let btnX = PANEL_W_PX - 40 - song.charts.length * (CHART_BTN_W + 10) + 10;
      for (const chart of song.charts) {
        const hitIdx = this.hits.length;
        const isHover = hitIdx === this.hoveredIdx;
        this.hits.push({
          action: 'chart',
          song,
          chart,
          x: btnX,
          y: btnY,
          w: CHART_BTN_W,
          h: CHART_BTN_H,
        });
        ctx.fillStyle = isHover ? '#3355ff' : '#1e2a55';
        ctx.fillRect(btnX, btnY, CHART_BTN_W, CHART_BTN_H);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(chart.label, btnX + CHART_BTN_W / 2, btnY + 22);
        if (chart.drumLevel !== undefined && chart.drumLevel > 0) {
          ctx.font = '11px ui-monospace, monospace';
          ctx.fillStyle = '#cbd5e1';
          ctx.fillText(`L.${(chart.drumLevel / 100).toFixed(2)}`, btnX + CHART_BTN_W / 2, btnY + 38);
        }
        btnX += CHART_BTN_W + 10;
      }
      ctx.textAlign = 'left';

      // Separator
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(40, y + ROW_H - 2, PANEL_W_PX - 80, 1);
    }

    // Exit VR button, bottom-right
    const exitW = 200;
    const exitH = 50;
    const exitX = PANEL_W_PX - 40 - exitW;
    const exitY = PANEL_H_PX - 70;
    const exitIdx = this.hits.length;
    this.hits.push({ action: 'exit', x: exitX, y: exitY, w: exitW, h: exitH });
    const exitHover = exitIdx === this.hoveredIdx;
    ctx.fillStyle = exitHover ? '#dc2626' : '#374151';
    ctx.fillRect(exitX, exitY, exitW, exitH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Exit VR', exitX + exitW / 2, exitY + 32);

    if (songs.length < this.songs.length) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(
        `+${this.songs.length - songs.length} more — scroll not yet available in VR.`,
        40,
        PANEL_H_PX - 40
      );
    }

    this.texture.needsUpdate = true;
  }
}
