import * as THREE from 'three';
import type { BoxNode, ChartEntry, SongEntry } from '@dtxmania/dtx-core';
import {
  findButtonAtPoint,
  stepStickAxis,
  type StickAxisState,
} from './song-select-input.js';
import {
  buildBreadcrumbPath,
  buildDisplayEntries,
  cycleDifficultySlot,
  cycleFocus,
  DIFFICULTY_SLOT_LABELS,
  findBoxByPath,
  formatBestRecordLine,
  lampTier,
  pickChartForSlot,
  pickRandomSongIn,
  rowTitle,
  type DisplayEntry,
} from './song-wheel-model.js';
import {
  ARTIST_RIGHT_EDGE,
  ARTIST_Y,
  COMMENT_BAR_X,
  COMMENT_BAR_Y,
  FOOTER_CALIB_X,
  FOOTER_CONFIG_X,
  FOOTER_EXIT_H,
  FOOTER_EXIT_W,
  FOOTER_EXIT_X,
  FOOTER_EXIT_Y,
  FOOTER_HINT_BASELINE_Y,
  FOOTER_UTIL_BTN_H,
  FOOTER_UTIL_BTN_W,
  FOOTER_UTIL_BTN_Y,
  PANEL_H_PX,
  PANEL_POS_Y,
  PANEL_POS_Z,
  PANEL_W_PX,
  PANEL_WORLD_H,
  PANEL_WORLD_W,
  PREIMAGE_SIZE,
  PREIMAGE_X,
  PREIMAGE_Y,
  SCROLLBAR_H,
  SCROLLBAR_W,
  SCROLLBAR_X,
  SCROLLBAR_Y,
  STATUS_X,
  STATUS_Y,
  WHEEL_BAR_ANCHORS,
  WHEEL_FOCUS_INDEX,
  WHEEL_TITLE_X_OFFSET,
  WHEEL_VISIBLE_BARS,
  SONG_SELECT_FOOTER,
} from './song-select-layout.js';
import { skinUrl } from './skin-url.js';

export { SONG_SELECT_FOOTER };

/**
 * In-VR song-selection panel — DTXmania Stage 05 flavour.
 *
 * Renders a focused-center wheel to a 2D canvas, uploads it as a
 * CanvasTexture onto a floating Three.js plane, and walks the BoxNode
 * tree the scanner produces. Matches the desktop SongWheel's behaviour
 * so a player can move between desktop and headset without relearning.
 *
 * Controls:
 *   Right thumbstick Y         focus up / down (edge-triggered at ±0.5)
 *   Right thumbstick X         cycle difficulty on the focused song
 *   Primary trigger            activate (play song / drill folder / back / random)
 *   Squeeze                    back (same as focusing BACK then activating)
 *   Any laser ray + trigger    still clicks chart buttons + Exit VR
 *
 * DOM overlays aren't visible inside an immersive session, so cover art +
 * status need to be painted onto the same canvas. The host wires an
 * async byte-loader (File System Access / fetch) + the shared preview
 * audio player through callbacks so this class doesn't need to know
 * about backends directly.
 */

const PANEL_POS = new THREE.Vector3(0, PANEL_POS_Y, PANEL_POS_Z);

// Asset filenames pulled out so a typo lands on TypeScript narrowing
// instead of a 404. All loaded through skinUrl() — see vite.config.ts
// for the build-time copy from Runtime/System/Graphics/.
const ASSET_BACKGROUND = '5_background.jpg';

interface ButtonHit {
  /** Canvas rectangle. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** What happens on trigger/click. */
  action:
    | { kind: 'activate'; entryIdx: number }
    | { kind: 'chart'; song: SongEntry; chart: ChartEntry }
    | { kind: 'exit' }
    | { kind: 'calibrate' }
    | { kind: 'config' };
}

export interface SongSelectPick {
  song: SongEntry;
  chart: ChartEntry;
}

/** Callbacks injected by main.ts so the menu can drive preview audio + load
 * cover-art bytes without knowing about the FS backend. */
export interface SongSelectDeps {
  /** Resolve a path relative to the backend's root to raw bytes. */
  loadBytes: (path: string) => Promise<ArrayBuffer>;
  /** Join a folder + relative file path. Same helper as the scanner. */
  joinPath: (folder: string, rel: string) => string;
  /** Called when focus lands on a song — host starts/stops preview audio. */
  onFocusedSong: (song: SongEntry | null) => void;
  /** Player tapped the "Calibrate Latency" button. Host hides the menu
   * and shows the VR calibration panel, then re-shows the menu when
   * calibration completes. Optional — menu simply omits the button if
   * no handler is provided (e.g. tests, early boot before audio is up). */
  onCalibrate?: () => void;
  /** Player tapped the "Settings" button. Host hides the menu, shows
   * the VR config panel, then re-shows the menu when the player closes
   * it. Optional — menu omits the button if no handler is wired. */
  onConfig?: () => void;
}

export class SongSelectCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  private readonly lasers: THREE.Line[] = [];
  private readonly tipMarks: THREE.Mesh[] = [];
  private readonly wasPressed: boolean[] = [false, false];
  private readonly wasSqueezed: boolean[] = [false, false];
  private readonly inputSources: (XRInputSource | null)[] = [null, null];
  /** Per-controller stick edge state. Both sticks do the same job
   * (Y = focus, X = difficulty) so it doesn't matter which hand the
   * player reaches with. Index matches inputSources[0|1]. */
  private readonly stickState: Array<{ x: StickAxisState; y: StickAxisState }> = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  private hits: ButtonHit[] = [];
  private hoveredIdx = -1;

  private root: BoxNode | null = null;
  private currentBox: BoxNode | null = null;
  private entries: DisplayEntry[] = [];
  private focusIdx = 0;
  private preferredSlot = 4;
  /** Breadcrumb persisted across show/hide cycles so re-opening the
   * menu (after a song / after exit-and-re-enter VR) lands the player
   * back where they were. Stored as path string because the BoxNode
   * reference would be stale after a Rescan or a fresh scan. */
  private persistedBoxPath: string | null = null;
  private persistedFocusIdx = 0;
  private persistedPreferredSlot = 4;
  /** Decoded cover art for the focused song. Cleared when focus moves off
   * a song or onto a song without #PREIMAGE. */
  private coverBitmap: ImageBitmap | null = null;
  /** Latest cover-load request token; stale responses are dropped. */
  private coverRequestId = 0;
  /** Static skin PNGs from Runtime/System/Graphics/. Populated lazily;
   * paint() falls back to procedural drawing for any asset that hasn't
   * loaded yet so the panel is usable before the image set finishes. */
  private skinAssets = new Map<string, HTMLImageElement>();
  private onPick: ((pick: SongSelectPick) => void) | null = null;
  private onExit: (() => void) | null = null;
  private shown = false;

  private readonly raycaster = new THREE.Raycaster();
  /** Controllers the menu attached a laser + listeners to. Populated
   * once in the constructor — re-creating per show() was leaking Line
   * children and event listeners onto the long-lived XR controller
   * Groups. */
  private readonly controllers: THREE.Group[] = [];
  // Three.js exposes its own event types (Object3DEventMap) that don't
  // know about the WebXR 'connected'/'disconnected' string events; we
  // pass listeners through the string-overload of addEventListener and
  // type the saved handlers loosely here so removeEventListener is
  // symmetric.
  private readonly onConnectedHandlers: Array<(event: unknown) => void> = [];
  private readonly onDisconnectedHandlers: Array<() => void> = [];

  /** Supplied at show() time so the Game class doesn't need to know about
   * backends at construction. Cleared on hide. */
  private deps: SongSelectDeps | null = null;

  constructor(
    private readonly webgl: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W_PX;
    this.canvas.height = PANEL_H_PX;
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('SongSelectCanvas: 2D context unavailable');
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

    void this.loadSkinAssets();

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
      // scene.add is idempotent; XrControllers may also add this same
      // controller when its drum kit starts. We don't scene.remove on
      // hide/dispose because XrControllers owns controller lifetime.
      this.scene.add(controller);
      this.controllers.push(controller);
      this.lasers.push(line);
      this.onConnectedHandlers.push(onConnected);
      this.onDisconnectedHandlers.push(onDisconnected);

      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffeb3b })
      );
      tip.visible = false;
      this.scene.add(tip);
      this.tipMarks.push(tip);
    }
  }

  show(
    root: BoxNode,
    onPick: (pick: SongSelectPick) => void,
    onExit: () => void,
    deps: SongSelectDeps
  ): void {
    this.root = root;
    // Try to restore the box the player was last browsing. Path match
    // works across scan refreshes (BoxNode identity changes but path
    // stays stable for unchanged folders); falls back to root on miss.
    const resumeBox =
      this.persistedBoxPath !== null
        ? findBoxByPath(root, this.persistedBoxPath)
        : null;
    this.currentBox = resumeBox ?? root;
    this.preferredSlot = this.persistedPreferredSlot;
    this.rebuildEntries();
    // Clamp the remembered focus index against the current entry list —
    // the folder might have fewer songs after a re-scan, or the user
    // might have hopped sort modes (desktop-only; harmless for VR).
    this.focusIdx = resumeBox
      ? Math.min(Math.max(0, this.persistedFocusIdx), Math.max(0, this.entries.length - 1))
      : 0;
    this.onPick = onPick;
    this.onExit = onExit;
    this.deps = deps;
    this.hoveredIdx = -1;
    this.shown = true;
    this.mesh.visible = true;
    for (const l of this.lasers) l.visible = true;

    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  hide(): void {
    // Capture browse state for the next show(). Ignoring stores while
    // hidden means repeated hide() calls don't clobber the real spot.
    if (this.shown && this.currentBox) {
      this.persistedBoxPath = this.currentBox.path;
      this.persistedFocusIdx = this.focusIdx;
      this.persistedPreferredSlot = this.preferredSlot;
    }
    this.shown = false;
    this.mesh.visible = false;
    for (const l of this.lasers) l.visible = false;
    for (const t of this.tipMarks) t.visible = false;
    this.deps?.onFocusedSong(null);
    this.deps = null;
  }

  /** Test-only: fire the action of whichever button's rect covers
   * (px, py) on the panel canvas. Mirrors what tick() does once it
   * projects a controller ray into panel UV space — same code path
   * reached from a unit test without standing up an XRSession. */
  __testClickAt(px: number, py: number): boolean {
    const hit = this.hits.find(
      (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h,
    );
    if (!hit) return false;
    this.invokeHit(hit);
    return true;
  }

  /** Test-only: snapshot of the current button hit-rects. */
  __testHits(): ReadonlyArray<{
    x: number;
    y: number;
    w: number;
    h: number;
    kind: string;
  }> {
    return this.hits.map(({ x, y, w, h, action }) => ({
      x,
      y,
      w,
      h,
      kind: action.kind,
    }));
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
    for (const t of this.tipMarks) {
      this.scene.remove(t);
      t.geometry.dispose();
      if (Array.isArray(t.material)) t.material.forEach((m) => m.dispose());
      else t.material.dispose();
    }
    this.scene.remove(this.mesh);
    this.lasers.length = 0;
    this.tipMarks.length = 0;
    this.controllers.length = 0;
    this.onConnectedHandlers.length = 0;
    this.onDisconnectedHandlers.length = 0;
    this.texture.dispose();
  }

  /** Per-frame: poll laser rays (hover feedback + clickable buttons),
   * right-hand thumbstick (focus / difficulty), trigger + squeeze (activate
   * + back). Cheap no-op when the menu is hidden. */
  tick(): void {
    if (!this.shown) return;
    const session = this.webgl.xr.getSession();
    if (!session) return;

    // Hover + ray-cast trigger-click
    let hovered = -1;
    for (let i = 0; i < 2; i++) {
      const controller = this.webgl.xr.getController(i);
      const laser = this.lasers[i];
      const tipMark = this.tipMarks[i];
      if (!laser || !tipMark) continue;

      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3(0, 0, -1);
      controller.getWorldPosition(origin);
      direction.applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
      this.raycaster.set(origin, direction);
      const hitsRay = this.raycaster.intersectObject(this.mesh, false);

      let rayHitIdx = -1;
      if (hitsRay.length > 0) {
        const hit = hitsRay[0]!;
        tipMark.visible = true;
        tipMark.position.copy(hit.point);
        const uv = hit.uv;
        if (uv) {
          const px = uv.x * PANEL_W_PX;
          const py = (1 - uv.y) * PANEL_H_PX;
          rayHitIdx = findButtonAtPoint(this.hits, px, py);
          if (rayHitIdx >= 0 && hovered === -1) hovered = rayHitIdx;
        }
      } else {
        tipMark.visible = false;
      }

      const src = this.inputSources[i];
      const pressed = src?.gamepad?.buttons[0]?.pressed ?? false;
      const squeezed = src?.gamepad?.buttons[1]?.pressed ?? false;
      if (pressed && !this.wasPressed[i]) {
        if (rayHitIdx >= 0) {
          this.invokeHit(this.hits[rayHitIdx]!);
        } else {
          this.activateFocused();
        }
      }
      if (squeezed && !this.wasSqueezed[i]) {
        this.goBack();
      }
      this.wasPressed[i] = pressed;
      this.wasSqueezed[i] = squeezed;
    }

    if (hovered !== this.hoveredIdx) {
      this.hoveredIdx = hovered;
      this.paint();
    }

    // Both sticks drive Y=focus, X=difficulty. Symmetric because Quest
    // folder depth is shallow and an X-axis enter/back mapping turned out
    // to conflict with difficulty cycling (players bumping their stick
    // sideways while aiming up/down would commit a chart). Back is still
    // available via the squeeze button and the BACK entry in the wheel.
    for (let i = 0; i < 2; i++) {
      const src = this.inputSources[i];
      if (!src) continue;
      const axes = src.gamepad?.axes;
      if (!axes) continue;
      // Quest layout: axes[2]=X, axes[3]=Y. Fall back to [0]/[1] for
      // controllers that expose only the legacy trackpad pair.
      const sx = axes[2] ?? axes[0] ?? 0;
      const sy = axes[3] ?? axes[1] ?? 0;
      const st = this.stickState[i]!;

      const yStep = stepStickAxis(sy, st.y);
      st.y = yStep.next;
      if (yStep.fired !== 0) this.moveFocus(yStep.fired);

      const xStep = stepStickAxis(sx, st.x);
      st.x = xStep.next;
      if (xStep.fired !== 0) this.cycleDifficulty(xStep.fired);
    }
  }

  private moveFocus(delta: number): void {
    if (this.entries.length === 0) return;
    this.focusIdx = cycleFocus(this.focusIdx, this.entries.length, delta);
    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  private cycleDifficulty(delta: number): void {
    const song = this.focusedSong();
    if (!song) return;
    this.preferredSlot = cycleDifficultySlot(song, this.preferredSlot, delta);
    this.paint();
  }

  private focusedSong(): SongEntry | null {
    const entry = this.entries[this.focusIdx];
    if (entry?.kind !== 'node') return null;
    return entry.node.type === 'song' ? entry.node.entry : null;
  }

  private chartForPreferred(song: SongEntry): ChartEntry {
    return pickChartForSlot(song, this.preferredSlot);
  }

  private activateFocused(): void {
    const entry = this.entries[this.focusIdx];
    if (!entry) return;
    if (entry.kind === 'back') {
      this.goBack();
      return;
    }
    if (entry.kind === 'random') {
      const song = pickRandomSongIn(entry.box);
      if (song && this.onPick) {
        this.onPick({ song, chart: this.chartForPreferred(song) });
      }
      return;
    }
    const node = entry.node;
    if (node.type === 'box') {
      this.enterBox(node);
      return;
    }
    if (this.onPick) {
      this.onPick({ song: node.entry, chart: this.chartForPreferred(node.entry) });
    }
  }

  private enterBox(box: BoxNode): void {
    this.currentBox = box;
    this.focusIdx = 0;
    this.rebuildEntries();
    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  private goBack(): void {
    const cur = this.currentBox;
    if (!cur || !cur.parent) return;
    const parent = cur.parent;
    this.currentBox = parent;
    this.rebuildEntries();
    const returnIdx = this.entries.findIndex(
      (e) => e.kind === 'node' && e.node.type === 'box' && e.node === cur
    );
    this.focusIdx = returnIdx >= 0 ? returnIdx : 0;
    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  private rebuildEntries(): void {
    // VR menu doesn't expose sort/search controls yet — children appear
    // in scan order (matches the legacy behaviour).
    this.entries = buildDisplayEntries(this.currentBox);
  }

  private invokeHit(hit: ButtonHit): void {
    switch (hit.action.kind) {
      case 'activate':
        // The row-level ray hit: move focus to it and activate.
        this.focusIdx = hit.action.entryIdx;
        this.emitFocusedSong();
        void this.loadCoverForFocused();
        this.activateFocused();
        return;
      case 'chart':
        this.preferredSlot = hit.action.chart.slot;
        if (this.onPick) this.onPick({ song: hit.action.song, chart: hit.action.chart });
        return;
      case 'exit':
        if (this.onExit) this.onExit();
        return;
      case 'calibrate':
        this.deps?.onCalibrate?.();
        return;
      case 'config':
        this.deps?.onConfig?.();
        return;
    }
  }

  private emitFocusedSong(): void {
    this.deps?.onFocusedSong(this.focusedSong());
  }

  private async loadCoverForFocused(): Promise<void> {
    const song = this.focusedSong();
    const myId = ++this.coverRequestId;
    if (!song?.preimage || !this.deps) {
      this.coverBitmap?.close();
      this.coverBitmap = null;
      this.paint();
      return;
    }
    const deps = this.deps;
    const path = deps.joinPath(song.folderPath, song.preimage);
    try {
      const bytes = await deps.loadBytes(path);
      if (myId !== this.coverRequestId) return;
      const blob = new Blob([bytes.slice(0)]);
      const bm = await createImageBitmap(blob);
      if (myId !== this.coverRequestId) {
        bm.close();
        return;
      }
      this.coverBitmap?.close();
      this.coverBitmap = bm;
      this.paint();
    } catch (e) {
      if (myId !== this.coverRequestId) return;
      console.warn('[song-select] cover load failed', path, e);
      this.coverBitmap?.close();
      this.coverBitmap = null;
      this.paint();
    }
  }

  private async loadSkinAssets(): Promise<void> {
    // Pulled out so a single 404 doesn't cascade — paint() copes with
    // any individual asset being absent. Names mirror Runtime/Graphics
    // exactly (including spaces) so the Vite plugin's allow-pattern
    // hits each one. After everything resolves we trigger one paint
    // so the panel jumps to the skinned look without waiting on
    // another show()/focus event.
    const names = [
      ASSET_BACKGROUND,
      '5_bar score.png',
      '5_bar score selected.png',
      '5_bar box.png',
      '5_bar box selected.png',
      '5_bar other.png',
      '5_bar other selected.png',
      '5_preimage panel.png',
      '5_preimage default.png',
      '5_status panel.png',
      '5_difficulty frame.png',
      '5_comment bar.png',
      '5_scrollbar.png',
    ];
    await Promise.all(names.map((name) => this.loadOneAsset(name)));
    if (this.shown) this.paint();
  }

  private loadOneAsset(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.skinAssets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        // Missing asset is non-fatal — the matching paint helper falls
        // back to a procedural rect. Logged once per name so we notice
        // a typo or a build-time copy regression without spamming.
        console.warn('[song-select] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    return this.skinAssets.get(name) ?? null;
  }

  private paint(): void {
    const ctx = this.ctx;
    this.hits = [];

    this.paintBackground();
    this.paintPreimage();
    this.paintStatusPanel();
    this.paintWheel();
    this.paintCommentBar();
    this.paintScrollbar();
    this.paintHeaderAndBreadcrumb();
    this.paintFooter();
    this.paintWipBanner();

    this.texture.needsUpdate = true;
  }

  private paintBackground(): void {
    const ctx = this.ctx;
    const bg = this.getAsset(ASSET_BACKGROUND);
    if (bg) {
      ctx.drawImage(bg, 0, 0, PANEL_W_PX, PANEL_H_PX);
    } else {
      ctx.fillStyle = '#0a0f18';
      ctx.fillRect(0, 0, PANEL_W_PX, PANEL_H_PX);
    }
  }

  private paintHeaderAndBreadcrumb(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Song Library', 40, 32);

    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(
      buildBreadcrumbPath(this.currentBox)
        .map((s) => s.node.name)
        .join('  ›  '),
      40,
      54,
    );
  }

  private paintWheel(): void {
    const ctx = this.ctx;
    if (this.entries.length === 0) {
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '16px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Empty folder.', WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!.x, WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!.y + 30);
      return;
    }
    const n = this.entries.length;
    for (let i = 0; i < WHEEL_VISIBLE_BARS; i++) {
      const offset = i - WHEEL_FOCUS_INDEX;
      const idx = ((this.focusIdx + offset) % n + n) % n;
      const entry = this.entries[idx]!;
      this.paintWheelBar(entry, i, offset === 0, idx);
    }
  }

  private paintWheelBar(
    entry: DisplayEntry,
    barIdx: number,
    focused: boolean,
    entryIdx: number,
  ): void {
    const ctx = this.ctx;
    const anchor = WHEEL_BAR_ANCHORS[barIdx]!;
    const tex = this.getAsset(barTextureName(entry, focused));
    const barW = tex?.width ?? 360;
    const barH = tex?.height ?? 50;

    if (tex) {
      ctx.drawImage(tex, anchor.x, anchor.y);
    } else {
      // Fallback so the wheel still reads if the bar PNG didn't load.
      ctx.fillStyle = focused ? '#3355ff' : '#1e2a55';
      ctx.fillRect(anchor.x, anchor.y, barW, barH);
      ctx.strokeStyle = focused ? '#fbbf24' : '#475569';
      ctx.lineWidth = 1;
      ctx.strokeRect(anchor.x + 0.5, anchor.y + 0.5, barW - 1, barH - 1);
    }

    // Box folders with a #FONTCOLOR from box.def get a coloured left
    // accent bar so the author's chosen palette shows up on focus.
    if (focused && entry.kind === 'node' && entry.node.type === 'box' && entry.node.fontColor) {
      ctx.fillStyle = entry.node.fontColor;
      ctx.fillRect(anchor.x, anchor.y, 4, barH);
    }

    // Whole bar is the laser-click activate target.
    this.hits.push({
      x: anchor.x,
      y: anchor.y,
      w: barW,
      h: barH,
      action: { kind: 'activate', entryIdx },
    });

    const title = rowTitle(entry);
    ctx.textAlign = 'left';
    ctx.fillStyle = focused ? '#fff' : '#e2e8f0';
    ctx.font = focused
      ? 'bold 22px ui-monospace, monospace'
      : '16px ui-monospace, monospace';
    ctx.fillText(title, anchor.x + WHEEL_TITLE_X_OFFSET, anchor.y + barH * 0.62);

    if (!focused) return;
    if (entry.kind !== 'node' || entry.node.type !== 'song') return;

    // Focused song row: chart buttons stack just below the focus bar so
    // the player's instrument-difficulty pick is one click away.
    const song = entry.node.entry;
    const selected = this.chartForPreferred(song);
    const btnH = 32;
    const btnW = 96;
    const btnGap = 6;
    const charts = [...song.charts].sort((a, b) => a.slot - b.slot);
    let btnX = anchor.x + WHEEL_TITLE_X_OFFSET;
    const btnY = anchor.y + barH + 6;
    for (const chart of charts) {
      const isSelected = chart.slot === selected.slot;
      ctx.fillStyle = isSelected ? '#3355ff' : 'rgba(30, 42, 85, 0.85)';
      ctx.fillRect(btnX, btnY, btnW, btnH);
      if (isSelected) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.strokeRect(btnX + 1, btnY + 1, btnW - 2, btnH - 2);
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(chart.label, btnX + btnW / 2, btnY + 14);
      if (chart.drumLevel !== undefined && chart.drumLevel > 0) {
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(`L.${(chart.drumLevel / 100).toFixed(2)}`, btnX + btnW / 2, btnY + 27);
      }
      const lampColor = canvasLampColor(chart);
      if (lampColor) {
        ctx.fillStyle = lampColor;
        ctx.beginPath();
        ctx.arc(btnX + btnW - 6, btnY + 6, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      this.hits.push({
        x: btnX,
        y: btnY,
        w: btnW,
        h: btnH,
        action: { kind: 'chart', song, chart },
      });
      btnX += btnW + btnGap;
    }
    ctx.textAlign = 'left';
  }

  private paintPreimage(): void {
    const ctx = this.ctx;
    const frame = this.getAsset('5_preimage panel.png');
    const fallback = this.getAsset('5_preimage default.png');

    // Frame first (decorative — sits behind the actual image).
    if (frame) {
      ctx.drawImage(frame, PREIMAGE_X - 8, PREIMAGE_Y - 8);
    }
    if (this.coverBitmap) {
      ctx.drawImage(
        this.coverBitmap,
        PREIMAGE_X,
        PREIMAGE_Y,
        PREIMAGE_SIZE,
        PREIMAGE_SIZE,
      );
    } else if (fallback) {
      ctx.drawImage(fallback, PREIMAGE_X, PREIMAGE_Y, PREIMAGE_SIZE, PREIMAGE_SIZE);
    } else {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.fillRect(PREIMAGE_X, PREIMAGE_Y, PREIMAGE_SIZE, PREIMAGE_SIZE);
      ctx.fillStyle = '#334155';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        '(no cover)',
        PREIMAGE_X + PREIMAGE_SIZE / 2,
        PREIMAGE_Y + PREIMAGE_SIZE / 2,
      );
      ctx.textAlign = 'left';
    }
  }

  private paintStatusPanel(): void {
    const ctx = this.ctx;
    const body = this.getAsset('5_status panel.png');
    if (body) {
      ctx.drawImage(body, STATUS_X, STATUS_Y);
    } else {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
      ctx.fillRect(STATUS_X, STATUS_Y, 380, 320);
    }

    const song = this.focusedSong();
    if (!song) {
      drawWipLabel(ctx, '(focus a song)', STATUS_X + 20, STATUS_Y + 30);
      return;
    }

    // 5 difficulties × 3 instruments grid. Geometry mirrors C# Stage 05
    // (`5_difficulty frame.png` cells, y-baseline = 391 + (4-i)*60 - 2),
    // but most data slots are still wired to the per-row drum-level
    // only — Guitar/Bass + skill % stay [WIP] until the chart layer
    // exposes them.
    const slotsUsed = new Map<number, ChartEntry>();
    for (const c of song.charts) slotsUsed.set(c.slot, c);
    const selected = this.chartForPreferred(song);
    const frame = this.getAsset('5_difficulty frame.png');
    const cellW = frame?.width ?? 110;
    const cellH = frame?.height ?? 56;
    const PARTS = ['DR', 'GT', 'BS'] as const;
    for (let i = 0; i < 5; i++) {
      const cellY = STATUS_Y + 41 + (4 - i) * 60 - 2;
      for (let p = 0; p < PARTS.length; p++) {
        const cellX = STATUS_X + 5 + p * (cellW + 4);
        if (frame) {
          ctx.drawImage(frame, cellX, cellY);
        } else {
          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 1;
          ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellW - 1, cellH - 1);
        }
        const chart = p === 0 ? slotsUsed.get(i) : undefined;
        const isSelected = chart !== undefined && chart.slot === selected.slot;
        if (isSelected) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
          ctx.fillRect(cellX, cellY, cellW, cellH);
        }
        ctx.fillStyle = chart ? '#fff' : '#475569';
        ctx.font = 'bold 13px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(PARTS[p]!, cellX + 6, cellY + 16);
        if (p === 0 && chart?.drumLevel !== undefined && chart.drumLevel > 0) {
          ctx.font = 'bold 18px ui-monospace, monospace';
          ctx.fillStyle = '#fde047';
          ctx.textAlign = 'right';
          ctx.fillText(
            (chart.drumLevel / 100).toFixed(2),
            cellX + cellW - 6,
            cellY + cellH - 8,
          );
        } else if (p > 0 && chart) {
          drawWipLabel(ctx, '[WIP]', cellX + 6, cellY + cellH - 6);
        }
      }
    }

    // BPM block under the grid (canonical position 32, 258 sits under
    // the skill point area; we render under the panel for now and tag
    // [WIP] until the panel-internal layout is completed).
    const bpm = song.bpm ? Math.round(song.bpm).toString() : '—';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`BPM ${bpm}`, STATUS_X + 8, STATUS_Y + 312);

    drawWipLabel(ctx, '[WIP] skill % / gauge / perf history', STATUS_X + 8, STATUS_Y + 336);
  }

  private paintCommentBar(): void {
    const ctx = this.ctx;
    const song = this.focusedSong();
    const bar = this.getAsset('5_comment bar.png');
    if (bar) {
      ctx.drawImage(bar, COMMENT_BAR_X, COMMENT_BAR_Y);
    }
    // Artist name (right-aligned at the canonical position).
    if (song?.artist) {
      ctx.font = '20px ui-monospace, monospace';
      ctx.fillStyle = '#fde047';
      ctx.textAlign = 'right';
      ctx.fillText(song.artist, ARTIST_RIGHT_EDGE, ARTIST_Y);
    }
    // Comment text — scrolling animation is [WIP] until C3.
    if (song?.comment) {
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(truncate(song.comment, 70), COMMENT_BAR_X + 123, COMMENT_BAR_Y + 82);
    } else {
      drawWipLabel(ctx, '[WIP] comment scroll', COMMENT_BAR_X + 123, COMMENT_BAR_Y + 82);
    }
  }

  private paintScrollbar(): void {
    const ctx = this.ctx;
    const tex = this.getAsset('5_scrollbar.png');
    if (tex) {
      ctx.drawImage(tex, SCROLLBAR_X, SCROLLBAR_Y);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(SCROLLBAR_X, SCROLLBAR_Y, SCROLLBAR_W, SCROLLBAR_H);
    }
    // Thumb position: focusIdx / entries.length × track height.
    if (this.entries.length > 0) {
      const ratio = this.focusIdx / this.entries.length;
      const thumbY = SCROLLBAR_Y + Math.round(ratio * (SCROLLBAR_H - 12));
      ctx.fillStyle = '#fde047';
      ctx.fillRect(SCROLLBAR_X, thumbY, SCROLLBAR_W, 12);
    }
  }

  private paintFooter(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      'Stick: ↕ browse  · ↔ difficulty    ·    Trigger: play / enter    ·    Squeeze: back',
      40,
      FOOTER_HINT_BASELINE_Y,
    );

    // Exit VR
    const hovered =
      this.hoveredIdx >= 0 && this.hits[this.hoveredIdx]?.action.kind === 'exit';
    ctx.fillStyle = hovered ? '#dc2626' : '#374151';
    ctx.fillRect(FOOTER_EXIT_X, FOOTER_EXIT_Y, FOOTER_EXIT_W, FOOTER_EXIT_H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Exit VR',
      FOOTER_EXIT_X + FOOTER_EXIT_W / 2,
      FOOTER_EXIT_Y + FOOTER_EXIT_H / 2 + 6,
    );
    this.hits.push({
      x: FOOTER_EXIT_X,
      y: FOOTER_EXIT_Y,
      w: FOOTER_EXIT_W,
      h: FOOTER_EXIT_H,
      action: { kind: 'exit' },
    });

    if (this.deps?.onConfig) {
      this.paintUtilityButton('Settings', FOOTER_CONFIG_X, 'config');
    }
    if (this.deps?.onCalibrate) {
      const x = this.deps?.onConfig ? FOOTER_CALIB_X : FOOTER_CONFIG_X;
      this.paintUtilityButton('Calibrate Latency', x, 'calibrate');
    }
  }

  private paintUtilityButton(
    label: string,
    x: number,
    actionKind: 'config' | 'calibrate',
  ): void {
    const ctx = this.ctx;
    const hovered =
      this.hoveredIdx >= 0 && this.hits[this.hoveredIdx]?.action.kind === actionKind;
    ctx.fillStyle = hovered ? '#2563eb' : '#1e293b';
    ctx.fillRect(x, FOOTER_UTIL_BTN_Y, FOOTER_UTIL_BTN_W, FOOTER_UTIL_BTN_H);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      x + 0.5,
      FOOTER_UTIL_BTN_Y + 0.5,
      FOOTER_UTIL_BTN_W - 1,
      FOOTER_UTIL_BTN_H - 1,
    );
    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      label,
      x + FOOTER_UTIL_BTN_W / 2,
      FOOTER_UTIL_BTN_Y + FOOTER_UTIL_BTN_H / 2 + 5,
    );
    this.hits.push({
      x,
      y: FOOTER_UTIL_BTN_Y,
      w: FOOTER_UTIL_BTN_W,
      h: FOOTER_UTIL_BTN_H,
      action: { kind: actionKind },
    });
  }

  private paintWipBanner(): void {
    const ctx = this.ctx;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(
      'Song Select · WIP — aligning to DTXMania design',
      PANEL_W_PX - 20,
      24,
    );
  }
}

/** Picks the bar texture filename for a wheel entry, distinguishing
 * Score (regular songs), Box (sub-folders / BACKBOX), and Other
 * (RANDOM, etc.). Mirrors `EBarType` in `CActSelectSongList`. */
function barTextureName(entry: DisplayEntry, focused: boolean): string {
  const suffix = focused ? ' selected' : '';
  if (entry.kind === 'node' && entry.node.type === 'song') {
    return `5_bar score${suffix}.png`;
  }
  if (entry.kind === 'node' && entry.node.type === 'box') {
    return `5_bar box${suffix}.png`;
  }
  return `5_bar other${suffix}.png`;
}

function drawWipLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y);
  ctx.restore();
}

/** Canvas palette for lamp dots. Matches the DOM palette except the
 * "played" tier is a lighter slate (canvas background is darker than the
 * DOM button background, so the dot needs more contrast). */
function canvasLampColor(chart: ChartEntry): string | null {
  const tier = lampTier(chart);
  if (tier === null) return null;
  if (tier === 'excellent') return '#fde047';
  if (tier === 'fullCombo') return '#7dd3fc';
  return '#94a3b8';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
