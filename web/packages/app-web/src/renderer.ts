import * as THREE from 'three';
import type { Chip } from '@dtxmania/dtx-core';
import { LANE_LAYOUT, channelToLane, type LaneSpec } from './lane-layout.js';
import { PAD_ATLAS, PAD_SIZE, padRect } from './pad-atlas.js';
import { CHIP_ATLAS_Y, CHIP_ATLAS_H, chipRect } from './chip-atlas.js';
import { JUDGE_ROWS, JUDGE_SPRITE_W, JUDGE_SPRITE_H } from './judge-atlas.js';
import { linearFadeIn, linearFadeOut, padBounceOffset } from './renderer-math.js';
import { PlayfieldCanvas } from './playfield-canvas.js';
import { ResultCanvas } from './result-canvas.js';
import type { JudgmentKind, Rank } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

export const CANVAS_W = 1280;
export const CANVAS_H = 720;
/** Default judgment line y. Renderer carries a mutable instance field
 * so the Settings panel can move it live; this constant is just the
 * initial value. */
export const DEFAULT_JUDGE_LINE_Y = 600;
/** Default chip scroll speed (px / ms). Same story — overridable at
 * runtime via `Renderer.setScrollSpeed`. */
export const DEFAULT_SCROLL_SPEED = 0.45;
export const CHIP_H = 14;

export interface JudgmentFlash {
  text: string;
  /** Raw judgment kind, used to look up the sprite in JUDGE_ROWS. */
  judgment?: JudgmentKind;
  color: string;
  lane: LaneValue;
  spawnedMs: number;
  /** Hit-time delta in ms. Negative = player pressed early (FAST),
   * positive = late (SLOW). `undefined` for MISS (no user press). */
  deltaMs?: number;
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
  /** 0..1 life / skill gauge. Painted as the DTXMania 7_Gauge sprite. */
  gauge: number;
  /**
   * performance.now() (ms) of the most recent drum-pad strike per lane.
   * Drives the pad bounce + flush overlay animation; pad scheduler in Game
   * updates this on any hit (matched or stray) that actually makes sound.
   */
  lastPadHitMs: Map<LaneValue, number>;
  /** Per-judgment hit counts (stable once status === 'finished'). */
  counts: Record<JudgmentKind, number>;
  /** Total playable chips in the chart. */
  totalNotes: number;
  /** DTXMania achievement rate (0..100). Meaningful on the result screen. */
  achievementRate: number;
  /** Letter grade. Only meaningful on the result screen; 'E' otherwise. */
  rank: Rank;
  /** POOR=0 && MISS=0. Shown as a badge on the result screen. */
  fullCombo: boolean;
  /** Every note PERFECT. Supersedes fullCombo on the result banner. */
  excellent: boolean;
  /** performance.now() of the playing → finished transition. null while playing. */
  finishedAtMs: number | null;
  /** True when the session runs inside a WebXR headset. Changes the result-screen footer hint. */
  inXR: boolean;
  /** Active mid-play toast text + expiry. Null when nothing to show.
   * Painted over the HUD so it's visible in both desktop and VR — a
   * DOM overlay would be invisible inside an immersive WebXR session. */
  toast: { text: string; expiresAtMs: number } | null;
}

/** Optional textures injected by the skin loader. Renderer tolerates absent textures. */
export interface SkinTextures {
  background?: THREE.Texture;
  pads?: THREE.Texture;
  padsFlush?: THREE.Texture;
  chipsDrums?: THREE.Texture;
  judgeStrings?: THREE.Texture;
  gaugeFrame?: THREE.Texture;
  gaugeBar?: THREE.Texture;
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
  /**
   * One overlay per lane, sliced from ScreenPlayDrums pads flush.png, drawn
   * in front of `padMeshes` when the corresponding lane was just struck.
   * Opacity is animated in the render loop via `lastPadHitMs`.
   */
  private flushMeshes: (THREE.Mesh | null)[] = [];
  /** Base y-position of each pad so we can bounce it down and back. */
  private padBaseY: number[] = [];
  /** Lane value associated with each padMeshes index (parallel array). */
  private padLanes: LaneValue[] = [];
  /** Most recent pad-hit timestamps submitted by Game, used for animation. */
  private lastPadHitMs = new Map<LaneValue, number>();
  /** Chip scroll speed (px / ms). Settable via the Settings panel —
   * read every frame in drawChips. */
  private scrollSpeed = DEFAULT_SCROLL_SPEED;
  /** Y position of the judgment line on the HUD canvas. Pad meshes are
   * recomputed when this changes so the 3D pads track the visual line. */
  private judgeLineY = DEFAULT_JUDGE_LINE_Y;
  /** False = chips fall top→bottom (DTX default). True = chips rise. */
  private reverseScroll = false;
  /** When true, drawJudgmentFlash surfaces a small "FAST" / "SLOW"
   * label on top of the judgment text. Controlled by config.showFastSlow. */
  private showFastSlow = false;
  /** Symmetric dead-band in ms; abs(delta) ≤ this → no label even
   * with showFastSlow on. */
  private fastSlowDeadMs = 8;
  /** HTMLImageElement of the chips atlas used by 2D drawImage per frame. */
  private chipsImage: HTMLImageElement | null = null;
  /** ScreenPlay judge strings 1.png — one row per judgment. */
  private judgeImage: HTMLImageElement | null = null;
  /** 7_Gauge.png frame overlay. */
  private gaugeFrameImage: HTMLImageElement | null = null;
  /** 7_gauge_bar.png — scaled horizontally by gauge value. */
  private gaugeBarImage: HTMLImageElement | null = null;

  /** Playfield sub-canvas (07.Performance port — lane-flush slice).
   *  Paints the 2D lane-flush overlay on top of the chip stream.
   *  3D pad meshes still live on `padMeshes` for now. */
  private readonly playfieldCanvas = new PlayfieldCanvas();

  /** Result-screen sub-canvas (08.Result port). Owns its own asset
   *  preload + reveal animation; renderer just hands it the 2D
   *  context when `state.status === 'finished'`. */
  private readonly resultCanvas = new ResultCanvas();
  /** Previous frame's playback status — used to detect the
   *  playing → finished transition so the rank reveal counter
   *  resets when a fresh play ends. */
  private prevStatus: 'idle' | 'playing' | 'finished' = 'idle';

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
    const hudMat = new THREE.MeshBasicMaterial({
      map: this.hudTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(CANVAS_W, CANVAS_H), hudMat);
    this.hudMesh.position.z = 1; // in front of background / pads
    this.hudMesh.renderOrder = 4;
    this.playfield.add(this.hudMesh);

    this.applySkin(skin);

    // Result-screen sub-canvas owns its own asset preload (8_x and
    // ScreenResult x assets). Fire-and-forget so the renderer keeps
    // booting; first paints fall back to procedural draws while
    // images stream in.
    void this.resultCanvas.load();
    // Playfield lane-flush sub-canvas — same pattern. Loads the 9
    // ScreenPlayDrums lane-flush PNGs.
    void this.playfieldCanvas.load();

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
      this.bgMesh.renderOrder = 0;
      this.playfield.add(this.bgMesh);

      // Dim the busy background so HUD + chips stay readable. Sits between
      // bg and HUD. 55 % black is the sweet spot — still see the skin, chips
      // don't get eaten.
      const dimMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false,
      });
      this.dimMesh = new THREE.Mesh(new THREE.PlaneGeometry(CANVAS_W, CANVAS_H), dimMat);
      this.dimMesh.position.z = -0.5;
      this.dimMesh.renderOrder = 1;
      this.playfield.add(this.dimMesh);
    }

    if (skin.chipsDrums && !this.chipsImage) {
      // Three.TextureLoader under the hood hands us an HTMLImageElement;
      // re-use it for the 2D drawImage path in paintHud so we don't need
      // a second fetch for the same file.
      const img = skin.chipsDrums.image;
      if (img instanceof HTMLImageElement) this.chipsImage = img;
    }
    if (skin.judgeStrings && !this.judgeImage) {
      const img = skin.judgeStrings.image;
      if (img instanceof HTMLImageElement) this.judgeImage = img;
    }
    if (skin.gaugeFrame && !this.gaugeFrameImage) {
      const img = skin.gaugeFrame.image;
      if (img instanceof HTMLImageElement) this.gaugeFrameImage = img;
    }
    if (skin.gaugeBar && !this.gaugeBarImage) {
      const img = skin.gaugeBar.image;
      if (img instanceof HTMLImageElement) this.gaugeBarImage = img;
    }

    if (skin.pads && this.padMeshes.length === 0) {
      // Slice 7_pads.png into 10 per-lane sprites. Each atlas cell is 96×96.
      // We re-use a single source texture by cloning it + retargeting UV repeat
      // / offset — cheaper than 10 separate texture uploads.
      const atlasW = skin.pads.image?.width ?? 384;
      const atlasH = skin.pads.image?.height ?? 288;
      const flushW = skin.padsFlush?.image?.width ?? atlasW;
      const flushH = skin.padsFlush?.image?.height ?? atlasH;
      for (const rect of PAD_ATLAS) {
        const spec = LANE_LAYOUT.find((l) => l.lane === rect.lane);
        if (!spec) continue;
        const tex = skin.pads.clone();
        tex.needsUpdate = true;
        tex.repeat.set(PAD_SIZE / atlasW, PAD_SIZE / atlasH);
        tex.offset.set(rect.sx / atlasW, 1 - (rect.sy + PAD_SIZE) / atlasH);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PAD_SIZE, PAD_SIZE), mat);
        const centerX = spec.x + spec.width / 2;
        const baseY = -(this.judgeLineY - CANVAS_H / 2);
        mesh.position.set(centerX - CANVAS_W / 2, baseY, 0.5);
        mesh.renderOrder = 2;
        this.playfield.add(mesh);
        this.padMeshes.push(mesh);
        this.padBaseY.push(baseY);
        this.padLanes.push(rect.lane);

        // Parallel flush overlay — starts invisible. Atlas layout mirrors
        // 7_pads.png, so same per-lane rect applies.
        if (skin.padsFlush) {
          const fTex = skin.padsFlush.clone();
          fTex.needsUpdate = true;
          fTex.repeat.set(PAD_SIZE / flushW, PAD_SIZE / flushH);
          fTex.offset.set(rect.sx / flushW, 1 - (rect.sy + PAD_SIZE) / flushH);
          const fMat = new THREE.MeshBasicMaterial({
            map: fTex,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            depthWrite: false,
          });
          const fMesh = new THREE.Mesh(new THREE.PlaneGeometry(PAD_SIZE, PAD_SIZE), fMat);
          fMesh.position.set(centerX - CANVAS_W / 2, baseY, 0.6); // in front of pad
          fMesh.renderOrder = 3;
          this.playfield.add(fMesh);
          this.flushMeshes.push(fMesh);
        } else {
          this.flushMeshes.push(null);
        }
      }
    }
  }

  /** Submit the Game's latest pad-hit timestamps. Called each tick. */
  submitPadHits(map: Map<LaneValue, number>): void {
    this.lastPadHitMs = map;
  }

  /**
   * Hide / show the entire playfield group (bg, dim, pads, flush, HUD).
   * Used by Game while the VR menu is up so the result overlay and scrolling
   * pads don't paint over the menu panel: our playfield layers have
   * depthTest:false + high renderOrder (to survive sub-mm XR Z deltas), so
   * they'd otherwise always win the transparent sort against the menu mesh.
   */
  setPlayfieldVisible(visible: boolean): void {
    this.playfield.visible = visible;
  }

  /** Live setter for chip scroll speed. Cheap — read each frame in
   * drawChips. */
  setScrollSpeed(v: number): void {
    this.scrollSpeed = v;
  }

  /** Live setter for the judgment line. The pad meshes are pinned to
   * this line in 3D, so we recompute their baseY + reset position on
   * every change so the visual line and the physical pads track
   * together. Bounce animation works off baseY so it falls through. */
  setJudgeLineY(y: number): void {
    if (this.judgeLineY === y) return;
    this.judgeLineY = y;
    const baseY = -(y - CANVAS_H / 2);
    for (let i = 0; i < this.padMeshes.length; i++) {
      this.padBaseY[i] = baseY;
      const mesh = this.padMeshes[i]!;
      mesh.position.y = baseY;
      const flush = this.flushMeshes[i];
      if (flush) flush.position.y = baseY;
    }
  }

  /** Live setter for chip scroll direction. drawChips uses it; pad
   * meshes don't move (they sit on the judgment line either way — the
   * player still hits them at the same physical spot). */
  setReverseScroll(v: boolean): void {
    this.reverseScroll = v;
  }

  /** Live setters for the FAST/SLOW label. Dead-band is symmetric —
   * only hits outside ±deadMs show the arrow. */
  setFastSlowEnabled(v: boolean): void {
    this.showFastSlow = v;
  }
  setFastSlowDeadMs(v: number): void {
    this.fastSlowDeadMs = Math.max(0, v);
  }

  /** Submit new game state for the next frame's HUD paint. */
  render(state: RenderState): void {
    this.paintHud(state);
    this.hudTexture.needsUpdate = true;
  }

  /** Wipe the HUD canvas to transparent and flag the texture for upload.
   * Used by Game.loadAndStart to drop the previous chart's chips +
   * result overlay the instant a new chart is confirmed — otherwise the
   * tick()'s `if (!this.song) return;` early-exit would leave the
   * texture frozen on the old frame during the sample preload. */
  clearHud(): void {
    this.ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this.hudTexture.needsUpdate = true;
  }

  private renderFrame(): void {
    this.animatePadHits();
    const cam = this.xrSession ? this.webgl.xr.getCamera() : this.orthoCamera;
    this.webgl.render(this.scene, cam);
  }

  /**
   * Bounce the pad mesh down a few pixels and fade in the flush overlay
   * when the matching lane was just struck. Both relax back to rest over
   * ~200 ms so rapid successive hits still read as distinct bounces.
   */
  private animatePadHits(): void {
    const now = performance.now();
    const bounceDurMs = 120;
    const flushDurMs = 200;
    const bounceAmount = 12; // px in the virtual 1280×720 space
    for (let i = 0; i < this.padMeshes.length; i++) {
      const lane = this.padLanes[i]!;
      const hitAt = this.lastPadHitMs.get(lane);
      const mesh = this.padMeshes[i]!;
      const baseY = this.padBaseY[i]!;
      if (hitAt === undefined) {
        mesh.position.y = baseY;
      } else {
        mesh.position.y = baseY + padBounceOffset(now - hitAt, bounceDurMs, bounceAmount);
      }
      const flush = this.flushMeshes[i];
      if (flush) {
        const mat = flush.material as THREE.MeshBasicMaterial;
        mat.opacity = hitAt === undefined ? 0 : linearFadeOut(now - hitAt, flushDurMs) * 0.9;
      }
    }
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
    this.drawPedalFlash(state);   // wide red bar — sits behind per-lane radial
    this.drawHitFlashes(state);
    // Lane-flush overlay — per-lane vertical streak that rides up on
    // each hit. Skinned via PlayfieldCanvas; falls back to a coloured
    // rectangle when its assets are absent.
    this.playfieldCanvas.paint(ctx, {
      lastPadHitMs: state.lastPadHitMs,
      nowMs: performance.now(),
      canvasH: CANVAS_H,
    });
    this.drawHUD(state);
    this.drawJudgmentFlash(state);
    this.drawToast(state);        // highest z — pinned top-center, both desktop & VR
    ctx.restore();
  }

  /**
   * BD + LBD strikes paint a full-width red horizontal bar across the
   * entire drum region at the judgment line, on top of the per-lane
   * radial flash. Mirrors the canonical DTXmania "腳腳" effect — every
   * kick punctuates the whole playfield, not just its column.
   *
   * Reuses state.hitFlashes (which already records lane + spawnedMs
   * for every drum strike including kicks) so no new state plumbing.
   */
  private drawPedalFlash(state: RenderState): void {
    const ctx = this.ctx;
    const life = 200;
    const first = LANE_LAYOUT[0]!;
    const last = LANE_LAYOUT[LANE_LAYOUT.length - 1]!;
    const x = first.x - 8;
    const w = last.x + last.width - first.x + 16;
    const barH = 36;
    const y = this.judgeLineY - barH / 2;
    for (const flash of state.hitFlashes) {
      // Only kick lanes contribute to the wide bar.
      if (flash.lane !== 0x13 /* BD */ && flash.lane !== 0x1c /* LBD */) continue;
      const age = state.songTimeMs - flash.spawnedMs;
      if (age < 0 || age > life) continue;
      const alpha = linearFadeOut(age, life) * 0.55;
      ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
      ctx.fillRect(x, y, w, barH);
    }
  }

  private drawLanes(): void {
    const ctx = this.ctx;
    // Lane fill always spans from the label row (y=40) to the judgment
    // line. In reverse mode that band is below the chip flow direction,
    // which is what the player wants — the playable area stays visually
    // anchored to the judgment line either way.
    const judge = this.judgeLineY;
    for (const lane of LANE_LAYOUT) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(lane.x, 40, lane.width, judge - 40);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lane.x + 0.5, 40.5, lane.width - 1, judge - 40);

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
    ctx.moveTo(LANE_LAYOUT[0]!.x, this.judgeLineY);
    const last = LANE_LAYOUT[LANE_LAYOUT.length - 1]!;
    ctx.lineTo(last.x + last.width, this.judgeLineY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawChips(state: RenderState): void {
    const now = state.songTimeMs;
    const judge = this.judgeLineY;
    const speed = this.scrollSpeed;
    const reverse = this.reverseScroll;
    for (const chip of state.chips) {
      const lane = channelToLane(chip.channel);
      if (!lane) continue;
      const dt = chip.playbackTimeMs - now;
      // Normal: future chips above (smaller y), past chips below.
      // Reverse: future chips below (larger y), past chips above.
      const y = reverse ? judge + dt * speed : judge - dt * speed;
      if (y < -20 || y > CANVAS_H + 20) continue;
      // "Already past the judgment line" = dim the chip so the player
      // can see they missed but the chip's still nearby. The half-line
      // check direction depends on scroll direction.
      const past = reverse ? y < judge - 50 : y > judge + 50;
      const alpha = past ? 0.2 : 1;
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
      const alpha = linearFadeOut(age, life);
      const lane = LANE_LAYOUT.find((l) => l.lane === flash.lane);
      if (!lane) continue;
      ctx.globalAlpha = alpha * 0.8;
      const grad = ctx.createRadialGradient(
        lane.x + lane.width / 2, this.judgeLineY, 0,
        lane.x + lane.width / 2, this.judgeLineY, 60
      );
      grad.addColorStop(0, lane.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(lane.x - 20, this.judgeLineY - 60, lane.width + 40, 120);
      ctx.globalAlpha = 1;
    }
  }

  private drawHUD(state: RenderState): void {
    const ctx = this.ctx;

    // In-play HUD elements — suppressed on the result screen so they don't
    // bleed through the overlay (live combo text in particular would read
    // wrong once the song's over).
    if (state.status !== 'finished') {
      ctx.fillStyle = '#aaa';
      ctx.font = '14px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(state.titleLine, 20, 30);

      const progress = linearFadeIn(state.songTimeMs, state.songLengthMs);
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
      ctx.fillText(state.combo > 0 ? `${state.combo}` : '', CANVAS_W / 2, this.judgeLineY - 90);
      if (state.combo > 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = 'bold 20px ui-monospace, monospace';
        ctx.fillText('COMBO', CANVAS_W / 2, this.judgeLineY - 60);
      }

      ctx.fillStyle = '#4b5563';
      ctx.font = '14px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`MAX COMBO ${state.maxCombo}`, CANVAS_W - 20, CANVAS_H - 20);

      this.drawGauge(state.gauge);
    }

    if (state.status === 'finished') {
      this.drawResult(state);
    } else if (this.prevStatus === 'finished') {
      // Leaving the result scene — clear the start anchor so the
      // next play's reveal animation runs from the start.
      this.resultCanvas.start(performance.now());
    }
    this.prevStatus = state.status;
  }

  /**
   * Result screen — delegated to `ResultCanvas` (08.Result port).
   *
   * The renderer detects the playing → finished transition and tells
   * the sub-canvas when to anchor its reveal counter; from there the
   * sub-canvas owns asset loading, layout, and animation. Painted
   * inside the same dim-curtain envelope the previous in-renderer
   * draw used so the transition feels identical even when the
   * 8_x and ScreenResult x assets are absent.
   */
  private drawResult(state: RenderState): void {
    const now = performance.now();

    // Anchor reveal counter on the playing → finished edge so a fresh
    // play starts the rank slot-machine from frame 0.
    if (this.prevStatus !== 'finished') {
      this.resultCanvas.start(now);
    }

    const ctx = this.ctx;
    const age = state.finishedAtMs !== null ? now - state.finishedAtMs : 0;
    const alpha = linearFadeIn(age, 400);
    ctx.save();
    ctx.globalAlpha = alpha;

    // Dim curtain over the in-play scene — kept here (not in
    // ResultCanvas) so the result paint stays a pure overlay and a
    // future "render straight onto 8_background.jpg" path doesn't
    // need to special-case curtain removal.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    this.resultCanvas.paint(
      ctx,
      {
        rank: state.rank,
        excellent: state.excellent,
        fullCombo: state.fullCombo,
        score: state.score,
        achievementRate: state.achievementRate,
        maxCombo: state.maxCombo,
        totalNotes: state.totalNotes,
        counts: state.counts,
        titleLine: state.titleLine,
        // newRecord wiring lives in Game; until that lands the
        // badge stays hidden so we don't show a misleading flag.
        newRecord: false,
        inXR: state.inXR,
      },
      now
    );

    ctx.restore();
  }

  private drawJudgmentFlash(state: RenderState): void {
    if (!state.judgmentFlash) return;
    const ctx = this.ctx;
    const age = state.songTimeMs - state.judgmentFlash.spawnedMs;
    const life = 400;
    if (age < 0 || age > life) return;
    const lane = LANE_LAYOUT.find((l) => l.lane === state.judgmentFlash!.lane);
    if (!lane) return;
    const alpha = linearFadeOut(age, life);
    const floatUp = linearFadeIn(age, life) * 20;
    const y = this.judgeLineY + 36 - floatUp;

    const judgment = state.judgmentFlash.judgment;
    const row = judgment !== undefined ? JUDGE_ROWS[judgment] : undefined;
    if (this.judgeImage && this.judgeImage.complete && row) {
      // Sprite path: draw the PERFECT / GREAT / etc. image + optional tint
      // overlay. Sprite is 128×42 in the atlas; we render ~110 px wide.
      const destW = 110;
      const destH = destW * (JUDGE_SPRITE_H / JUDGE_SPRITE_W);
      const dx = lane.x + lane.width / 2 - destW / 2;
      const dy = y - destH;
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        this.judgeImage,
        0, row.sy, JUDGE_SPRITE_W, JUDGE_SPRITE_H,
        dx, dy, destW, destH
      );
      if (row.tint) {
        // Cheap tint: "multiply"-ish using source-atop.
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = row.tint;
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillRect(dx, dy, destW, destH);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      return;
    }

    // Fallback text if the skin didn't load.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = state.judgmentFlash.color;
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(state.judgmentFlash.text, lane.x + lane.width / 2, y);
    ctx.globalAlpha = 1;
    this.drawFastSlowLabel(state, lane, y, alpha);
  }

  /**
   * Pinned-top toast band for mid-play feedback ("Loop A: measure 8",
   * etc.). Painted onto the HUD canvas so it's visible on both the
   * desktop ortho quad AND the VR floating playfield panel (a DOM
   * overlay would be invisible inside an immersive WebXR session).
   *
   * Fades out over the last 250 ms of its lifetime. Expired toasts
   * auto-clear inside `activeToast()` so we don't double-check here.
   */
  private drawToast(state: RenderState): void {
    const toast = state.toast;
    if (!toast) return;
    const now = performance.now();
    const remaining = toast.expiresAtMs - now;
    if (remaining <= 0) return;
    const fadeMs = 250;
    const alpha = remaining >= fadeMs ? 1 : Math.max(0, remaining / fadeMs);

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const padX = 24;
    const padY = 14;
    const textWidth = ctx.measureText(toast.text).width;
    const boxW = textWidth + padX * 2;
    const boxH = 40;
    const boxX = Math.round((CANVAS_W - boxW) / 2);
    const boxY = 28;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = 'rgba(80, 120, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Rounded rectangle (no Path2D.roundRect fallback needed — all
    // supported browsers have it, but the manual path keeps us safe
    // on older WebView builds Quest Browser sometimes lags on).
    const r = 6;
    ctx.moveTo(boxX + r, boxY);
    ctx.lineTo(boxX + boxW - r, boxY);
    ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
    ctx.lineTo(boxX + boxW, boxY + boxH - r);
    ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
    ctx.lineTo(boxX + r, boxY + boxH);
    ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
    ctx.lineTo(boxX, boxY + r);
    ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.fillText(toast.text, CANVAS_W / 2, boxY + padY + 12);
    ctx.restore();
  }

  /**
   * Paint a compact "FAST" / "SLOW" tag above the judgment text when
   * the hit was outside the symmetric dead-band. Applies to both the
   * sprite path and the text fallback — called at the end of
   * drawJudgmentFlash so it always sits on top.
   */
  private drawFastSlowLabel(
    state: RenderState,
    lane: LaneSpec,
    y: number,
    alpha: number
  ): void {
    if (!this.showFastSlow) return;
    const flash = state.judgmentFlash;
    if (!flash || flash.deltaMs === undefined) return;
    const absDelta = Math.abs(flash.deltaMs);
    if (absDelta <= this.fastSlowDeadMs) return;
    const early = flash.deltaMs < 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = early ? '#7dd3fc' : '#f87171';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(early ? 'FAST' : 'SLOW', lane.x + lane.width / 2, y - 58);
    ctx.restore();
  }

  private drawGauge(value: number): void {
    const ctx = this.ctx;
    const frame = this.gaugeFrameImage;
    const bar = this.gaugeBarImage;
    const clamped = Math.max(0, Math.min(1, value));
    // Place the gauge at the HUD's lower-left, under the progress bar. The
    // original DTXMania position (X=314, Y=37) is tuned for 1280×720.
    const gx = 20;
    const gy = CANVAS_H - 60;

    if (frame && frame.complete) {
      const fw = frame.naturalWidth;
      const fh = frame.naturalHeight;
      // DTXMania stacks two variants vertically (y=0..47 and 47..94). We want
      // the top half only, scaled to ~380 px wide.
      const destW = 380;
      const rowH = fh / 2;
      const destH = destW * (rowH / fw);
      // Bar first so the frame overlays it.
      if (bar && bar.complete) {
        const bw = bar.naturalWidth;
        const bh = bar.naturalHeight;
        const barDestW = destW - 36; // matches DTXMania's 63 px trim, scaled
        const barDestH = destH - 10;
        const barDX = gx + 18;
        const barDY = gy + 5;
        ctx.drawImage(
          bar,
          0, 0, bw, bh,
          barDX, barDY, barDestW * clamped, barDestH
        );
      } else {
        // Fallback: solid fill bar.
        ctx.fillStyle = clamped > 0.3 ? '#4ade80' : '#f97316';
        ctx.fillRect(gx + 18, gy + 5, (destW - 36) * clamped, destH - 10);
      }
      ctx.drawImage(frame, 0, 0, fw, rowH, gx, gy, destW, destH);
    } else {
      // Fallback: bare colour bar.
      const w = 300, h = 14;
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(gx, gy, w, h);
      ctx.fillStyle = clamped > 0.3 ? '#4ade80' : '#f97316';
      ctx.fillRect(gx, gy, w * clamped, h);
      ctx.fillStyle = '#9ca3af';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`GAUGE ${Math.round(clamped * 100)}%`, gx, gy - 4);
    }
  }

  dispose(): void {
    this.webgl.setAnimationLoop(null);
    this.webgl.dispose();
  }
}
