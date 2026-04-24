import * as THREE from 'three';
import type { AudioEngine } from '@dtxmania/audio-engine';
import {
  computeOffset,
  makeClickBuffer,
  scheduleBeats,
  type PressEvent,
} from './calibrate-model.js';

/**
 * In-VR audio-latency calibration panel.
 *
 * WebXR compositor photon-to-motion latency, controller pose prediction,
 * and the fixed 90/120 Hz HMD refresh all mean the audio offset measured
 * on desktop does NOT carry over to the VR path. A player needs to
 * calibrate without removing the headset, so we reproduce the desktop
 * calibration flow as a floating CanvasTexture panel using the same
 * math (`calibrate-model.ts`) and register presses from whichever
 * controller trigger the player pulls.
 *
 * Lifecycle:
 *   new VrCalibrate(webgl, scene, engine)
 *   show(onDone)       — places the panel in front of the player,
 *                         waits for a Start press, plays the beat
 *                         sequence, then presents a Save / Retry /
 *                         Cancel review.
 *   tick()             — called every frame from Game; polls triggers,
 *                         repaints the animated beat dot.
 *   hide() / dispose() — usual cleanup.
 */

const PANEL_W_PX = 1024;
const PANEL_H_PX = 512;
const PANEL_WORLD_W = 1.6;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(0, 1.45, -1.5);

const BEATS = 12;
const WARMUP = 2;
const INTERVAL_MS = 500;
const BEAT_FLASH_MS = 120;

type Phase = 'idle' | 'collecting' | 'review';

interface ReviewResult {
  /** Offset in ms; null when not enough good presses to compute. */
  offset: number | null;
  /** Count of presses that survived the 300 ms match window. */
  usablePresses: number;
}

interface ButtonHit {
  x: number;
  y: number;
  w: number;
  h: number;
  action: 'start' | 'cancel' | 'save' | 'retry';
}

export class VrCalibrate {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  /** One laser per controller, attached once in the constructor.
   * Re-creating them on every show() without cleanup was leaking
   * Three.js Line children and event listeners onto the long-lived
   * controller objects. */
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
  private phase: Phase = 'idle';
  private onDone: ((offsetMs: number | null) => void) | null = null;
  /** Dirty flag — set when state changes; checked in tick() to decide
   * whether to repaint. Avoids unconditional 90 Hz canvas upload during
   * idle/review phases where nothing changes visually. */
  private dirty = true;

  // Beat-sequence state (populated when phase === 'collecting').
  private beatTimes: number[] = [];
  private presses: PressEvent[] = [];
  /** Last beat index whose flash animation is still in progress. Used
   * to drive the visual pulse on the beat dot. -1 when no beat active. */
  private lastBeatIdx = -1;
  private lastBeatFlashStartMs = 0;
  private watchdog: number | null = null;
  private result: ReviewResult | null = null;

  private hits: ButtonHit[] = [];
  private hoveredIdx = -1;

  constructor(
    private readonly webgl: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly engine: AudioEngine
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W_PX;
    this.canvas.height = PANEL_H_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('VrCalibrate: 2D context unavailable');
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
      // controller when its drum kit starts. Don't scene.remove on
      // hide/dispose — XrControllers owns controller lifetime.
      this.scene.add(controller);
      this.controllers.push(controller);
      this.lasers.push(line);
      this.onConnectedHandlers.push(onConnected);
      this.onDisconnectedHandlers.push(onDisconnected);
    }

    // Session-level backstop: if the runtime skips per-controller
    // `connected` dispatches at session start (polyfill / emulator / no
    // synthetic initial inputsourceschange), read session.inputSources
    // directly so tick() has gamepad state to poll. Slot order matches
    // Three.js because our array begins [null, null] and assignment is
    // first-empty-slot; see xr-controllers.ts for the full rationale.
    this.webgl.xr.addEventListener('sessionstart', this.onSessionStart);
    this.webgl.xr.addEventListener('sessionend', this.onSessionEnd);
  }

  private readonly onSessionStart = (): void => {
    const session = this.webgl.xr.getSession();
    if (!session) return;
    const sources = session.inputSources;
    for (let i = 0; i < Math.min(sources.length, 2); i++) {
      if (this.inputSources[i] === null) {
        this.inputSources[i] = sources[i] ?? null;
      }
    }
  };

  private readonly onSessionEnd = (): void => {
    this.inputSources[0] = null;
    this.inputSources[1] = null;
  };

  show(onDone: (offsetMs: number | null) => void): void {
    this.onDone = onDone;
    this.shown = true;
    this.mesh.visible = true;
    for (const l of this.lasers) l.visible = true;
    this.phase = 'idle';
    this.presses = [];
    this.beatTimes = [];
    this.result = null;
    this.lastBeatIdx = -1;
    this.dirty = true;
    this.paint();
  }

  hide(): void {
    this.shown = false;
    this.mesh.visible = false;
    for (const l of this.lasers) l.visible = false;
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.onDone = null;
  }

  dispose(): void {
    this.hide();
    this.webgl.xr.removeEventListener('sessionstart', this.onSessionStart);
    this.webgl.xr.removeEventListener('sessionend', this.onSessionEnd);
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

  /** Per-frame tick: polls trigger edges, repaints on visual state
   * changes. Cheap no-op when hidden. */
  tick(): void {
    if (!this.shown) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    // Hover + trigger edge detection (both controllers, either hand works).
    let hovered = -1;
    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3(0, 0, -1);
      controller.getWorldPosition(origin);
      direction.applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
      this.raycaster.set(origin, direction);
      const hitsRay = this.raycaster.intersectObject(this.mesh, false);
      let rayHitIdx = -1;
      if (hitsRay.length > 0) {
        const uv = hitsRay[0]!.uv;
        if (uv) {
          const px = uv.x * PANEL_W_PX;
          const py = (1 - uv.y) * PANEL_H_PX;
          rayHitIdx = this.hits.findIndex(
            (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h
          );
          if (rayHitIdx >= 0 && hovered === -1) hovered = rayHitIdx;
        }
      }

      const src = this.inputSources[i];
      const pressed = src?.gamepad?.buttons[0]?.pressed ?? false;
      if (pressed && !this.wasPressed[i]) {
        if (this.phase === 'collecting') {
          // Collection phase: every trigger edge is a press measurement.
          // `engine.ctx.currentTime` is the ground truth the scheduled
          // beats were built on, so press timestamps line up 1:1 with
          // beatTimes without any clock conversion.
          this.presses.push({ audioTime: this.engine.ctx.currentTime });
          this.dirty = true; // the "Presses: N" counter changed
        } else if (rayHitIdx >= 0) {
          // Idle / review phase: trigger on a laser-hit button activates it.
          this.invokeButton(this.hits[rayHitIdx]!.action);
          this.dirty = true;
        }
      }
      this.wasPressed[i] = pressed;
    }

    // Beat-dot animation during collection. Flip dirty while the flash
    // is fading so the opacity/brightness animation re-renders each
    // frame; otherwise the paint is skipped entirely.
    if (this.phase === 'collecting') {
      const now = this.engine.ctx.currentTime;
      let active = -1;
      for (let i = 0; i < this.beatTimes.length; i++) {
        const dt = now - this.beatTimes[i]!;
        if (dt >= 0 && dt < BEAT_FLASH_MS / 1000) {
          active = i;
          break;
        }
      }
      if (active !== this.lastBeatIdx) {
        this.lastBeatIdx = active;
        this.lastBeatFlashStartMs = performance.now();
        this.dirty = true;
      }
      // Keep repainting while the flash is still inside its fade window.
      if (performance.now() - this.lastBeatFlashStartMs < BEAT_FLASH_MS) {
        this.dirty = true;
      }
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

  private async startCollection(): Promise<void> {
    await this.engine.resume();
    const ctx = this.engine.ctx;
    const clickBuf = makeClickBuffer(ctx);
    const scheduled = scheduleBeats(ctx, clickBuf, {
      beats: BEATS,
      intervalMs: INTERVAL_MS,
    });
    this.beatTimes = scheduled.beatTimes;
    this.presses = [];
    this.phase = 'collecting';
    this.dirty = true;

    const endAt = this.beatTimes[this.beatTimes.length - 1]! + 0.35;
    this.watchdog = window.setInterval(() => {
      if (ctx.currentTime < endAt) return;
      if (this.watchdog !== null) {
        window.clearInterval(this.watchdog);
        this.watchdog = null;
      }
      this.finishCollection();
    }, 50);
  }

  private finishCollection(): void {
    const offset = computeOffset(this.beatTimes, this.presses, WARMUP);
    // Usable-press count drives the review copy ("measured from N of M beats").
    const usablePresses = this.countUsablePresses();
    this.result = { offset, usablePresses };
    this.phase = 'review';
    this.lastBeatIdx = -1;
    this.dirty = true;
    this.paint();
  }

  private countUsablePresses(): number {
    const active = this.beatTimes.slice(WARMUP);
    let count = 0;
    for (const press of this.presses) {
      let bestAbs = Number.POSITIVE_INFINITY;
      for (const beat of active) {
        const d = Math.abs(press.audioTime - beat);
        if (d < bestAbs) bestAbs = d;
      }
      if (bestAbs <= 0.3) count++;
    }
    return count;
  }

  private invokeButton(action: ButtonHit['action']): void {
    switch (action) {
      case 'start':
        void this.startCollection();
        return;
      case 'cancel':
        this.onDone?.(null);
        return;
      case 'save':
        this.onDone?.(this.result?.offset ?? null);
        return;
      case 'retry':
        this.phase = 'idle';
        this.result = null;
        this.presses = [];
        this.beatTimes = [];
        this.dirty = true;
        this.paint();
        return;
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
    ctx.fillText('Audio Latency Calibration', PANEL_W_PX / 2, 52);

    switch (this.phase) {
      case 'idle':
        this.paintIdle();
        break;
      case 'collecting':
        this.paintCollecting();
        break;
      case 'review':
        this.paintReview();
        break;
    }
    // Single-site texture upload so sub-paint methods don't each have
    // to remember to flip needsUpdate.
    this.texture.needsUpdate = true;
  }

  private paintIdle(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    wrapText(
      ctx,
      'Pull either controller trigger on every beat. ' +
        `${BEATS} beats total, first ${WARMUP} are warm-up.`,
      PANEL_W_PX / 2,
      110,
      PANEL_W_PX - 120,
      22
    );

    this.paintBeatDot(false);

    this.drawButton('Start', PANEL_W_PX / 2 - 110, PANEL_H_PX - 90, 220, 56, {
      action: 'start',
      primary: true,
    });
    this.drawButton('Cancel', 40, PANEL_H_PX - 70, 120, 40, { action: 'cancel' });
  }

  private paintCollecting(): void {
    const ctx = this.ctx;
    const active = Math.max(0, this.lastBeatIdx);
    const warmed = active < WARMUP;
    const label = warmed
      ? `Warm-up ${active + 1} / ${WARMUP}`
      : `Beat ${active - WARMUP + 1} / ${BEATS - WARMUP}`;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, PANEL_W_PX / 2, 110);

    this.paintBeatDot(
      this.lastBeatIdx >= 0 &&
        performance.now() - this.lastBeatFlashStartMs < BEAT_FLASH_MS
    );

    ctx.fillStyle = '#475569';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText(
      `Presses: ${this.presses.length}`,
      PANEL_W_PX / 2,
      PANEL_H_PX - 40
    );
  }

  private paintReview(): void {
    const ctx = this.ctx;
    // `finishCollection` always sets `this.result` before flipping the
    // phase to 'review', so `r` is guaranteed non-null when this paints.
    const r = this.result!;

    if (r.offset === null) {
      // Too few usable presses — explain + offer Retry.
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough timed presses', PANEL_W_PX / 2, 150);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '15px ui-monospace, monospace';
      wrapText(
        ctx,
        `Need at least 3 presses within 300 ms of a beat. ` +
          `Got ${r.usablePresses}. Try again, pulling the trigger ` +
          `on every flash.`,
        PANEL_W_PX / 2,
        190,
        PANEL_W_PX - 120,
        22
      );
      this.drawButton('Retry', PANEL_W_PX / 2 - 110, PANEL_H_PX - 90, 220, 56, {
        action: 'retry',
        primary: true,
      });
      this.drawButton('Cancel', 40, PANEL_H_PX - 70, 120, 40, { action: 'cancel' });
    } else {
      const rounded = Math.round(r.offset);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 42px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${rounded > 0 ? '+' : ''}${rounded} ms`, PANEL_W_PX / 2, 180);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '15px ui-monospace, monospace';
      ctx.fillText(
        `Median of ${r.usablePresses} timed presses`,
        PANEL_W_PX / 2,
        215
      );
      ctx.fillStyle = '#64748b';
      ctx.font = '13px ui-monospace, monospace';
      wrapText(
        ctx,
        'Positive = you pressed late, so the game will shift judgment ' +
          'windows later. Negative = you pressed early.',
        PANEL_W_PX / 2,
        250,
        PANEL_W_PX - 120,
        20
      );
      this.drawButton('Save', PANEL_W_PX / 2 - 230, PANEL_H_PX - 90, 200, 56, {
        action: 'save',
        primary: true,
      });
      this.drawButton('Retry', PANEL_W_PX / 2 + 30, PANEL_H_PX - 90, 200, 56, {
        action: 'retry',
      });
      this.drawButton('Cancel', 40, PANEL_H_PX - 70, 120, 40, { action: 'cancel' });
    }
  }

  private paintBeatDot(flashing: boolean): void {
    const ctx = this.ctx;
    const cx = PANEL_W_PX / 2;
    const cy = 260;
    const base = 54;
    const radius = flashing ? base * 1.12 : base;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = flashing ? '#fbbf24' : '#1f2937';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = flashing ? '#fbbf24' : '#4b5563';
    ctx.stroke();
  }

  private drawButton(
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { action: ButtonHit['action']; primary?: boolean }
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = opts.primary ? '#3355ff' : '#1e293b';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = opts.primary ? '#fbbf24' : '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w / 2, y + h / 2 + 6);
    this.hits.push({ x, y, w, h, action: opts.action });
  }
}

/** Simple word-wrap: splits on spaces, fills each line up to maxWidth,
 * centers on `x`, draws top-aligned at `y`. Good enough for the two or
 * three short messages we show in the panel. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): void {
  const words = text.split(' ');
  let line = '';
  let cursorY = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY);
      line = w;
      cursorY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}
