import * as THREE from 'three';
import type { Chip } from '@dtxmania/dtx-core';
import { LANE_LAYOUT, channelToLane, type LaneSpec } from './lane-layout.js';
import { PAD_ATLAS, PAD_SIZE, padRect } from './pad-atlas.js';
import { CHIP_ATLAS_Y, CHIP_ATLAS_H, chipRect } from './chip-atlas.js';
import type { LaneValue } from '@dtxmania/input';

export const CANVAS_W = 1280;
export const CANVAS_H = 720;
export const JUDGE_LINE_Y = 600;
export const PX_PER_MS = 0.45;
export const CHIP_H = 14;

export interface JudgmentFlash {
  text: string;
  color: string;
  lane: LaneValue;
  spawnedMs: number;
}

export interface HitFlash {
  lane: LaneValue;
  spawnedMs: number;
}

export interface RenderState {
  songTimeMs: number;
  chips: Chip[];
  combo: number;
  score: number;
  maxCombo: number;
  judgmentFlash: JudgmentFlash | null;
  hitFlashes: HitFlash[];
  status: 'idle' | 'playing' | 'finished';
  titleLine: string;
  songLengthMs: number;
}

/** Optional textures injected by the skin loader. Renderer tolerates absent textures. */
export interface SkinTextures {
  background?: THREE.Texture;
  pads?: THREE.Texture;
  chipsDrums?: THREE.Texture;
}

/**
 * Three.js-backed renderer.
 *
 * Architecture: all 2D drawing still happens on an offscreen HTMLCanvasElement
 * via CanvasRenderingContext2D (the original Canvas 2D code path, preserved
 * to keep behaviour identical and avoid a from-scratch rewrite). That canvas
 * is uploaded to a CanvasTexture mapped onto a fullscreen quad in a Three.js
 * scene. The Three.js WebGLRenderer owns the real on-screen canvas.
 *
 * Benefits:
 *   - 2D gameplay logic unchanged (battle-tested).
 *   - The playfield quad is a real 3D object, so enterXR() just switches the
 *     camera to the XR session's camera and repositions the quad in front of
 *     the viewer — no second renderer.
 *   - Skin textures can be composited into the scene as separate quads
 *     (background, pads) without touching the 2D drawing code.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** Offscreen 2D canvas where all gameplay drawing happens. */
  private readonly hud: HTMLCanvasElement;

  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private readonly orthoCamera: THREE.OrthographicCamera;

  /** Root group containing every playfield element; repositioned in XR. */
  readonly playfield = new THREE.Group();

  private readonly hudTexture: THREE.CanvasTexture;
  private readonly hudMesh: THREE.Mesh;
  private bgMesh: THREE.Mesh | null = null;
  /** Dim quad that sits between bg and HUD so the busy background doesn't eat chips. */
  private dimMesh: THREE.Mesh | null = null;
  /** One sprite per lane, sliced from 7_pads.png. */
  private padMeshes: THREE.Mesh[] = [];
  /** HTMLImageElement of the chips atlas used by 2D drawImage per frame. */
  private chipsImage: HTMLImageElement | null = null;

  /** XR session (null when in desktop ortho mode). */
  private xrSession: XRSession | null = null;

  /** Per-frame tick from the owner (runs BEFORE the WebGL draw). XR-safe. */
  private tickCallback: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, skin: SkinTextures = {}) {
    this.hud = document.createElement('canvas');
    this.hud.width = CANVAS_W;
    this.hud.height = CANVAS_H;
    const c = this.hud.getContext('2d');
    if (!c) throw new Error('2D context unavailable for offscreen HUD');
    this.ctx = c;

    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.webgl.setSize(canvas.clientWidth || CANVAS_W, canvas.clientHeight || CANVAS_H, false);
    this.webgl.xr.enabled = true;

    // Ortho camera looking at the playfield from +Z. Units = pixels (1280x720).
    this.orthoCamera = new THREE.OrthographicCamera(
      -CANVAS_W / 2, CANVAS_W / 2, CANVAS_H / 2, -CANVAS_H / 2, 0.1, 100
    );
    this.orthoCamera.position.z = 10;
    this.orthoCamera.lookAt(0, 0, 0);

    this.scene.add(this.playfield);

    // HUD quad: a plane the size of the virtual canvas, textured from the 2D canvas.
    this.hudTexture = new THREE.CanvasTexture(this.hud);
    this.hudTexture.minFilter = THREE.LinearFilter;
    this.hudTexture.generateMipmaps = false;
    const hudMat = new THREE.MeshBasicMaterial({ map: this.hudTexture, transparent: true });
    this.hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(CANVAS_W, CANVAS_H), hudMat);
    this.hudMesh.position.z = 1; // in front of background / pads
    this.playfield.add(this.hudMesh);

    this.applySkin(skin);

    // Resize observer keeps the WebGL backbuffer sharp when the window / canvas
    // changes size (only relevant in desktop mode; XR owns its own framebuffer).
    const ro = new ResizeObserver(() => this.handleResize());
    ro.observe(canvas);

    // Drive the render loop. setAnimationLoop is XR-safe (uses XR frame pacing
    // when a session is active and rAF otherwise). The tick callback fires
    // before each render so game logic stays XR-compatible.
    this.webgl.setAnimationLoop(() => {
      this.tickCallback?.();
      this.renderFrame();
    });
  }

  /** Register a callback that runs every frame before the WebGL draw. */
  onFrame(cb: () => void): void {
    this.tickCallback = cb;
  }

  /** Attach / replace skin textures. Call once after loading, then forget. */
  applySkin(skin: SkinTextures): void {
    if (skin.background && !this.bgMesh) {
      const mat = new THREE.MeshBasicMaterial({ map: skin.background, transparent: false });
      this.bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(CANVAS_W, CANVAS_H), mat);
      this.bgMesh.position.z = -1; // behind everything
      this.playfield.add(this.bgMesh);

      // Dim the busy background so HUD + chips stay readable. Sits between
      // bg and HUD. 55 % black is the sweet spot — still see the skin, chips
      // don't get eaten.
      const dimMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
      });
      this.dimMesh = new THREE.Mesh(new THREE.PlaneGeometry(CANVAS_W, CANVAS_H), dimMat);
      this.dimMesh.position.z = -0.5;
      this.playfield.add(this.dimMesh);
    }

    if (skin.chipsDrums && !this.chipsImage) {
      // Three.TextureLoader under the hood hands us an HTMLImageElement;
      // re-use it for the 2D drawImage path in paintHud so we don't need
      // a second fetch for the same file.
      const img = skin.chipsDrums.image;
      if (img instanceof HTMLImageElement) this.chipsImage = img;
    }

    if (skin.pads && this.padMeshes.length === 0) {
      // Slice 7_pads.png into 10 per-lane sprites. Each atlas cell is 96×96.
      // We re-use a single source texture by cloning it + retargeting UV repeat
      // / offset — cheaper than 10 separate texture uploads.
      const atlasW = skin.pads.image?.width ?? 384;
      const atlasH = skin.pads.image?.height ?? 288;
      for (const rect of PAD_ATLAS) {
        const spec = LANE_LAYOUT.find((l) => l.lane === rect.lane);
        if (!spec) continue;
        const tex = skin.pads.clone();
        tex.needsUpdate = true;
        tex.repeat.set(PAD_SIZE / atlasW, PAD_SIZE / atlasH);
        // UV origin in Three is bottom-left; atlas origin in C# is top-left.
        tex.offset.set(
          rect.sx / atlasW,
          1 - (rect.sy + PAD_SIZE) / atlasH
        );
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PAD_SIZE, PAD_SIZE), mat);
        // Centre pad over the lane, straddle the judge line.
        const centerX = spec.x + spec.width / 2;
        mesh.position.set(
          centerX - CANVAS_W / 2,
          -(JUDGE_LINE_Y - CANVAS_H / 2),
          0.5 // in front of dim + HUD background
        );
        this.playfield.add(mesh);
        this.padMeshes.push(mesh);
      }
    }
  }

  /** Submit new game state for the next frame's HUD paint. */
  render(state: RenderState): void {
    this.paintHud(state);
    this.hudTexture.needsUpdate = true;
  }

  private renderFrame(): void {
    const cam = this.xrSession ? this.webgl.xr.getCamera() : this.orthoCamera;
    this.webgl.render(this.scene, cam);
  }

  private handleResize(): void {
    if (this.xrSession) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0) this.webgl.setSize(w, h, false);
  }

  /**
   * Request a WebXR immersive-vr session and mount the playfield in front of
   * the viewer. The caller is responsible for handling the onended event to
   * exit XR-specific UI.
   */
  async enterXR(onEnded: () => void): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR not available in this browser');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await this.webgl.xr.setSession(session);
    this.xrSession = session;

    // Float the 1280x720 playfield 2 metres in front of the viewer at head
    // height, scaled down to ~2.4 m wide (comfortable for drum-kit framing).
    const xrScale = 2.4 / CANVAS_W;
    this.playfield.scale.setScalar(xrScale);
    this.playfield.position.set(0, 1.6, -2.0);

    session.addEventListener('end', () => {
      this.xrSession = null;
      this.playfield.scale.setScalar(1);
      this.playfield.position.set(0, 0, 0);
      onEnded();
    });
  }

  get inXR(): boolean {
    return this.xrSession !== null;
  }

  // ---- Offscreen HUD painting (ported verbatim from the old Canvas 2D renderer) ----

  private paintHud(state: RenderState): void {
    const ctx = this.ctx;
    ctx.save();
    // Transparent background — the real bg comes from the textured bgMesh
    // behind us when a skin is present.
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    this.drawLanes();
    this.drawJudgmentLine();
    this.drawChips(state);
    this.drawHitFlashes(state);
    this.drawHUD(state);
    this.drawJudgmentFlash(state);
    ctx.restore();
  }

  private drawLanes(): void {
    const ctx = this.ctx;
    for (const lane of LANE_LAYOUT) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(lane.x, 40, lane.width, JUDGE_LINE_Y - 40);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lane.x + 0.5, 40.5, lane.width - 1, JUDGE_LINE_Y - 40);

      ctx.fillStyle = lane.color;
      ctx.font = 'bold 14px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lane.label, lane.x + lane.width / 2, 32);
    }
  }

  private drawJudgmentLine(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(LANE_LAYOUT[0]!.x, JUDGE_LINE_Y);
    const last = LANE_LAYOUT[LANE_LAYOUT.length - 1]!;
    ctx.lineTo(last.x + last.width, JUDGE_LINE_Y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawChips(state: RenderState): void {
    const now = state.songTimeMs;
    for (const chip of state.chips) {
      const lane = channelToLane(chip.channel);
      if (!lane) continue;
      const y = JUDGE_LINE_Y - (chip.playbackTimeMs - now) * PX_PER_MS;
      if (y < -20 || y > CANVAS_H + 20) continue;
      const alpha = y > JUDGE_LINE_Y + 50 ? 0.2 : 1;
      this.fillChip(lane, y, alpha);
    }
  }

  private fillChip(lane: LaneSpec, y: number, alpha: number): void {
    const ctx = this.ctx;
    const rect = chipRect(lane.lane);
    if (this.chipsImage && rect && this.chipsImage.complete) {
      // DTXMania chip sprites are 64px tall; we shrink to CHIP_H so the
      // visual density matches our 0.45 px/ms scroll rate.
      const destH = CHIP_H * 3; // slight thickness > the colour-block version
      const destW = rect.sw;
      const dx = lane.x + lane.width / 2 - destW / 2;
      const dy = y - destH / 2;
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        this.chipsImage,
        rect.sx,
        CHIP_ATLAS_Y,
        rect.sw,
        CHIP_ATLAS_H,
        dx,
        dy,
        destW,
        destH
      );
      ctx.globalAlpha = 1;
      return;
    }
    // Fallback: flat coloured rect (skin missing or image not loaded yet).
    ctx.globalAlpha = alpha;
    ctx.fillStyle = lane.color;
    const pad = 4;
    ctx.fillRect(lane.x + pad, y - CHIP_H / 2, lane.width - pad * 2, CHIP_H);
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = alpha * 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(lane.x + pad + 0.5, y - CHIP_H / 2 + 0.5, lane.width - pad * 2 - 1, CHIP_H - 1);
    ctx.globalAlpha = 1;
  }

  private drawHitFlashes(state: RenderState): void {
    const ctx = this.ctx;
    for (const flash of state.hitFlashes) {
      const age = state.songTimeMs - flash.spawnedMs;
      const life = 200;
      if (age < 0 || age > life) continue;
      const alpha = 1 - age / life;
      const lane = LANE_LAYOUT.find((l) => l.lane === flash.lane);
      if (!lane) continue;
      ctx.globalAlpha = alpha * 0.8;
      const grad = ctx.createRadialGradient(
        lane.x + lane.width / 2, JUDGE_LINE_Y, 0,
        lane.x + lane.width / 2, JUDGE_LINE_Y, 60
      );
      grad.addColorStop(0, lane.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(lane.x - 20, JUDGE_LINE_Y - 60, lane.width + 40, 120);
      ctx.globalAlpha = 1;
    }
  }

  private drawHUD(state: RenderState): void {
    const ctx = this.ctx;

    ctx.fillStyle = '#aaa';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(state.titleLine, 20, 30);

    const progress = state.songLengthMs > 0
      ? Math.max(0, Math.min(1, state.songTimeMs / state.songLengthMs))
      : 0;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(20, 50, 200, 6);
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(20, 50, 200 * progress, 6);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(state.score.toString().padStart(7, '0'), CANVAS_W - 40, 80);

    ctx.fillStyle = state.combo >= 10 ? '#fbbf24' : '#9ca3af';
    ctx.font = 'bold 64px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.combo > 0 ? `${state.combo}` : '', CANVAS_W / 2, JUDGE_LINE_Y - 90);
    if (state.combo > 0) {
      ctx.fillStyle = '#6b7280';
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.fillText('COMBO', CANVAS_W / 2, JUDGE_LINE_Y - 60);
    }

    ctx.fillStyle = '#4b5563';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`MAX COMBO ${state.maxCombo}`, CANVAS_W - 20, CANVAS_H - 20);

    if (state.status === 'finished') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 64px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FINISHED', CANVAS_W / 2, CANVAS_H / 2 - 20);
      ctx.font = '22px ui-monospace, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Score ${state.score}  •  Max Combo ${state.maxCombo}`, CANVAS_W / 2, CANVAS_H / 2 + 20);
      ctx.fillText('Press Esc to restart', CANVAS_W / 2, CANVAS_H / 2 + 60);
    }
  }

  private drawJudgmentFlash(state: RenderState): void {
    if (!state.judgmentFlash) return;
    const ctx = this.ctx;
    const age = state.songTimeMs - state.judgmentFlash.spawnedMs;
    const life = 400;
    if (age < 0 || age > life) return;
    const lane = LANE_LAYOUT.find((l) => l.lane === state.judgmentFlash!.lane);
    if (!lane) return;
    const alpha = 1 - age / life;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = state.judgmentFlash.color;
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const y = JUDGE_LINE_Y + 36 - (age / life) * 20;
    ctx.fillText(state.judgmentFlash.text, lane.x + lane.width / 2, y);
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    this.webgl.setAnimationLoop(null);
    this.webgl.dispose();
  }
}
