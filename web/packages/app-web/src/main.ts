/// <reference types="vite/client" />
import { installOnScreenLog } from './on-screen-log.js';
installOnScreenLog();

import {
  deserializeIndex,
  dirname,
  flattenSongs,
  joinPath,
  mergeChartRecord,
  serializeIndex,
  SongScanner,
  type BoxNode,
  type ChartEntry,
  type ChartRecord,
  type LibraryNode,
  type ScoreSnapshot,
  type SongEntry,
  type SongIndex,
} from '@dtxmania/dtx-core';
import { Game, type GameFsContext } from './game.js';
import { SongWheel } from './song-wheel.js';
import { ConfigPanel } from './config-panel.js';
import {
  getConfig,
  isPracticeRun,
  subscribe,
  updateConfig,
  type AutoPlayMap,
} from './config.js';
import { GamepadInput, Lane, MidiInput, type LaneValue, type MidiPortInfo } from '@dtxmania/input';
import { PreviewPlayer } from '@dtxmania/audio-engine';
import { HandleFileSystemBackend } from './fs/handle-backend.js';
import {
  clearChartRecords,
  clearRootHandle,
  clearScanCache,
  loadAllChartRecords,
  loadRootHandle,
  loadScanCache,
  saveChartRecord,
  saveRootHandle,
  saveScanCache,
} from './fs/handle-store.js';
import { loadSkin } from './skin.js';
import type { SkinTextures } from './renderer.js';
import { runCalibration } from './calibrate.js';
import { loadAudioOffsetMs, saveAudioOffsetMs } from './calibrate-model.js';
import { activeToast, showToast } from './hud-toast.js';

// Test hook for the Playwright e2e suite. Toast is painted onto the
// HUD canvas rather than a DOM node Playwright can locate, so we
// expose the module singleton directly. Always-installed (a single
// function reference on window) because the e2e suite runs against
// `vite preview` which matches a production build.
(
  window as unknown as { __dtxmaniaTest?: { activeToast: typeof activeToast } }
).__dtxmaniaTest = { activeToast };
import { AudioEngine } from '@dtxmania/audio-engine';

/**
 * Translate the config's per-name AutoPlayMap into the numeric LaneValue
 * set the Game loop consumes. Encapsulated here (not in config.ts) so
 * the config module stays dependency-free of @dtxmania/input.
 */
function autoPlayToLanes(map: AutoPlayMap): Iterable<LaneValue> {
  const out: LaneValue[] = [];
  if (map.LC) out.push(Lane.LC);
  if (map.HH) out.push(Lane.HH);
  if (map.LP) out.push(Lane.LP);
  if (map.SD) out.push(Lane.SD);
  if (map.HT) out.push(Lane.HT);
  if (map.BD) out.push(Lane.BD);
  if (map.LT) out.push(Lane.LT);
  if (map.FT) out.push(Lane.FT);
  if (map.CY) out.push(Lane.CY);
  if (map.RD) out.push(Lane.RD);
  if (map.LBD) out.push(Lane.LBD);
  return out;
}

const canvas = requireEl<HTMLCanvasElement>('game');
const overlay = requireEl<HTMLDivElement>('overlay');
const statusEl = requireEl<HTMLDivElement>('status');
const pickBtn = requireEl<HTMLButtonElement>('pick-folder');
const demoBtn = requireEl<HTMLButtonElement>('start-demo');
const forgetBtn = requireEl<HTMLButtonElement>('forget-folder');
const rescanBtn = requireEl<HTMLButtonElement>('rescan-folder');
const calibrateBtn = requireEl<HTMLButtonElement>('calibrate');
const configBtn = requireEl<HTMLButtonElement>('config-btn');
const xrBtn = requireEl<HTMLButtonElement>('enter-xr');
const wheelEl = requireEl<HTMLDivElement>('song-wheel');
const statusPanelEl = requireEl<HTMLDivElement>('status-panel');
const breadcrumbEl = requireEl<HTMLDivElement>('breadcrumb');
const preimageEl = requireEl<HTMLImageElement>('preimage-panel');
const scanErrorsEl = requireEl<HTMLDivElement>('scan-errors');
const sortBtn = requireEl<HTMLButtonElement>('sort-btn');
const searchBox = requireEl<HTMLInputElement>('search-box');

const songWheel = new SongWheel(wheelEl, statusPanelEl, breadcrumbEl, {
  onStart: (chart) => run(() => startChart(chart)),
  formatLevel,
  isActive: () => overlay.style.display !== 'none',
});
songWheel.attachKeyboard();
songWheel.onFocusChanged(() => onFocusChanged());

sortBtn.addEventListener('click', () => {
  const mode = songWheel.cycleSortMode();
  sortBtn.textContent = `Sort: ${mode}`;
});

// `/` opens the search box; typing filters live; Esc clears + closes
// (the plain wheel Esc-back handler sees nothing because search-box
// consumes the event first). Search-mode also suppresses the wheel's
// own keyboard listener so arrow keys navigate the input cursor.
searchBox.addEventListener('input', () => {
  songWheel.setSearchQuery(searchBox.value);
});
searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  } else if (e.key === 'Enter') {
    // Enter during search commits the currently-focused result and
    // closes the box. Keep the filter applied so the player sees
    // the state their selection came from; cleared on next open.
    e.preventDefault();
    searchBox.blur();
  }
});
searchBox.addEventListener('blur', () => {
  // Give wheel keys back once search loses focus.
  songWheel.attachKeyboard();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (overlay.style.display === 'none') return;
  e.preventDefault();
  openSearch();
});

/** Commit an A/B loop marker capture and surface a HUD toast. Shared
 * by the keyboard hotkeys and the VR face-button path so the feedback
 * is identical across input surfaces. Warns when the resulting window
 * is invalid (B ≤ A) — the `resolveLoopWindow` helper silently
 * disables the loop in that case, and without this hint the player
 * wouldn't know why nothing loops. */
function commitLoopCapture(which: 'A' | 'B', measure: number): void {
  if (which === 'A') {
    updateConfig({ practiceLoopStartMeasure: measure, practiceLoopEnabled: true });
  } else {
    updateConfig({ practiceLoopEndMeasure: measure, practiceLoopEnabled: true });
  }
  const cfg = getConfig();
  const end = cfg.practiceLoopEndMeasure;
  // Invalid if end is explicitly set and lies at or before start. null
  // end means "end of song" which is always > start ≥ 0, so not invalid.
  const invalid = end !== null && end <= cfg.practiceLoopStartMeasure;
  if (invalid) {
    showToast(
      `Loop ${which}: measure ${measure} — invalid (A=${cfg.practiceLoopStartMeasure}, B=${end})`,
      2600,
    );
  } else {
    showToast(`Loop ${which}: measure ${measure}`);
  }
}

// Practice-loop hotkeys. `[` captures A (floor-to-measure), `]` captures
// B (ceil-to-measure), `\` toggles loop on/off. Only fire while a chart
// is playing; focus-in-text guards mirror the `/` handler so typing in
// the search box or Settings inputs doesn't hijack. The Set A/B buttons
// in Settings call the same `captureLoopMarker` path.
window.addEventListener('keydown', (e) => {
  if (e.key !== '[' && e.key !== ']' && e.key !== '\\') return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (!activeGame?.hasChart) return;
  if (e.key === '[') {
    const m = activeGame.captureLoopMarker('A');
    if (m === null) return;
    commitLoopCapture('A', m);
    e.preventDefault();
  } else if (e.key === ']') {
    const m = activeGame.captureLoopMarker('B');
    if (m === null) return;
    commitLoopCapture('B', m);
    e.preventDefault();
  } else if (e.key === '\\') {
    const next = !getConfig().practiceLoopEnabled;
    updateConfig({ practiceLoopEnabled: next });
    showToast(`Loop ${next ? 'on' : 'off'}`);
    e.preventDefault();
  }
});

function openSearch(): void {
  searchBox.classList.add('visible');
  searchBox.value = songWheel.getSearchQuery();
  songWheel.detachKeyboard();
  searchBox.focus();
  searchBox.select();
}

function closeSearch(): void {
  searchBox.value = '';
  songWheel.setSearchQuery('');
  searchBox.classList.remove('visible');
  searchBox.blur();
  songWheel.attachKeyboard();
}

// Preload skin PNGs once at boot. Games created later reuse these textures.
const skinPromise: Promise<SkinTextures> = loadSkin();

/**
 * Game is built eagerly (with empty skin) so the Enter-VR click handler
 * can call game.enterXR() synchronously — Quest Browser consumes the
 * user-activation token on any `await` before `navigator.xr.requestSession`,
 * which silently fails the session request otherwise. Skin textures are
 * applied as soon as the loader resolves; the renderer already tolerates
 * an initial skin-less render.
 */
let activeGame: Game | null = null;
try {
  activeGame = new Game(canvas, {});
  const boot = activeGame;
  skinPromise
    .then((skin) => boot.applySkin(skin))
    .catch((e) => console.warn('skin load failed', e));
  // Push the persisted user settings into the freshly-built renderer so
  // the first frame already reflects scrollSpeed / judgeLineY /
  // reverseScroll. Subsequent updates ride the subscribe channel.
  const cfg0 = getConfig();
  boot.display.setScrollSpeed(cfg0.scrollSpeed);
  boot.display.setJudgeLineY(cfg0.judgeLineY);
  boot.display.setReverseScroll(cfg0.reverseScroll);
  boot.display.setFastSlowEnabled(cfg0.showFastSlow);
  boot.display.setFastSlowDeadMs(cfg0.fastSlowDeadMs);
  boot.setAutoPlayLanes(autoPlayToLanes(cfg0.autoPlay));
  boot.audio.setBgmVolume(cfg0.volumeBgm);
  boot.audio.setDrumsVolume(cfg0.volumeDrums);
  boot.audio.setPreviewVolume(cfg0.volumePreview);
  boot.audio.setRate(cfg0.practiceRate);
  boot.audio.setPreservePitch(cfg0.preservePitch);
} catch (e) {
  // WebGL unavailable — page still usable for non-game actions if any.
  console.warn('Game init failed', e);
}

// Song-select preview audio: rides on the Game's AudioContext so a single
// user gesture resumes both, and the browser's AudioContext cap doesn't
// bite. The loader closes over `library` so switching folders picks up
// the new backend automatically.
const previewPlayer: PreviewPlayer | null = activeGame
  ? new PreviewPlayer(
      activeGame.audioContext,
      async (path) => {
        if (!library) throw new Error('no library loaded');
        return library.backend.readFile(path);
      },
      // Route through the engine's preview master so Settings → Preview
      // volume governs loudness without any per-play volume tweaks.
      activeGame.audio.previewGain
    )
  : null;

/** Cancels an outstanding 600 ms preview-start timer. DTXmania's canonical
 * delay — prevents preview thrash while the player scrolls the wheel. */
let pendingPreviewTimer: number | null = null;
/** Object URL currently assigned to preimageEl; revoked when replaced. */
let currentPreimageUrl: string | null = null;

function onFocusChanged(): void {
  const song = songWheel.focusedSong();
  schedulePreview(song);
  void updatePreimage(song);
}

function schedulePreview(song: SongEntry | null): void {
  if (pendingPreviewTimer !== null) {
    clearTimeout(pendingPreviewTimer);
    pendingPreviewTimer = null;
  }
  previewPlayer?.stop(200);
  if (!song?.preview || !library || !previewPlayer) return;
  const path = joinPath(song.folderPath, song.preview);
  pendingPreviewTimer = window.setTimeout(() => {
    pendingPreviewTimer = null;
    // Per-play gain full-open; preview master (engine.previewGain,
    // driven by config.volumePreview) governs the actual loudness.
    void previewPlayer.play(path, 1);
  }, 600);
}

async function updatePreimage(song: SongEntry | null): Promise<void> {
  if (!song?.preimage || !library) {
    clearPreimage();
    return;
  }
  const path = joinPath(song.folderPath, song.preimage);
  try {
    const buf = await library.backend.readFile(path);
    // focus may have moved while we were loading — abort if stale
    if (songWheel.focusedSong() !== song) return;
    const blob = new Blob([buf.slice(0)]);
    const url = URL.createObjectURL(blob);
    if (currentPreimageUrl) URL.revokeObjectURL(currentPreimageUrl);
    currentPreimageUrl = url;
    preimageEl.src = url;
    preimageEl.classList.add('visible');
  } catch (e) {
    console.warn('[preimage] load failed', path, e);
    clearPreimage();
  }
}

function clearPreimage(): void {
  preimageEl.classList.remove('visible');
  preimageEl.removeAttribute('src');
  if (currentPreimageUrl) {
    URL.revokeObjectURL(currentPreimageUrl);
    currentPreimageUrl = null;
  }
}

interface Library {
  handle: FileSystemDirectoryHandle;
  backend: HandleFileSystemBackend;
  root: BoxNode;
  songs: SongEntry[];
}
let library: Library | null = null;
let onPick: () => Promise<void> = pickAndScan;

registerServiceWorker();

pickBtn.addEventListener('click', () => run(onPick));
demoBtn.addEventListener('click', () => run(playDemo));
forgetBtn.addEventListener('click', () =>
  run(async () => {
    await clearRootHandle();
    await clearScanCache().catch(() => {});
    // Medals belong to the library the player is switching away from;
    // dropping the folder means dropping its score history too.
    await clearChartRecords().catch(() => {});
    library = null;
    songWheel.setRoot(null);
    forgetBtn.style.display = 'none';
    rescanBtn.style.display = 'none';
    pickBtn.textContent = 'Pick folder';
    onPick = pickAndScan;
    setStatus('Pick your Songs folder to begin.');
    refreshXrButton();
  })
);

rescanBtn.addEventListener('click', () =>
  run(async () => {
    if (!library) return;
    await clearScanCache().catch(() => {});
    await scanIntoLibrary(library.handle, { forceRescan: true });
  })
);

calibrateBtn.addEventListener('click', () =>
  run(async () => {
    // The AudioEngine the calibration routine drives is separate from the
    // Game's engine (which only exists while a chart is playing). That's
    // fine — AudioContexts share the same destination within the tab.
    const engine = new AudioEngine();
    const offset = await runCalibration(engine, document.body);
    if (offset !== null) {
      saveAudioOffsetMs(offset);
      setStatus(`Audio offset saved: ${offset.toFixed(1)} ms (${offset > 0 ? 'later' : 'earlier'} than beat).`);
      refreshCalibrateLabel();
    } else {
      setStatus('Calibration cancelled.');
    }
  })
);

refreshCalibrateLabel();

// URL param ?autokick=1/0 still works for demo / recording links — write
// it into the new config blob before the first read so subscribers see
// the right value at boot.
{
  const qs = new URLSearchParams(window.location.search).get('autokick');
  if (qs === '1' || qs === '0') {
    // Preserve the legacy "autokick" URL param: it only ever meant
    // "BD + LBD on/off", so we project it onto exactly those lanes
    // without touching the other 9. Merge-on-write so a later
    // Settings edit can still set a different subset.
    const cur = getConfig().autoPlay;
    updateConfig({
      autoPlay: { ...cur, BD: qs === '1', LBD: qs === '1' },
    });
  }
}

// Gamepad polling loop lives alongside the keyboard listener. XR gating
// comes from the Game.inXR flag — xrControllers already owns the VR hit
// path, so polling a Standard gamepad while in VR would double-fire.
const gamepadInput = new GamepadInput({ isGated: () => activeGame?.inXR ?? false });
gamepadInput.onLaneHit((e) => activeGame?.ingestHit(e));
gamepadInput.onMenu((e) => {
  // Dpad / Start-Back currently only forward `cancel` (mid-song quit).
  // Menu navigation dpad → song wheel is a phase-2 addition once the
  // wheel exposes a public navigate(action) API.
  activeGame?.ingestMenu(e);
});
if (getConfig().gamepadEnabled) gamepadInput.attach();

// MIDI: resolve on first attempt only. A denied permission prompt
// shouldn't be re-requested every config flip — the user can reload to
// try again. The `midiStatus` snapshot lets the Settings UI show "None"
// vs "Unsupported" vs "Denied" unambiguously.
type MidiStatus = 'pending' | 'ready' | 'unsupported' | 'denied';
let midiInput: MidiInput | null = null;
let midiStatus: MidiStatus = 'pending';
let midiPorts: MidiPortInfo[] = [];
const midiPortsListeners = new Set<(ports: MidiPortInfo[], status: MidiStatus) => void>();

function emitMidiPorts(): void {
  for (const cb of midiPortsListeners) cb(midiPorts, midiStatus);
}

async function initMidi(): Promise<void> {
  if (midiInput || midiStatus !== 'pending') return;
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    midiStatus = 'unsupported';
    emitMidiPorts();
    return;
  }
  const access = await MidiInput.requestAccess();
  if (!access) {
    midiStatus = 'denied';
    emitMidiPorts();
    return;
  }
  midiInput = new MidiInput(access, { portId: getConfig().midiInputId });
  midiInput.onLaneHit((e) => activeGame?.ingestHit(e));
  midiInput.onPortsChanged((ports) => {
    midiPorts = ports;
    emitMidiPorts();
  });
  if (getConfig().midiEnabled) midiInput.attach();
  midiPorts = midiInput.listPorts();
  midiStatus = 'ready';
  emitMidiPorts();
}

const configPanel = new ConfigPanel({
  onMidiPortsChanged: (cb) => {
    midiPortsListeners.add(cb);
    cb(midiPorts, midiStatus);
    return () => midiPortsListeners.delete(cb);
  },
  captureLoopMarker: (which) => activeGame?.captureLoopMarker(which) ?? null,
});
configBtn.addEventListener('click', () => configPanel.open());

// Live config → Game / Renderer. The renderer reads scrollSpeed /
// judgeLineY / reverseScroll fields per frame, so a slider drag
// updates the falling chips and judgment line in real time. Auto-kick
// is the only flag the Game itself consumes (BD / LBD auto-fire path).
const applyConfigToActive = (cfg: ReturnType<typeof getConfig>): void => {
  if (!activeGame) return;
  activeGame.setAutoPlayLanes(autoPlayToLanes(cfg.autoPlay));
  activeGame.display.setScrollSpeed(cfg.scrollSpeed);
  activeGame.display.setJudgeLineY(cfg.judgeLineY);
  activeGame.display.setReverseScroll(cfg.reverseScroll);
  activeGame.display.setFastSlowEnabled(cfg.showFastSlow);
  activeGame.display.setFastSlowDeadMs(cfg.fastSlowDeadMs);
  activeGame.audio.setBgmVolume(cfg.volumeBgm);
  activeGame.audio.setDrumsVolume(cfg.volumeDrums);
  activeGame.audio.setPreviewVolume(cfg.volumePreview);
  activeGame.audio.setRate(cfg.practiceRate);
  activeGame.audio.setPreservePitch(cfg.preservePitch);
  activeGame.setLoopWindow(
    cfg.practiceLoopEnabled,
    cfg.practiceLoopStartMeasure,
    cfg.practiceLoopEndMeasure,
  );
};
subscribe(applyConfigToActive);
// Separate subscription for input-plumbing toggles — they don't need an
// activeGame and stay wired across chart reloads.
subscribe((cfg) => {
  if (cfg.gamepadEnabled) gamepadInput.attach();
  else gamepadInput.detach();
  // Lazy-init MIDI if the user flips the toggle ON after boot (e.g.
  // enabled it in Settings having booted with it off, or denied the
  // browser prompt initially and wants to retry — a reload would also
  // work but this is less surprising). Idempotent thanks to initMidi's
  // own early-return.
  if (cfg.midiEnabled && !midiInput && midiStatus === 'pending') {
    void initMidi();
  }
  if (midiInput) {
    if (cfg.midiEnabled) midiInput.attach();
    else midiInput.detach();
    midiInput.setPort(cfg.midiInputId);
  }
});

// Request MIDI access on first user gesture. The Chromium prompt is
// idempotent so the "first gesture" only matters for UX — it lets the
// prompt coincide with a click the user made. If it fails or is denied,
// keyboard + gamepad still work.
const midiTriggerOnce = (): void => {
  window.removeEventListener('pointerdown', midiTriggerOnce);
  window.removeEventListener('keydown', midiTriggerOnce);
  if (getConfig().midiEnabled) void initMidi();
};
if (getConfig().midiEnabled) {
  window.addEventListener('pointerdown', midiTriggerOnce, { once: false });
  window.addEventListener('keydown', midiTriggerOnce, { once: false });
}

void init();

function refreshCalibrateLabel(): void {
  const offset = loadAudioOffsetMs();
  calibrateBtn.textContent =
    offset === 0
      ? 'Calibrate latency'
      : `Calibrate latency (${offset >= 0 ? '+' : ''}${offset.toFixed(0)} ms)`;
}

async function init(): Promise<void> {
  if (!('showDirectoryPicker' in window)) {
    pickBtn.disabled = true;
    setStatus(
      "This browser doesn't support the File System Access API — only the demo chart is playable. Try Chrome, Edge, or Quest Browser."
    );
    return;
  }

  const stored = await loadRootHandle().catch(() => null);
  if (!stored) return;

  const perm = await safeQueryPermission(stored);
  forgetBtn.style.display = 'inline-block';

  if (perm === 'granted') {
    await scanIntoLibrary(stored);
  } else {
    pickBtn.textContent = `Reconnect to "${stored.name}"`;
    setStatus(
      `Saved folder: "${stored.name}". Click Reconnect (a user gesture is required to re-grant access).`
    );
    onPick = async () => {
      const granted = await safeRequestPermission(stored);
      if (granted !== 'granted') {
        setStatus('Permission denied. Pick the folder again to continue.');
        pickBtn.textContent = 'Pick folder';
        onPick = pickAndScan;
        return;
      }
      await scanIntoLibrary(stored);
      onPick = pickAndScan;
    };
  }
}

async function pickAndScan(): Promise<void> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read', id: 'dtxmania-songs' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    throw e;
  }
  await saveRootHandle(handle).catch((e) => console.warn('failed to persist handle', e));
  // A freshly picked folder always deserves a fresh scan — the cache
  // belongs to whatever directory we had before.
  await clearScanCache().catch(() => {});
  await scanIntoLibrary(handle, { forceRescan: true });
}

async function scanIntoLibrary(
  handle: FileSystemDirectoryHandle,
  opts: { forceRescan?: boolean } = {}
): Promise<void> {
  const backend = new HandleFileSystemBackend(handle);

  // Cache path: SongScanner.scan() on Quest 3 is slow enough (~50s/30
  // songs observed in playtest) to warrant boot-time persistence. We
  // save the whole SerializedIndex after each successful scan; on
  // subsequent boots we try the cache first and only fall through to a
  // fresh walk when the cache is missing, corrupt, or the user hit
  // "Rescan". Validity isn't mtime-checked — expecting the user to
  // press Rescan after adding songs keeps the cache simple and the
  // boot instantaneous.
  if (!opts.forceRescan) {
    try {
      const cached = await loadScanCache();
      if (cached) {
        const live = deserializeIndex(cached);
        await attachRecordsToIndex(live);
        applyLibrary(handle, backend, live);
        const ageMin = Math.max(0, Math.round((Date.now() - cached.scannedAtMs) / 60000));
        setStatus(
          `Loaded ${live.songs.length} song(s) from cache (scan was ${ageMin} min ago). ` +
            `Hit Rescan if you changed the folder.`
        );
        return;
      }
    } catch (e) {
      console.info('[scan-cache] invalid or incompatible, falling through to full scan', e);
      await clearScanCache().catch(() => {});
    }
  }

  setStatus(`Scanning "${handle.name}"…`);
  const scanner = new SongScanner(backend, {
    // Walk phase: no known total yet, so just show running counters.
    // On Quest 3 this phase alone can take tens of seconds; updating the
    // status every few directories keeps the UI from looking frozen.
    onWalkProgress: (dirs, songs) => {
      if (dirs === 0 || dirs % 5 === 0) {
        setStatus(
          `Scanning "${handle.name}"… (${dirs} folder(s), ${songs} song(s) so far)`
        );
      }
    },
    onMetaProgress: (done, total) => {
      // Keep the update throttled enough that DOM reflow doesn't steal
      // frames from the scan itself on a slow headset browser.
      if (done === 0 || done === total || done % 3 === 0) {
        setStatus(`Scanning "${handle.name}"… reading headers ${done}/${total}`);
      }
    },
  });
  const index = await scanner.scan('');
  await attachRecordsToIndex(index);
  applyLibrary(handle, backend, index);
  setStatus(`Scanned ${index.songs.length} song(s) in "${handle.name}".`);
  await saveScanCache(serializeIndex(index)).catch((e) =>
    console.warn('[scan-cache] failed to persist', e)
  );
}

/** Shared "the library is now X" commit step used by both cache-hit and
 * fresh-scan paths. Keeps the two paths from diverging on what they
 * wire up. */
function applyLibrary(
  handle: FileSystemDirectoryHandle,
  backend: HandleFileSystemBackend,
  index: SongIndex
): void {
  library = { handle, backend, root: index.root, songs: flattenSongs(index.root) };
  pickBtn.textContent = 'Change folder';
  forgetBtn.style.display = 'inline-block';
  rescanBtn.style.display = 'inline-block';
  songWheel.setRoot(index.root);
  renderScanErrors(index.errors);
  refreshXrButton();
}

/**
 * Walk every ChartEntry in the tree and attach its persisted best-of
 * record if one exists. Called from both scan paths (cache hit + fresh
 * scan) before applyLibrary hands the tree to the UI, so the wheel and
 * status panel can render clear-lamps from the first frame instead of
 * popping in later.
 */
async function attachRecordsToIndex(index: SongIndex): Promise<void> {
  let records: Map<string, ChartRecord>;
  try {
    records = await loadAllChartRecords();
  } catch (e) {
    console.warn('[records] load failed — rendering without medals', e);
    return;
  }
  if (records.size === 0) return;
  const visit = (node: LibraryNode): void => {
    if (node.type === 'song') {
      for (const chart of node.entry.charts) {
        const rec = records.get(chart.chartPath);
        if (rec) chart.record = rec;
      }
    } else {
      for (const c of node.children) visit(c);
    }
  };
  visit(index.root);
}

// DTXMania stores #DLEVEL as 0..1000 (three digits shown as e.g. "5.62").
function formatLevel(dlevel: number): string {
  return (dlevel / 100).toFixed(2);
}

function renderScanErrors(errors: { path: string; message: string }[]): void {
  scanErrorsEl.replaceChildren();
  if (errors.length === 0) return;
  const head = document.createElement('div');
  head.textContent = `${errors.length} path(s) skipped:`;
  scanErrorsEl.appendChild(head);
  for (const err of errors.slice(0, 5)) {
    const li = document.createElement('div');
    li.textContent = `• ${err.path} — ${err.message}`;
    scanErrorsEl.appendChild(li);
  }
}

/**
 * Merge a just-finished snapshot into the chart's persisted record,
 * write it to IDB, and refresh the in-memory ChartEntry so the next
 * render of the wheel / status panel sees the updated medal without a
 * full rescan. Fire-and-forget — a failed IDB write gets logged but
 * doesn't block the result screen.
 */
function persistChartResult(
  chart: ChartEntry,
  chartPath: string,
  snap: ScoreSnapshot
): void {
  const prev = chart.record ?? null;
  const merged = mergeChartRecord(chartPath, prev, snap);
  chart.record = merged;
  saveChartRecord(merged).catch((e) =>
    console.warn('[records] failed to persist', chartPath, e)
  );
}

async function startChart(chart: ChartEntry): Promise<void> {
  if (!library) throw new Error('no library loaded');
  const text = await library.backend.readText(chart.chartPath);
  await launchGame(
    text,
    { backend: library.backend, folder: dirname(chart.chartPath) },
    chart
  );
}

async function playDemo(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo.dtx`);
  if (!res.ok) throw new Error(`failed to load demo.dtx: ${res.status}`);
  // Demo ships without accompanying WAVs or a scanner chart — skip
  // records entirely for the bundled chart.
  await launchGame(await res.text());
}

async function launchGame(
  dtxText: string,
  fs?: GameFsContext,
  chart?: ChartEntry
): Promise<void> {
  // activeGame is created eagerly at module init. We always reuse it —
  // Game.loadAndStart resets state (audio, samples, pad buffers, gauge)
  // so a fresh chart picks up cleanly, and reusing avoids destroying /
  // recreating the WebGLRenderer which would leak XR / canvas state.
  const game = activeGame;
  if (!game) {
    setStatus('Game not initialised — reload the page.');
    return;
  }
  const startOpts: Parameters<Game['loadAndStart']>[1] = {
    onRestart: () => {
      if (game.inXR) {
        // In VR: re-show the menu panel so the player can pick again without
        // taking off the headset.
        showVrMenuForActive(fs);
      } else {
        overlay.style.display = 'grid';
        setStatus('Pick another chart or change folder.');
        refreshXrButton();
      }
    },
    // Finish-event plumbing: only scanner-backed charts persist records.
    // The bundled demo has no stable ID so we skip it. Practice runs
    // (non-1 rate or loop enabled) also skip — DTXmania guards best
    // scores on PlaySpeed (C# commit d4faf41) and we mirror that here.
    ...(chart
      ? {
          chartPath: chart.chartPath,
          onChartFinished: (
            chartPath: string,
            snap: ScoreSnapshot,
            didLoop: boolean,
          ) => {
            if (isPracticeRun(getConfig(), didLoop)) {
              console.info('[result] practice run — skipping best-score write');
              return;
            }
            persistChartResult(chart, chartPath, snap);
          },
        }
      : {}),
    onLoopMarkerCaptured: (which, measure) => {
      // VR right-controller face button fired captureLoopMarker and
      // already resolved the measure via snapSongMsToMeasure; delegate
      // the config write + HUD toast to commitLoopCapture so feedback
      // is identical across all three capture paths (keyboard / modal
      // / VR).
      commitLoopCapture(which, measure);
    },
    autoPlayLanes: autoPlayToLanes(getConfig().autoPlay),
  };
  if (fs) {
    setStatus('Loading samples…');
    startOpts.fs = {
      ...fs,
      onProgress: (loaded, total) => {
        setStatus(`Loading samples… ${loaded}/${total}`);
      },
    };
  }
  // Drop any in-flight preview audio + cover art so gameplay audio isn't
  // mixed against it and the object URL gets freed.
  if (pendingPreviewTimer !== null) {
    clearTimeout(pendingPreviewTimer);
    pendingPreviewTimer = null;
  }
  previewPlayer?.stop(120);
  try {
    game.hideVrMenu();
    await game.loadAndStart(dtxText, startOpts);
    overlay.style.display = 'none';
    refreshXrButton();
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

function showVrMenuForActive(fs?: GameFsContext): void {
  if (!activeGame || !library) return;
  const lib = library;
  activeGame.showVrMenu(
    lib.root,
    (pick) => {
      run(async () => {
        const text = await lib.backend.readText(pick.chart.chartPath);
        await launchGame(
          text,
          { backend: lib.backend, folder: dirname(pick.chart.chartPath) },
          pick.chart
        );
      });
      // Silence unused warning; fs is carried through the new launchGame call.
      void fs;
    },
    () => {
      // Exit button → end the XR session; enterXR's onEnded handler cleans up.
      const session = (activeGame as Game).display.webgl.xr.getSession();
      session?.end().catch(() => {});
    },
    {
      loadBytes: (path) => lib.backend.readFile(path),
      joinPath: (folder, rel) => joinPath(folder, rel),
      onFocusedSong: (song) => {
        // Reuse the desktop preview pipeline — schedulePreview already
        // handles the 600 ms debounce and stop-on-replace, so VR wheel
        // scrolling gets the same feel.
        schedulePreview(song);
      },
      onCalibrate: () => {
        if (!activeGame) return;
        // Stop the preview clip so its tail doesn't overlap the metronome
        // clicks while the player is listening for beats.
        schedulePreview(null);
        activeGame.hideVrMenu();
        activeGame.showVrCalibrate((offsetMs) => {
          if (offsetMs !== null) {
            saveAudioOffsetMs(offsetMs);
            showToast(`Latency offset: ${Math.round(offsetMs)} ms`);
          }
          activeGame?.hideVrCalibrate();
          showVrMenuForActive(fs);
        });
      },
      onConfig: () => {
        if (!activeGame) return;
        schedulePreview(null);
        activeGame.hideVrMenu();
        activeGame.showVrConfig(() => {
          activeGame?.hideVrConfig();
          showVrMenuForActive(fs);
        });
      },
    }
  );
}

function refreshXrButton(): void {
  // Show Enter VR as soon as there's a library loaded OR a chart in progress,
  // so players can jump into VR and pick a song from the in-headset menu
  // without having to start one on the desktop first.
  const eligible = Boolean(library || activeGame);
  if (!navigator.xr) {
    console.info('[xr] navigator.xr absent — Enter VR stays hidden');
    xrBtn.style.display = 'none';
    return;
  }
  if (!eligible) {
    xrBtn.style.display = 'none';
    return;
  }
  navigator.xr
    .isSessionSupported('immersive-vr')
    .then((supported) => {
      console.info('[xr] isSessionSupported(immersive-vr) =', supported);
      xrBtn.style.display = supported ? 'inline-block' : 'none';
    })
    .catch((e) => {
      console.warn('[xr] isSessionSupported threw', e);
      xrBtn.style.display = 'none';
    });
}

console.info('[boot] attaching Enter VR click handler — xrBtn exists =', !!xrBtn);
// Backup diagnostic: if 'click' never fires but 'pointerdown' does, the click
// is being swallowed by something after the initial press.
xrBtn.addEventListener('pointerdown', () => console.info('[xr] Enter VR pointerdown'));
xrBtn.addEventListener('click', () => {
  // Must stay on the synchronous path to requestSession() so Quest Browser
  // keeps the user-activation token. Any awaited work (skin, chart, menu)
  // is scheduled AFTER enterXR has kicked off.
  console.info('[xr] Enter VR clicked');
  if (!activeGame) {
    console.warn('[xr] activeGame not ready');
    setStatus('Game not initialised — reload the page and try again.');
    return;
  }
  const game = activeGame;
  const enterPromise = game.enterXR(() => {
    console.info('[xr] session ended');
    setStatus('Exited VR.');
    overlay.style.display = 'grid';
    refreshXrButton();
  });
  overlay.style.display = 'none';
  setStatus('Entering VR…');
  enterPromise
    .then(() => {
      console.info('[xr] session started');
      setStatus('In VR — use controllers to play.');
      if (library && !game.hasChart) showVrMenuForActive();
    })
    .catch((e) => {
      console.error('[xr] enterXR failed', e);
      overlay.style.display = 'grid';
      setStatus(`VR failed: ${e instanceof Error ? e.message : String(e)}`);
    });
});

function run(fn: () => Promise<void>): void {
  fn().catch((e) => {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Error: ${msg}`);
  });
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}


function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // Vite dev server serves modules; skip SW in dev.
  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((e) => console.warn('service worker registration failed', e));
  });
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

async function safeQueryPermission(h: FileSystemHandle): Promise<PermissionState | 'unknown'> {
  try {
    return await h.queryPermission({ mode: 'read' });
  } catch {
    return 'unknown';
  }
}

async function safeRequestPermission(h: FileSystemHandle): Promise<PermissionState | 'unknown'> {
  try {
    return await h.requestPermission({ mode: 'read' });
  } catch {
    return 'unknown';
  }
}
