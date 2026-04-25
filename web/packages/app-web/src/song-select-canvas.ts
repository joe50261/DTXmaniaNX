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
  findBoxByPath,
  pickChartForSlot,
  pickRandomSongIn,
  rowTitle,
  SORT_MODES,
  type DisplayEntry,
  type SortMode,
} from './song-wheel-model.js';
import {
  ARTIST_RIGHT_EDGE,
  ARTIST_Y,
  COMMENT_BAR_X,
  COMMENT_BAR_Y,
  COMMENT_CLIP_H_PX,
  COMMENT_CLIP_W_PX,
  COMMENT_TEXT_OFFSET_X,
  COMMENT_TEXT_OFFSET_Y,
  FOOTER_CALIB_X,
  FOOTER_CONFIG_X,
  FOOTER_EXIT_H,
  FOOTER_EXIT_W,
  FOOTER_EXIT_X,
  FOOTER_EXIT_Y,
  FOOTER_HINT_BASELINE_Y,
  FOOTER_SORT_X,
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
  type BarAnchor,
} from './song-select-layout.js';
import {
  COMMENT_SCROLL_GAP_PX,
  PREIMAGE_FADE_MS,
  lerp,
  newCommentScrollState,
  newPreimageFadeState,
  newWheelScrollState,
  preimageOpacity,
  restartCommentScroll,
  restartPreimageFade,
  startWheelScroll,
  tickCommentScroll,
  tickPreimageFade,
  tickWheelScroll,
  wheelScrollProgress,
  type CommentScrollState,
  type PreimageFadeState,
  type WheelScrollState,
} from './song-select-animations.js';
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
    | { kind: 'sort' }
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
  /** Sort mode passed to `buildDisplayEntries`. Persisted across
   * show/hide cycles so a desktop player picking a sort sticks to it
   * after a Rescan. The VR panel never changes this — no headset UI
   * for sort selection — but the field is wired so a future controller
   * gesture can drive it. */
  private sortMode: SortMode = 'title';
  /** Lower-cased substring filter. Same persistence reasoning as
   * `sortMode`. Empty string = no filter. */
  private searchQuery = '';
  /** Desktop driver flips this on so the footer (Settings / Calibrate /
   * Exit VR) and the input-hint string are skipped — the desktop overlay
   * already exposes those controls in DOM, and "Exit VR" is meaningless
   * outside an XR session. Default false preserves the VR layout. */
  private desktopMode = false;
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

  // ---- Animation state (C# Stage 05 parity) ----
  /** performance.now() of the previous tick(), or null if we haven't
   * ticked yet this show() — animations are paused while hidden so dt
   * doesn't include the time the panel was off-screen. */
  private lastTickMs: number | null = null;
  /** Wheel scroll easing — ticks down after a single-step focus change
   * so the bars look like they slid into place rather than teleporting. */
  private wheelScroll: WheelScrollState = newWheelScrollState();
  /** Preimage fade-in — restarts whenever the focused song changes. */
  private preimageFade: PreimageFadeState = newPreimageFadeState();
  /** Horizontal scroll on the focused song's #COMMENT text. Only
   * advances when the rendered width exceeds the bar's clip width. */
  private commentScroll: CommentScrollState = newCommentScrollState();
  /** Cached comment text width measured the last time we painted, so
   * tick() can decide whether to advance the scroll without re-running
   * measureText every frame. Cleared when the focused song changes. */
  private commentTextWidthPx = 0;

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

    // Reset all animation state — show() can land on any song (resumed
    // breadcrumb position) and we want the fade/scroll to play from
    // their start points the first time the player sees the panel.
    this.lastTickMs = null;
    this.wheelScroll = newWheelScrollState();
    this.preimageFade = restartPreimageFade();
    this.commentScroll = restartCommentScroll();
    this.commentTextWidthPx = 0;

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

  /** Update the library tree without going through show()/hide(). Used
   * by the desktop driver when a Rescan finishes mid-browse so the wheel
   * can refresh in place. Preserves the player's breadcrumb/focus when
   * possible (path-match) and clamps the focus index against the new
   * entry count. */
  setRoot(root: BoxNode | null): void {
    this.root = root;
    if (!root) {
      this.currentBox = null;
      this.entries = [];
      this.focusIdx = 0;
      if (this.shown) this.paint();
      return;
    }
    const resumeBox =
      this.persistedBoxPath !== null ? findBoxByPath(root, this.persistedBoxPath) : null;
    this.currentBox = resumeBox ?? root;
    this.rebuildEntries();
    this.focusIdx = resumeBox
      ? Math.min(Math.max(0, this.persistedFocusIdx), Math.max(0, this.entries.length - 1))
      : 0;
    if (this.shown) {
      this.emitFocusedSong();
      void this.loadCoverForFocused();
      this.paint();
    }
  }

  getSortMode(): SortMode {
    return this.sortMode;
  }

  setSortMode(mode: SortMode): void {
    if (mode === this.sortMode) return;
    this.sortMode = mode;
    this.rebuildEntriesPreservingFocus();
  }

  /** Advance to the next sort mode in `SORT_MODES` and return it.
   * Same shape as DOM SongWheel.cycleSortMode so callers can hand the
   * returned value straight to their UI label. */
  cycleSortMode(): SortMode {
    const idx = SORT_MODES.indexOf(this.sortMode);
    const next = SORT_MODES[(idx + 1) % SORT_MODES.length]!;
    this.setSortMode(next);
    return next;
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  /** Apply a substring filter to the current box. Empty / whitespace
   * disables filtering. Trims + lower-cases internally so callers can
   * pipe a raw `<input>` value in. */
  setSearchQuery(query: string): void {
    const normalized = query.trim().toLowerCase();
    if (normalized === this.searchQuery) return;
    this.searchQuery = normalized;
    this.rebuildEntriesPreservingFocus();
  }

  /** Shared helper for sort/search updates: rebuild entries, keep
   * focused song under the cursor where possible (since the entry order
   * may have shifted), emit focus + repaint. */
  private rebuildEntriesPreservingFocus(): void {
    const prevFocused = this.focusedSong();
    this.rebuildEntries();
    if (prevFocused) {
      const newIdx = this.entries.findIndex(
        (e) => e.kind === 'node' && e.node.type === 'song' && e.node.entry === prevFocused,
      );
      this.focusIdx = newIdx >= 0 ? newIdx : 0;
    } else {
      this.focusIdx = 0;
    }
    if (this.shown) {
      this.emitFocusedSong();
      void this.loadCoverForFocused();
      this.paint();
    }
  }

  /** The underlying 2D canvas element. Exposed so the desktop driver
   * can mount it into the DOM where the legacy DOM SongWheel used to
   * live; in VR the same canvas backs a Three.js CanvasTexture, which
   * works simultaneously without contention. */
  getCanvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Switch the canvas's footer rendering: desktop mode hides the VR
   * footer (Settings / Calibrate / Exit VR + the stick/trigger hint
   * line), since the desktop overlay already exposes those controls
   * in DOM. The wheel, status panel, preimage, comment bar, and
   * scrollbar are unchanged. Default is VR mode. */
  setDesktopMode(enabled: boolean): void {
    if (enabled === this.desktopMode) return;
    this.desktopMode = enabled;
    if (this.shown) this.paint();
  }

  /** Desktop keyboard handler. Returns `true` when the event was
   * consumed so the caller can `preventDefault()` accordingly. Mirrors
   * the legacy `SongWheel.handleKey` semantics: arrows for focus and
   * difficulty, Enter/Space to activate, Escape to back. */
  dispatchKey(e: KeyboardEvent): boolean {
    if (!this.shown) return false;
    switch (e.key) {
      case 'ArrowUp':
        this.moveFocus(-1);
        return true;
      case 'ArrowDown':
        this.moveFocus(1);
        return true;
      case 'ArrowLeft':
        this.cycleDifficulty(-1);
        return true;
      case 'ArrowRight':
        this.cycleDifficulty(1);
        return true;
      case 'Enter':
      case ' ':
        this.activateFocused();
        return true;
      case 'Escape':
        this.goBack();
        return true;
      default:
        return false;
    }
  }

  /** Desktop pointer-move (mouse hover). Coordinates are in the
   * canvas's logical 1280×720 space — the caller scales `clientX/Y`
   * against the rendered element size before passing in. */
  dispatchPointerMove(px: number, py: number): void {
    if (!this.shown) return;
    const next = findButtonAtPoint(this.hits, px, py);
    if (next === this.hoveredIdx) return;
    this.hoveredIdx = next;
    this.paint();
  }

  /** Desktop pointer-down (click). Returns `true` if the click landed
   * on a hit-rect.
   *
   * Wheel-row hits use a "click to focus, click again to activate"
   * pattern — see `applyHitWithFocusJump`. Footer hits fire
   * immediately. The XR trigger path goes through the same helper so
   * the two input surfaces never disagree. */
  dispatchPointerDown(px: number, py: number): boolean {
    if (!this.shown) return false;
    const idx = findButtonAtPoint(this.hits, px, py);
    if (idx < 0) return false;
    this.applyHitWithFocusJump(this.hits[idx]!);
    return true;
  }

  /** Shared between the desktop pointer click and the XR trigger
   * pull. When the hit is a wheel row that's NOT currently focused,
   * we move focus only — the second click/trigger on the
   * already-focused row activates. Footer / sort / exit hits fire on
   * the first press regardless.
   *
   * Without this both surfaces had a "point-and-shoot" feel where the
   * tiniest aim-and-trigger jumped the player into a chart they
   * weren't looking at. The two-step pattern matches the long-
   * standing DOM SongWheel behaviour. */
  private applyHitWithFocusJump(hit: ButtonHit): void {
    if (hit.action.kind === 'activate' && hit.action.entryIdx !== this.focusIdx) {
      const delta = hit.action.entryIdx - this.focusIdx;
      this.focusIdx = hit.action.entryIdx;
      this.wheelScroll = startWheelScroll(
        this.wheelScroll,
        Math.abs(delta) === 1 ? (delta > 0 ? 1 : -1) : 0,
      );
      this.onFocusedSongChanged();
      void this.loadCoverForFocused();
      this.paint();
      return;
    }
    this.invokeHit(hit);
  }

  /** Test-only: fire the action of whichever button's rect covers
   * (px, py) on the panel canvas. Routes through the same
   * focus-jump/activate helper the desktop pointer click and the XR
   * trigger pull both use, so a test exercises the production
   * semantics rather than a stripped-down shortcut. */
  __testClickAt(px: number, py: number): boolean {
    const hit = this.hits.find(
      (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h,
    );
    if (!hit) return false;
    this.applyHitWithFocusJump(hit);
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
   * + back). Animation timers run on every shown frame so the desktop
   * driver's render loop sees the same fade/scroll behaviour as VR.
   * Cheap no-op when the menu is hidden. */
  tick(): void {
    if (!this.shown) return;

    // Animation timers run once per tick regardless of XR — the desktop
    // driver appends this canvas to the DOM and relies on the same
    // RAF-driven tick to advance fade/scroll/wheel-slide.
    const now = performance.now();
    const dtMs = this.lastTickMs === null ? 0 : Math.max(0, now - this.lastTickMs);
    this.lastTickMs = now;
    if (dtMs > 0) this.advanceAnimations(dtMs);

    const session = this.webgl.xr.getSession();
    if (session) {
      this.tickXr();
    } else if (this.isAnimating()) {
      // Desktop animation-driven repaint. XR path repaints inside
      // tickXr (covers hover changes too).
      this.paint();
    }
  }

  private tickXr(): void {
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
          // Trigger semantics match desktop pointer click: pulling
          // trigger on a non-focused row jumps focus first; the
          // second pull on the same row activates. Footer/sort hits
          // fire immediately. See applyHitWithFocusJump for the why.
          this.applyHitWithFocusJump(this.hits[rayHitIdx]!);
        } else {
          // Free-aim trigger pull (laser missed every rect) just
          // activates the currently focused entry — back-compat with
          // the "trigger anywhere = play this song" muscle memory.
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
    } else if (this.isAnimating()) {
      // Repaint while any timer is running so the wheel slide,
      // preimage fade-in, and comment scroll all visibly advance even
      // when nothing else changed this frame.
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

  private advanceAnimations(dtMs: number): void {
    this.wheelScroll = tickWheelScroll(this.wheelScroll, dtMs);
    this.preimageFade = tickPreimageFade(this.preimageFade, dtMs);
    if (this.commentTextWidthPx > 0) {
      // Clip width matches the rect we draw the comment text into in
      // paintCommentBar. Cached width is set after each paint so this
      // tick already knows whether to scroll.
      this.commentScroll = tickCommentScroll(
        this.commentScroll,
        dtMs,
        this.commentTextWidthPx,
        COMMENT_CLIP_W_PX,
      );
    }
  }

  private isAnimating(): boolean {
    if (this.wheelScroll.dir !== 0) return true;
    if (this.preimageFade.elapsedMs < PREIMAGE_FADE_MS) return true;
    if (this.commentTextWidthPx > COMMENT_CLIP_W_PX) return true;
    return false;
  }

  private moveFocus(delta: number): void {
    if (this.entries.length === 0) return;
    const prev = this.focusIdx;
    this.focusIdx = cycleFocus(this.focusIdx, this.entries.length, delta);
    if (this.focusIdx !== prev) {
      // Animate the slide only on single-step jumps — multi-step (rare,
      // would need Page Up/Down) would visually overshoot one slot.
      const dir: 1 | -1 | 0 = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      this.wheelScroll = startWheelScroll(this.wheelScroll, Math.abs(delta) === 1 ? dir : 0);
      this.onFocusedSongChanged();
    }
    void this.loadCoverForFocused();
    this.paint();
  }

  /** Called whenever the focused entry changes (focus move, enter box,
   * back). Re-emits to host (preview audio) and resets the per-song
   * animations so the new song starts from t=0. */
  private onFocusedSongChanged(): void {
    this.emitFocusedSong();
    this.preimageFade = restartPreimageFade();
    this.commentScroll = restartCommentScroll();
    this.commentTextWidthPx = 0;
  }

  private cycleDifficulty(delta: number): void {
    const song = this.focusedSong();
    if (!song) return;
    this.preferredSlot = cycleDifficultySlot(song, this.preferredSlot, delta);
    this.paint();
  }

  /** Currently focused song, or null when focus is on a folder /
   * synthetic row. Mirrors `SongWheel.focusedSong()` so a desktop
   * driver can read it the same way. */
  focusedSong(): SongEntry | null {
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
    // Box change is a context jump — skip the wheel slide animation
    // and just snap. The entry list is a different list of entries,
    // so a slide between them would be meaningless.
    this.wheelScroll = newWheelScrollState();
    this.onFocusedSongChanged();
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
    this.wheelScroll = newWheelScrollState();
    this.onFocusedSongChanged();
    void this.loadCoverForFocused();
    this.paint();
  }

  private rebuildEntries(): void {
    this.entries = buildDisplayEntries(this.currentBox, {
      sort: this.sortMode,
      searchQuery: this.searchQuery,
    });
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
      case 'sort':
        this.cycleSortMode();
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
    // Snapshot which wheel entry the laser/cursor is hovering BEFORE
    // we clear the hit-rect list. The new hits get rebuilt from
    // scratch each paint, so hoveredIdx (which indexes the previous
    // paint's hits) is otherwise unusable for cross-paint state. The
    // snapshot lets paintWheelBar give the targeted-but-not-focused
    // row a visible hover overlay so the player can see where their
    // laser is pointing.
    const hoveredEntryIdx = this.snapshotHoveredEntryIdx();
    this.hits = [];

    this.paintBackground();
    this.paintPreimage();
    this.paintStatusPanel();
    // Comment bar sits behind the wheel — its y-strip (257..287)
    // overlaps the focus row's bar (270..320) and the canonical C#
    // order paints the wheel ON TOP so the focused bar punches
    // through the comment ribbon.
    this.paintCommentBar();
    this.paintWheel(hoveredEntryIdx);
    this.paintScrollbar();
    this.paintHeaderAndBreadcrumb();
    if (!this.desktopMode) this.paintFooter();
    this.paintWipBanner();

    this.texture.needsUpdate = true;
  }

  private snapshotHoveredEntryIdx(): number {
    if (this.hoveredIdx < 0) return -1;
    const hit = this.hits[this.hoveredIdx];
    if (!hit) return -1;
    return hit.action.kind === 'activate' ? hit.action.entryIdx : -1;
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

  private paintWheel(hoveredEntryIdx: number): void {
    const ctx = this.ctx;
    if (this.entries.length === 0) {
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '16px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Empty folder.', WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!.x, WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!.y + 30);
      return;
    }
    const n = this.entries.length;
    // Scroll easing: each visible bar interpolates between its previous
    // anchor (the one the same entry occupied before the focus change)
    // and its current anchor. Progress 1 = animation complete = static
    // anchors. dir=+1 means focus moved DOWN, so the entry that's now
    // at slot `i` was previously at slot `i+1`.
    const progress = wheelScrollProgress(this.wheelScroll);
    const dir = this.wheelScroll.dir;
    for (let i = 0; i < WHEEL_VISIBLE_BARS; i++) {
      const offset = i - WHEEL_FOCUS_INDEX;
      const idx = ((this.focusIdx + offset) % n + n) % n;
      const entry = this.entries[idx]!;
      const target = WHEEL_BAR_ANCHORS[i]!;
      let anchor = target;
      if (dir !== 0 && progress < 1) {
        const fromIdx = clampSlot(i + dir);
        const from = WHEEL_BAR_ANCHORS[fromIdx]!;
        anchor = {
          x: lerp(from.x, target.x, progress),
          y: lerp(from.y, target.y, progress),
        };
      }
      const hovered = idx === hoveredEntryIdx && offset !== 0;
      this.paintWheelBar(entry, i, offset === 0, idx, anchor, hovered);
    }
  }

  private paintWheelBar(
    entry: DisplayEntry,
    barIdx: number,
    focused: boolean,
    entryIdx: number,
    anchor: BarAnchor,
    hovered: boolean,
  ): void {
    const ctx = this.ctx;
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

    // Laser-hover overlay on non-focused rows. The user can otherwise
    // pull the trigger and feel like nothing changed because (a) the
    // unfocused-row "selected" texture isn't painted and (b) the
    // first trigger pull only moves focus rather than activating —
    // they need to see *which* row is being targeted.
    if (hovered) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.20)';
      ctx.fillRect(anchor.x, anchor.y, barW, barH);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.strokeRect(anchor.x + 1, anchor.y + 1, barW - 2, barH - 2);
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

    // Difficulty selection lives in the status panel grid + ←/→ keys.
    // Canonical DTXMania doesn't paint floating chart buttons under
    // the focused bar, and the floats also overlapped the comment bar
    // (y=257) and the next wheel row (y=320+) on the curved layout.
  }

  private paintPreimage(): void {
    const ctx = this.ctx;
    const frame = this.getAsset('5_preimage panel.png');
    const fallback = this.getAsset('5_preimage default.png');

    // Frame first (decorative — sits behind the actual image and is
    // drawn at full opacity so the bezel stays visible during the fade).
    if (frame) {
      ctx.drawImage(frame, PREIMAGE_X - 8, PREIMAGE_Y - 8);
    }

    const alpha = preimageOpacity(this.preimageFade);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * alpha;
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
    ctx.globalAlpha = prevAlpha;
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
        // Translucent dark backing — the BG image (5_background.jpg) is
        // a busy guitar/yellow scene that makes the thin pink frame
        // border + dim text unreadable. Painted FIRST so the frame
        // texture (or fallback stroke) sits on top.
        ctx.fillStyle = 'rgba(11, 15, 26, 0.62)';
        ctx.fillRect(cellX, cellY, cellW, cellH);
        if (frame) {
          ctx.drawImage(frame, cellX, cellY);
        } else {
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 1;
          ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellW - 1, cellH - 1);
        }
        const chart = p === 0 ? slotsUsed.get(i) : undefined;
        const isSelected = chart !== undefined && chart.slot === selected.slot;
        if (isSelected) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.28)';
          ctx.fillRect(cellX, cellY, cellW, cellH);
        }
        // Empty-cell label tone — still dim but legible against the
        // dark backing instead of dissolving into the BG.
        ctx.fillStyle = chart ? '#fff' : '#94a3b8';
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
    // Comment text — clipped to the bar's interior. If the rendered
    // width exceeds the clip, advanceAnimations() steps the scroll
    // offset and we draw the text twice (with a gap) so it loops.
    if (!song?.comment) {
      this.commentTextWidthPx = 0;
      return;
    }
    const text = song.comment;
    const textX = COMMENT_BAR_X + COMMENT_TEXT_OFFSET_X;
    const textY = COMMENT_BAR_Y + COMMENT_TEXT_OFFSET_Y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(textX, textY - COMMENT_CLIP_H_PX + 6, COMMENT_CLIP_W_PX, COMMENT_CLIP_H_PX);
    ctx.clip();
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const widthPx = ctx.measureText(text).width;
    this.commentTextWidthPx = widthPx;

    if (widthPx <= COMMENT_CLIP_W_PX) {
      ctx.fillText(text, textX, textY);
    } else {
      const offset = this.commentScroll.offsetPx;
      ctx.fillText(text, textX - offset, textY);
      // Wrap copy: when the head of the text has scrolled out, the tail
      // should already be visible from the right edge.
      ctx.fillText(text, textX - offset + widthPx + COMMENT_SCROLL_GAP_PX, textY);
    }
    ctx.restore();
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
    // Sort button — always painted in VR mode so the player can re-
    // order the wheel without removing the headset. The label tracks
    // the current mode so the button doubles as a state readout.
    this.paintUtilityButton(`Sort: ${this.sortMode}`, FOOTER_SORT_X, 'sort');
  }

  private paintUtilityButton(
    label: string,
    x: number,
    actionKind: 'config' | 'calibrate' | 'sort',
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

function clampSlot(i: number): number {
  if (i < 0) return 0;
  if (i >= WHEEL_VISIBLE_BARS) return WHEEL_VISIBLE_BARS - 1;
  return i;
}
