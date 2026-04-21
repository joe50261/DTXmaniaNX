import * as THREE from 'three';
import type { BoxNode, ChartEntry, LibraryNode, SongEntry } from '@dtxmania/dtx-core';

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

const PANEL_W_PX = 1024;
const PANEL_H_PX = 768;
const PANEL_WORLD_W = 1.6;
const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
const PANEL_POS = new THREE.Vector3(0, 1.45, -1.5);

/** Number of wheel rows — odd so there's a single visual focus row. */
const WHEEL_VISIBLE_ROWS = 7;
const WHEEL_CENTER_OFFSET = (WHEEL_VISIBLE_ROWS - 1) / 2;
const WHEEL_X = 40;
const WHEEL_W = 560;
const WHEEL_ROW_H = 74;
const WHEEL_TOP = 130;

const COVER_X = 620;
const COVER_Y = WHEEL_TOP;
const COVER_SIZE = 200;

const STATUS_X = COVER_X;
const STATUS_Y = COVER_Y + COVER_SIZE + 16;
const STATUS_W = PANEL_W_PX - STATUS_X - 40;

const EXIT_W = 200;
const EXIT_H = 50;
const EXIT_X = PANEL_W_PX - 40 - EXIT_W;
const EXIT_Y = PANEL_H_PX - 70;

const DIFFICULTY_SLOT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTX'] as const;

/** Stick magnitude past which we treat an axis as "pushed" — edge-detected
 * so a held stick doesn't spam focus changes every frame. */
const STICK_THRESHOLD = 0.55;
/** Dead-band coming back: the stick must fall below this before the next
 * edge can fire. Prevents jitter at the threshold. */
const STICK_RELEASE = 0.3;

type SyntheticEntry =
  | { kind: 'back'; parent: BoxNode }
  | { kind: 'random'; box: BoxNode };
type DisplayEntry = { kind: 'node'; node: LibraryNode } | SyntheticEntry;

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
    | { kind: 'exit' };
}

export interface VrMenuPick {
  song: SongEntry;
  chart: ChartEntry;
}

/** Callbacks injected by main.ts so the menu can drive preview audio + load
 * cover-art bytes without knowing about the FS backend. */
export interface VrMenuDeps {
  /** Resolve a path relative to the backend's root to raw bytes. */
  loadBytes: (path: string) => Promise<ArrayBuffer>;
  /** Join a folder + relative file path. Same helper as the scanner. */
  joinPath: (folder: string, rel: string) => string;
  /** Called when focus lands on a song — host starts/stops preview audio. */
  onFocusedSong: (song: SongEntry | null) => void;
}

export class VrMenu {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;

  private readonly lasers: THREE.Line[] = [];
  private readonly tipMarks: THREE.Mesh[] = [];
  private readonly wasPressed: boolean[] = [false, false];
  private readonly wasSqueezed: boolean[] = [false, false];
  private readonly inputSources: (XRInputSource | null)[] = [null, null];
  /** Per-stick edge-detect state. Right stick drives focus + activate/back;
   * left stick drives difficulty cycling. Both use the same ±0.55
   * threshold with a 0.3 release dead-band so a held stick fires exactly
   * once per push. */
  private readonly rightStickX = { pushed: 0 };
  private readonly rightStickY = { pushed: 0 };
  private readonly leftStickX = { pushed: 0 };

  private hits: ButtonHit[] = [];
  private hoveredIdx = -1;

  private root: BoxNode | null = null;
  private currentBox: BoxNode | null = null;
  private entries: DisplayEntry[] = [];
  private focusIdx = 0;
  private preferredSlot = 4;
  /** Decoded cover art for the focused song. Cleared when focus moves off
   * a song or onto a song without #PREIMAGE. */
  private coverBitmap: ImageBitmap | null = null;
  /** Latest cover-load request token; stale responses are dropped. */
  private coverRequestId = 0;
  private onPick: ((pick: VrMenuPick) => void) | null = null;
  private onExit: (() => void) | null = null;
  private shown = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly addedControllers: THREE.Group[] = [];

  /** Supplied at show() time so the Game class doesn't need to know about
   * backends at construction. Cleared on hide. */
  private deps: VrMenuDeps | null = null;

  constructor(
    private readonly webgl: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene
  ) {
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

  show(
    root: BoxNode,
    onPick: (pick: VrMenuPick) => void,
    onExit: () => void,
    deps: VrMenuDeps
  ): void {
    this.root = root;
    this.currentBox = root;
    this.focusIdx = 0;
    this.preferredSlot = 4;
    this.rebuildEntries();
    this.onPick = onPick;
    this.onExit = onExit;
    this.deps = deps;
    this.hoveredIdx = -1;
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

      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffeb3b })
      );
      tip.visible = false;
      this.scene.add(tip);
      this.tipMarks.push(tip);
    }

    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  hide(): void {
    this.shown = false;
    this.mesh.visible = false;
    for (const l of this.lasers) l.visible = false;
    for (const t of this.tipMarks) t.visible = false;
    this.deps?.onFocusedSong(null);
    this.deps = null;
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
          rayHitIdx = this.hits.findIndex(
            (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h
          );
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

    // Right thumbstick drives focus + activate/back. Y is the same as
    // before (↓ = focus down); X is the key remap from the original
    // right-X-cycles-difficulty: Quest has no ESC, so we need a ubiquitous
    // quick-back. Push-right → Enter (same effect as trigger), push-left
    // → back (same effect as squeeze).
    const rs = this.thumbstickOf('right');
    if (rs) {
      const [sx, sy] = rs;
      if (sy <= -STICK_THRESHOLD && this.rightStickY.pushed !== -1) {
        this.rightStickY.pushed = -1;
        this.moveFocus(-1);
      } else if (sy >= STICK_THRESHOLD && this.rightStickY.pushed !== 1) {
        this.rightStickY.pushed = 1;
        this.moveFocus(1);
      } else if (Math.abs(sy) < STICK_RELEASE) {
        this.rightStickY.pushed = 0;
      }
      if (sx <= -STICK_THRESHOLD && this.rightStickX.pushed !== -1) {
        this.rightStickX.pushed = -1;
        this.goBack();
      } else if (sx >= STICK_THRESHOLD && this.rightStickX.pushed !== 1) {
        this.rightStickX.pushed = 1;
        this.activateFocused();
      } else if (Math.abs(sx) < STICK_RELEASE) {
        this.rightStickX.pushed = 0;
      }
    }

    // Left thumbstick X cycles difficulty on the focused song. The
    // original binding (right-X) conflicted with the new Enter/back
    // mapping above; difficulty is a modifier-style action so it fits
    // the off-hand stick.
    const ls = this.thumbstickOf('left');
    if (ls) {
      const [sx] = ls;
      if (sx <= -STICK_THRESHOLD && this.leftStickX.pushed !== -1) {
        this.leftStickX.pushed = -1;
        this.cycleDifficulty(-1);
      } else if (sx >= STICK_THRESHOLD && this.leftStickX.pushed !== 1) {
        this.leftStickX.pushed = 1;
        this.cycleDifficulty(1);
      } else if (Math.abs(sx) < STICK_RELEASE) {
        this.leftStickX.pushed = 0;
      }
    }
  }

  private thumbstickOf(hand: 'left' | 'right'): [number, number] | null {
    for (const src of this.inputSources) {
      if (!src || src.handedness !== hand) continue;
      const axes = src.gamepad?.axes;
      if (!axes) continue;
      // Quest layout: axes[2] = X, axes[3] = Y. axes[0]/[1] are the legacy
      // trackpad which Touch controllers don't have but the spec still
      // reserves. Fall back if only 2 axes are reported.
      const x = axes[2] ?? axes[0] ?? 0;
      const y = axes[3] ?? axes[1] ?? 0;
      return [x, y];
    }
    return null;
  }

  private moveFocus(delta: number): void {
    const n = this.entries.length;
    if (n === 0) return;
    this.focusIdx = ((this.focusIdx + delta) % n + n) % n;
    this.emitFocusedSong();
    void this.loadCoverForFocused();
    this.paint();
  }

  private cycleDifficulty(delta: number): void {
    const song = this.focusedSong();
    if (!song || song.charts.length === 0) return;
    const slots = song.charts.map((c) => c.slot).sort((a, b) => a - b);
    const effective = this.chartForPreferred(song);
    const curIdx = slots.indexOf(effective.slot);
    const next = ((curIdx + delta) % slots.length + slots.length) % slots.length;
    this.preferredSlot = slots[next]!;
    this.paint();
  }

  private focusedSong(): SongEntry | null {
    const entry = this.entries[this.focusIdx];
    if (entry?.kind !== 'node') return null;
    return entry.node.type === 'song' ? entry.node.entry : null;
  }

  private chartForPreferred(song: SongEntry): ChartEntry {
    const sorted = [...song.charts].sort((a, b) => a.slot - b.slot);
    const exact = sorted.find((c) => c.slot === this.preferredSlot);
    if (exact) return exact;
    const nextHigher = sorted.find((c) => c.slot >= this.preferredSlot);
    return nextHigher ?? sorted[sorted.length - 1]!;
  }

  private activateFocused(): void {
    const entry = this.entries[this.focusIdx];
    if (!entry) return;
    if (entry.kind === 'back') {
      this.goBack();
      return;
    }
    if (entry.kind === 'random') {
      const song = this.pickRandomSongIn(entry.box);
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

  private pickRandomSongIn(box: BoxNode): SongEntry | null {
    const songs: SongEntry[] = [];
    const stack: LibraryNode[] = [box];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'song') songs.push(node.entry);
      else for (const c of node.children) stack.push(c);
    }
    if (songs.length === 0) return null;
    return songs[Math.floor(Math.random() * songs.length)] ?? null;
  }

  private rebuildEntries(): void {
    const box = this.currentBox;
    this.entries = [];
    if (!box) return;
    if (box.parent) this.entries.push({ kind: 'back', parent: box.parent });
    this.entries.push({ kind: 'random', box });
    for (const child of box.children) this.entries.push({ kind: 'node', node: child });
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
      console.warn('[vr-menu] cover load failed', path, e);
      this.coverBitmap?.close();
      this.coverBitmap = null;
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
    ctx.textAlign = 'left';
    ctx.fillText('Song Library', 40, 52);

    // Breadcrumb
    ctx.font = '15px ui-monospace, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(this.breadcrumbText(), 40, 86);

    this.paintWheel();
    this.paintCover();
    this.paintStatusPanel();
    this.paintFooter();

    this.texture.needsUpdate = true;
  }

  private breadcrumbText(): string {
    const chain: string[] = [];
    for (let b: BoxNode | null = this.currentBox; b; b = b.parent) chain.push(b.name);
    chain.reverse();
    return chain.join('  ›  ');
  }

  private paintWheel(): void {
    const ctx = this.ctx;
    if (this.entries.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '16px ui-monospace, monospace';
      ctx.fillText('Empty folder.', WHEEL_X, WHEEL_TOP + 40);
      return;
    }
    const n = this.entries.length;
    const centerY = WHEEL_TOP + WHEEL_CENTER_OFFSET * WHEEL_ROW_H;
    for (let i = 0; i < WHEEL_VISIBLE_ROWS; i++) {
      const offset = i - WHEEL_CENTER_OFFSET;
      const idx = ((this.focusIdx + offset) % n + n) % n;
      const entry = this.entries[idx]!;
      const y = WHEEL_TOP + i * WHEEL_ROW_H;
      this.paintWheelRow(entry, y, offset === 0, idx);
    }
    void centerY;
  }

  private paintWheelRow(
    entry: DisplayEntry,
    y: number,
    focused: boolean,
    entryIdx: number
  ): void {
    const ctx = this.ctx;
    const h = WHEEL_ROW_H - 4;

    if (focused) {
      ctx.fillStyle = 'rgba(80, 120, 255, 0.18)';
      ctx.fillRect(WHEEL_X, y, WHEEL_W, h);
      ctx.strokeStyle = 'rgba(80, 120, 255, 0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(WHEEL_X + 0.5, y + 0.5, WHEEL_W - 1, h - 1);
    }

    // Row is also a clickable activate target for laser rays.
    this.hits.push({
      x: WHEEL_X,
      y,
      w: WHEEL_W,
      h,
      action: { kind: 'activate', entryIdx },
    });

    const title = rowTitle(entry);
    ctx.textAlign = 'left';
    ctx.fillStyle = focused ? '#f1f5f9' : '#94a3b8';
    ctx.font = focused
      ? 'bold 22px ui-monospace, monospace'
      : '16px ui-monospace, monospace';
    ctx.fillText(title, WHEEL_X + 14, y + (focused ? 32 : 26));

    if (!focused) return;
    if (entry.kind !== 'node' || entry.node.type !== 'song') return;

    // Focused song row: chart buttons (right-aligned inside the wheel col)
    // overlaying the bottom half of the focused cell.
    const song = entry.node.entry;
    const selected = this.chartForPreferred(song);
    const btnH = 32;
    const btnW = 96;
    const btnGap = 6;
    const charts = [...song.charts].sort((a, b) => a.slot - b.slot);
    let btnX = WHEEL_X + WHEEL_W - 14 - charts.length * (btnW + btnGap) + btnGap;
    const btnY = y + h - btnH - 8;
    for (const chart of charts) {
      const isSelected = chart.slot === selected.slot;
      ctx.fillStyle = isSelected ? '#3355ff' : '#1e2a55';
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

  private paintCover(): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(COVER_X, COVER_Y, COVER_SIZE, COVER_SIZE);
    if (this.coverBitmap) {
      ctx.drawImage(this.coverBitmap, COVER_X, COVER_Y, COVER_SIZE, COVER_SIZE);
    } else {
      ctx.fillStyle = '#334155';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('(no cover)', COVER_X + COVER_SIZE / 2, COVER_Y + COVER_SIZE / 2);
      ctx.textAlign = 'left';
    }
  }

  private paintStatusPanel(): void {
    const ctx = this.ctx;
    const song = this.focusedSong();
    if (!song) return;

    const slotsUsed = new Map<number, ChartEntry>();
    for (const c of song.charts) slotsUsed.set(c.slot, c);
    const selected = this.chartForPreferred(song);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(STATUS_X, STATUS_Y, STATUS_W, 310);

    let y = STATUS_Y + 22;
    ctx.font = '13px ui-monospace, monospace';
    for (let slot = 0; slot < DIFFICULTY_SLOT_LABELS.length; slot++) {
      const chart = slotsUsed.get(slot);
      const isSelected = chart !== undefined && chart.slot === selected.slot;
      if (isSelected) {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';
        ctx.fillRect(STATUS_X + 6, y - 14, STATUS_W - 12, 20);
      }
      ctx.fillStyle = chart ? '#cbd5e1' : '#475569';
      ctx.textAlign = 'left';
      ctx.fillText(chart?.label ?? DIFFICULTY_SLOT_LABELS[slot]!, STATUS_X + 12, y);
      ctx.textAlign = 'right';
      ctx.fillText(
        chart?.drumLevel !== undefined && chart.drumLevel > 0
          ? `L.${(chart.drumLevel / 100).toFixed(2)}`
          : '—',
        STATUS_X + STATUS_W - 12,
        y
      );
      y += 24;
    }

    // Meta block
    y += 8;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(STATUS_X + 12, y - 10, STATUS_W - 24, 1);
    y += 12;
    ctx.textAlign = 'left';
    const lines: Array<[string, string | undefined]> = [
      ['Artist', song.artist],
      ['Genre', song.genre],
      ['BPM', song.bpm ? Math.round(song.bpm).toString() : undefined],
    ];
    for (const [k, v] of lines) {
      if (!v) continue;
      ctx.fillStyle = '#64748b';
      ctx.fillText(k, STATUS_X + 12, y);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(truncate(v, 24), STATUS_X + 70, y);
      y += 20;
    }
  }

  private paintFooter(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#64748b';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      'Right stick: ↕ browse  · → enter  · ← back    ·    Left stick ↔: difficulty    ·    Trigger: play',
      40,
      PANEL_H_PX - 40
    );

    // Exit VR
    const hovered = this.hoveredIdx >= 0 && this.hits[this.hoveredIdx]?.action.kind === 'exit';
    ctx.fillStyle = hovered ? '#dc2626' : '#374151';
    ctx.fillRect(EXIT_X, EXIT_Y, EXIT_W, EXIT_H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Exit VR', EXIT_X + EXIT_W / 2, EXIT_Y + 32);
    this.hits.push({ x: EXIT_X, y: EXIT_Y, w: EXIT_W, h: EXIT_H, action: { kind: 'exit' } });
  }
}

function rowTitle(entry: DisplayEntry): string {
  if (entry.kind === 'back') return `⬆  ..  (${entry.parent.name})`;
  if (entry.kind === 'random') return '🎲  Random';
  const node = entry.node;
  if (node.type === 'box') return `📁  ${node.name}`;
  return node.entry.title;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
