/// <reference types="vite/client" />
import { installOnScreenLog } from './on-screen-log.js';
installOnScreenLog();

import {
  buildMetaCache,
  deserializeIndex,
  dirname,
  flattenSongs,
  joinPath,
  mergeChartRecord,
  serializeIndex,
  SongScanner,
  type BoxNode,
  type CachedChartMeta,
  type ChartEntry,
  type ChartRecord,
  type LibraryNode,
  type ScoreSnapshot,
  type SerializedIndex,
  type SongEntry,
  type SongIndex,
} from '@dtxmania/dtx-core';
import { Game, type GameFsContext } from './game.js';
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
import { HandleFileSystemBackend, type AppFileSystemBackend } from './fs/handle-backend.js';
import { ZipAwareBackend } from './fs/zip-backend.js';
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
import {
  clearFolderCache,
  loadFolderCache,
  saveFolderCache,
} from './fs/folder-cache.js';
import { loadSkin } from './skin.js';
import type { SkinTextures } from './renderer.js';
import { runCalibration } from './calibrate.js';
import { loadAudioOffsetMs, saveAudioOffsetMs } from './calibrate-model.js';
import { createReplayCapture } from './replay/capture-glue.js';
import { ReplaysPanel } from './replay/replays-panel.js';
import {
  renderReplayToBlob,
  suggestFilename,
  triggerDownload,
} from './replay/render.js';
import {
  endJob,
  idleJobState,
  isCurrentJob,
  isJobRunning,
  startJob,
} from './replay/render-job-model.js';
import { RenderWakeLock } from './replay/wake-lock.js';
import { loadReplay } from './replay/storage.js';
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
const fullRescanBtn = requireEl<HTMLButtonElement>('full-rescan-folder');
const calibrateBtn = requireEl<HTMLButtonElement>('calibrate');
const configBtn = requireEl<HTMLButtonElement>('config-btn');
const replaysBtn = requireEl<HTMLButtonElement>('replays-btn');
const xrBtn = requireEl<HTMLButtonElement>('enter-xr');
const songSelectMount = requireEl<HTMLDivElement>('song-select-mount');
const scanErrorsEl = requireEl<HTMLDivElement>('scan-errors');
const sortBtn = requireEl<HTMLButtonElement>('sort-btn');
const searchBox = requireEl<HTMLInputElement>('search-box');

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
  if (!songSelect) return;
  searchBox.classList.add('visible');
  searchBox.value = songSelect.getSearchQuery();
  searchBox.focus();
  searchBox.select();
}

function closeSearch(): void {
  searchBox.value = '';
  songSelect?.setSearchQuery('');
  searchBox.classList.remove('visible');
  searchBox.blur();
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

// Single source of truth for the song-select view, shared between
// desktop and VR. The Game constructed it (it owns the Three.js plane
// + CanvasTexture); the desktop driver mounts the underlying canvas
// element into the overlay below so the player sees the same wheel
// they would in VR. Null only when WebGL init failed at boot.
const songSelect = activeGame?.songSelect ?? null;
if (songSelect) {
  songSelect.setDesktopMode(true);
  // Inject the canvas into the overlay where the legacy DOM SongWheel
  // used to live. CSS scales it down to the panel width (1280×720
  // logical → ~720×405 rendered). Same canvas remains the
  // CanvasTexture source for VR — both renders read from the same
  // element, no contention.
  const el = songSelect.getCanvasElement();
  el.classList.add('song-select-canvas');
  songSelectMount.appendChild(el);

  // Pointer events for hover + click. Coordinates are scaled from
  // CSS pixels back to the logical 1280×720 canvas grid the hit-rects
  // live in.
  const toCanvasCoords = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
    const rect = el.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * el.width,
      y: ((e.clientY - rect.top) / rect.height) * el.height,
    };
  };
  el.addEventListener('pointermove', (e) => {
    const { x, y } = toCanvasCoords(e);
    songSelect.dispatchPointerMove(x, y);
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // left-click only
    const { x, y } = toCanvasCoords(e);
    songSelect.dispatchPointerDown(x, y);
  });

  // Keyboard nav: arrows + Enter + Escape. Window-level so the player
  // doesn't have to focus the canvas first. Skipped while typing in
  // an input (search box) and while the overlay is hidden (chart
  // playing) — same gates the legacy SongWheel checked.
  window.addEventListener('keydown', (e) => {
    if (overlay.style.display === 'none') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (songSelect.dispatchKey(e)) e.preventDefault();
  });
}

sortBtn.addEventListener('click', () => {
  if (!songSelect) return;
  const mode = songSelect.cycleSortMode();
  sortBtn.textContent = `Sort: ${mode}`;
});

// `/` opens the search box; typing filters live; Esc clears + closes.
// While focused, the search box swallows arrow keys (text caret nav),
// so the canvas's keydown handler above no-ops thanks to the
// INPUT-tagName guard.
searchBox.addEventListener('input', () => {
  songSelect?.setSearchQuery(searchBox.value);
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
window.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (overlay.style.display === 'none') return;
  e.preventDefault();
  openSearch();
});

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

interface Library {
  handle: FileSystemDirectoryHandle;
  backend: AppFileSystemBackend;
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
    // Remove the on-disk cache we wrote into the folder before we let go of
    // the handle — "Forget" should clean up our own artifact, not leave an
    // orphaned file behind. Best-effort (needs write permission + a live
    // backend); a read-only grant just leaves the inert JSON in place.
    if (library) await clearFolderCache(library.backend);
    await clearRootHandle();
    await clearScanCache().catch(() => {});
    // Medals belong to the library the player is switching away from;
    // dropping the folder means dropping its score history too.
    await clearChartRecords().catch(() => {});
    library = null;
    songSelect?.setRoot(null);
    activeGame?.hideSongSelect();
    forgetBtn.style.display = 'none';
    rescanBtn.style.display = 'none';
    fullRescanBtn.style.display = 'none';
    pickBtn.textContent = 'Pick folder';
    onPick = pickAndScan;
    setStatus('Pick your Songs folder to begin.');
    refreshXrButton();
  })
);

rescanBtn.addEventListener('click', () =>
  run(async () => {
    if (!library || scanInFlight) return;
    // Incremental rescan: re-walk the folder tree (that is how added /
    // removed songs and set.def edits are discovered) but reuse the
    // header-derived meta of every chart the current library already knows,
    // so only NEW charts pay a header read. The snapshot comes from the
    // in-memory tree — it IS the cache content (loaded from cache or fresh
    // scan) — so no store read races the clears below. Charts edited
    // in place keep their cached meta; that's what "Full rescan" is for.
    const metaCache = buildMetaCache(library.songs);
    // Drop both cache copies so a stale index can't be read back before the
    // fresh scan below overwrites them.
    await clearScanCache().catch(() => {});
    await clearFolderCache(library.backend);
    await scanIntoLibrary(library.handle, { forceRescan: true, metaCache });
  })
);

fullRescanBtn.addEventListener('click', () =>
  run(async () => {
    if (!library || scanInFlight) return;
    // Full rescan: no meta reuse — every chart header is re-read. The
    // escape hatch for charts edited in place, which the incremental
    // path above deliberately trusts by path (see ScanOptions.metaCache).
    await clearScanCache().catch(() => {});
    await clearFolderCache(library.backend);
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

// Replays browser — desktop-only entry. The Render button drives the
// WebCodecs pipeline in `replay/render.ts`; the panel surfaces
// phase-aware progress + a log scrollback so a long silent render
// doesn't look like a hang.
//
// Job management (see replay/render-job-model.ts for the rationale):
// exactly one render at a time. The typical workflow is click Render →
// take the headset off → device sleeps → page freezes mid-render →
// thaws on wake with the job still running. A second Render click in
// that state must surface the live job's progress, NOT start a
// competing render that interleaves writes into the same progress bar.
let renderJobState = idleJobState();
let renderAbort: AbortController | null = null;
const renderWakeLock = new RenderWakeLock();

const replaysPanel = new ReplaysPanel({
  onRender: (id) => {
    // Single-flight guard, synchronously BEFORE the first await — two
    // clicks in the same frame must not both pass an async check.
    if (isJobRunning(renderJobState)) {
      replaysPanel.resumeRenderView();
      setStatus('A render is already in progress — showing it.');
      return;
    }
    if (!library) {
      setStatus('Pick your songs folder first — render needs WAV access.');
      return;
    }
    const lib = library;
    const started = startJob(renderJobState, id)!;
    renderJobState = started.state;
    const token = started.token;
    const controller = new AbortController();
    renderAbort = controller;
    // Reset the render pane to THIS job synchronously — a re-click
    // landing during the loads below resumes into the new job's
    // (empty) pane, never the previous job's finished one.
    replaysPanel.showRender('…');
    run(async () => {
      try {
        const replay = await loadReplay(id);
        if (!replay) {
          replaysPanel.hideRender();
          setStatus('Replay not found (it may have been deleted).');
          return;
        }
        let chartText: string;
        try {
          chartText = await lib.backend.readText(replay.meta.chartPath);
        } catch (e) {
          replaysPanel.hideRender();
          setStatus(
            `Render failed: chart not in current folder (${replay.meta.chartPath}).`,
          );
          console.warn('[render] readText failed', e);
          return;
        }
        const rowTitle = replay.meta.title ?? replay.meta.chartPath;
        replaysPanel.showRender(rowTitle);
        replaysPanel.appendRenderLog(`Source: ${replay.meta.chartPath}`);
        setStatus('Rendering replay… see the panel for progress.');
        // Keep the device awake for the duration where the platform
        // allows it — the render otherwise freezes with the page when
        // the screen sleeps and only resumes on the next wake.
        await renderWakeLock.acquire((line) => replaysPanel.appendRenderLog(line));
        // Stale-callback fence: once this job is no longer current
        // (cancelled and a new one started), its late progress/log
        // emits must not repaint the newer job's panel.
        const ifCurrent = (fn: () => void): void => {
          if (isCurrentJob(renderJobState, token)) fn();
        };
        try {
          const skin = await skinPromise.catch(() => undefined);
          const result = await renderReplayToBlob(replay, chartText, {
            fs: { backend: lib.backend, folder: dirname(replay.meta.chartPath) },
            ...(skin ? { skin } : {}),
            signal: controller.signal,
            onProgress: (p) => ifCurrent(() => replaysPanel.updateRenderProgress(p)),
            onLog: (line) => ifCurrent(() => replaysPanel.appendRenderLog(line)),
          });
          const filename = suggestFilename(replay, result.ext);
          // Surface "Save video" BEFORE the automatic download attempt:
          // if the tab is hidden right now (headset set down), browsers
          // drop the programmatic click and the button is the only way
          // the user can still reach the finished file.
          replaysPanel.finishRender(() => triggerDownload(result.blob, filename));
          triggerDownload(result.blob, filename);
          if (document.hidden) {
            replaysPanel.appendRenderLog(
              'Finished while the tab was hidden — use "Save video" if no download started.',
            );
          }
          replaysPanel.appendRenderLog('Download triggered.');
          setStatus(`Render done — saved as ${result.ext.toUpperCase()}.`);
        } catch (e) {
          replaysPanel.finishRender(null);
          if (controller.signal.aborted) {
            replaysPanel.appendRenderLog('Render cancelled.');
            setStatus('Render cancelled.');
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          replaysPanel.appendRenderLog(`ERROR: ${msg}`);
          setStatus(`Render failed: ${msg}`);
          console.warn('[render] renderReplayToBlob failed', e);
        }
        // Render overlay stays visible after completion (success or
        // failure) so the user can read the final log line + size.
        // They dismiss via "Back to replays" or the modal ✕.
      } finally {
        void renderWakeLock.release();
        renderAbort = null;
        renderJobState = endJob(renderJobState, token);
      }
    });
  },
  onCancelRender: () => {
    if (!renderAbort) return;
    replaysPanel.appendRenderLog('Cancel requested…');
    renderAbort.abort();
  },
});
replaysBtn.addEventListener('click', () => {
  replaysPanel.open().catch((e) => console.warn('[replays] open failed', e));
});

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
  // Ask for persistent storage up front. Our IndexedDB holds the picked
  // directory handle AND the scan cache; if it stays "best-effort" the Quest
  // browser evicts it between sessions, losing both and forcing a full
  // re-pick + rescan every launch. This is the root cause of the "cache
  // keeps getting invalidated" bug. Best-effort + idempotent.
  void requestPersistentStorage();

  if (!('showDirectoryPicker' in window)) {
    pickBtn.disabled = true;
    setStatus(
      "This browser doesn't support the File System Access API — only the demo chart is playable. Try Chrome, Edge, or Quest Browser."
    );
    return;
  }

  const stored = await loadRootHandle().catch(() => null);
  if (!stored) return;

  // Gate the auto-scan on READ — that's all the app needs to serve the
  // library, so a user who granted only read (or whose install persisted a
  // read grant) still boots straight into their songs without a forced
  // reconnect. Write access for the folder cache is pursued separately, on a
  // gesture, and is never required.
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
      const granted = await regrantFolderAccess(stored);
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
    // 'readwrite' so we can drop the durable scan-cache file into the folder.
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dtxmania-songs' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    throw e;
  }
  // We're inside a user gesture here — the best moment to (re)request a
  // persistent-storage grant, which the browser is far likelier to allow
  // after engagement than on a cold boot.
  void requestPersistentStorage();
  await saveRootHandle(handle).catch((e) => console.warn('failed to persist handle', e));
  // Drop the IndexedDB cache — its single slot belonged to whatever folder we
  // had before. We deliberately do NOT force a rescan: the folder we just
  // picked carries its own durable cache file, so if this folder was scanned
  // before (this device or another, even after an IDB eviction) we load it
  // instantly instead of re-walking. A genuinely new folder has no cache file
  // and falls through to a full scan.
  await clearScanCache().catch(() => {});
  await scanIntoLibrary(handle);
}

/**
 * True while a scanIntoLibrary call is running. Scans take tens of seconds
 * on the target device, so overlapping triggers are realistic (Rescan
 * clicked during a Full rescan, or vice versa) — and whichever scan
 * finished LAST would win applyLibrary + both cache stores, silently
 * replacing a fresh full-rescan index with a stale incremental one. The
 * scan buttons are disabled while set; the handlers also early-return on
 * it so a queued click can't clear the caches out from under a running
 * scan.
 */
let scanInFlight = false;

async function scanIntoLibrary(
  handle: FileSystemDirectoryHandle,
  opts: {
    forceRescan?: boolean;
    /** Chart meta from the previous index — turns the walk below into an
     * incremental rescan where only unknown charts pay a header read. */
    metaCache?: ReadonlyMap<string, CachedChartMeta>;
  } = {}
): Promise<void> {
  if (scanInFlight) return;
  scanInFlight = true;
  rescanBtn.disabled = true;
  fullRescanBtn.disabled = true;
  pickBtn.disabled = true;
  forgetBtn.disabled = true;
  try {
    await scanIntoLibraryInner(handle, opts);
  } finally {
    scanInFlight = false;
    rescanBtn.disabled = false;
    fullRescanBtn.disabled = false;
    pickBtn.disabled = false;
    forgetBtn.disabled = false;
  }
}

async function scanIntoLibraryInner(
  handle: FileSystemDirectoryHandle,
  opts: {
    forceRescan?: boolean;
    metaCache?: ReadonlyMap<string, CachedChartMeta>;
  }
): Promise<void> {
  // Zip-aware wrapper: presents any `foo.zip` in the Songs folder as a
  // browsable directory so the scanner reads charts/audio straight out of the
  // archive — no extraction, the folder is never modified. Non-zip paths pass
  // straight through to the handle backend.
  const backend = new ZipAwareBackend(new HandleFileSystemBackend(handle));

  // Cache path: SongScanner.scan() on Quest 3 is slow enough (~50s/30
  // songs observed in playtest) to warrant boot-time persistence. We save
  // the SerializedIndex after each successful scan into TWO stores — the
  // fast IndexedDB slot and a durable JSON file in the Songs folder — and
  // on subsequent boots load whichever survived, only falling through to a
  // fresh walk when both are missing/corrupt or the user hit "Rescan".
  // Validity isn't mtime-checked — expecting the user to press Rescan after
  // adding songs keeps the cache simple and the boot instantaneous. Rescan
  // itself is incremental (opts.metaCache reuses known charts' meta);
  // "Full rescan" re-reads everything.
  if (!opts.forceRescan) {
    const hit = await loadCachedIndex(backend);
    if (hit) {
      await attachRecordsToIndex(hit.index);
      applyLibrary(handle, backend, hit.index);
      const ageMin = Math.max(0, Math.round((Date.now() - hit.serialized.scannedAtMs) / 60000));
      const where = hit.source === 'folder' ? 'folder cache' : 'cache';
      setStatus(
        `Loaded ${hit.index.songs.length} song(s) from ${where} (scan was ${ageMin} min ago). ` +
          `Hit Rescan if you changed the folder.`
      );
      return;
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
    ...(opts.metaCache ? { metaCache: opts.metaCache } : {}),
  });
  const index = await scanner.scan('');
  await attachRecordsToIndex(index);
  applyLibrary(handle, backend, index);
  const stats = index.metaStats;
  setStatus(
    stats && stats.reused > 0
      ? `Scanned ${index.songs.length} song(s) in "${handle.name}" ` +
          `(${stats.read} new chart(s) read, ${stats.reused} reused from cache).`
      : `Scanned ${index.songs.length} song(s) in "${handle.name}".`
  );
  // serializeIndex strips the per-chart play records that attachRecordsToIndex
  // just wrote onto the tree (see serializeSongEntry), so both cache copies
  // stay record-free — the folder file must never carry medals earned on this
  // device to another whose record store is empty.
  const serialized = serializeIndex(index);
  await saveScanCache(serialized).catch((e) =>
    console.warn('[scan-cache] failed to persist to IndexedDB', e)
  );
  // Durable copy inside the folder — survives IndexedDB eviction (the Quest
  // browser evicts best-effort storage between sessions) and travels with a
  // copied Songs folder. Best-effort: a read-only grant just skips it and
  // the app keeps working off the IndexedDB cache.
  const wroteFolder = await saveFolderCache(backend, serialized);
  if (!wroteFolder) {
    console.info('[scan-cache] folder copy skipped (folder not writable)');
  }
}

/**
 * Resolve a usable cached index without walking the folder. Tries the
 * durable folder-resident cache first (tied to this exact folder, survives
 * IndexedDB eviction and travels with the folder), then the fast IndexedDB
 * slot. On a hit from one store the other is healed in the background, so a
 * future eviction — or the same folder opened on another device — is still
 * covered. Returns null when neither store holds a valid, version-compatible
 * cache. deserializeIndex throws only on a version mismatch; that's caught
 * per-store so an incompatible copy is dropped rather than crashing boot.
 */
async function loadCachedIndex(
  backend: AppFileSystemBackend
): Promise<{ index: SongIndex; serialized: SerializedIndex; source: 'folder' | 'idb' } | null> {
  try {
    const folder = await loadFolderCache(backend);
    if (folder) {
      const index = deserializeIndex(folder);
      // Warm the fast path so the next boot skips even the file read.
      void saveScanCache(folder).catch(() => {});
      return { index, serialized: folder, source: 'folder' };
    }
  } catch (e) {
    console.info('[scan-cache] folder copy invalid/incompatible, ignoring', e);
    await clearFolderCache(backend);
  }

  try {
    const idb = await loadScanCache();
    if (idb) {
      const index = deserializeIndex(idb);
      // Persist a durable copy so the next IndexedDB eviction is survivable.
      void saveFolderCache(backend, idb);
      return { index, serialized: idb, source: 'idb' };
    }
  } catch (e) {
    console.info('[scan-cache] IndexedDB copy invalid/incompatible, ignoring', e);
    await clearScanCache().catch(() => {});
  }

  return null;
}

/** Shared "the library is now X" commit step used by both cache-hit and
 * fresh-scan paths. Keeps the two paths from diverging on what they
 * wire up. */
function applyLibrary(
  handle: FileSystemDirectoryHandle,
  backend: AppFileSystemBackend,
  index: SongIndex
): void {
  library = { handle, backend, root: index.root, songs: flattenSongs(index.root) };
  pickBtn.textContent = 'Change folder';
  forgetBtn.style.display = 'inline-block';
  rescanBtn.style.display = 'inline-block';
  fullRescanBtn.style.display = 'inline-block';
  // Drive the canvas: setRoot updates the entry list in place; show()
  // (via showSongSelectForActive) lights up the panel and hooks up
  // the preview-audio + chart-launch callbacks. Skip the show() if a
  // chart is already playing — the player's mid-song and the canvas
  // shouldn't grab focus until they return.
  songSelect?.setRoot(index.root);
  if (!activeGame?.hasChart) showSongSelectForActive();
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
    // Fall through with an empty map so the loop below CLEARS any records,
    // rather than leaving stale ones in place.
    records = new Map();
  }
  // Authoritative pass: set each chart's record to the store's value, or
  // clear it when the store has none. The clear matters because a scan cache
  // — especially the folder file copied from another device — can carry
  // records this device never earned; the source serializer strips them, but
  // clearing here is a belt-and-suspenders guard against a legacy cache blob.
  const visit = (node: LibraryNode): void => {
    if (node.type === 'song') {
      for (const chart of node.entry.charts) {
        const rec = records.get(chart.chartPath);
        if (rec) chart.record = rec;
        else delete chart.record;
      }
    } else {
      for (const c of node.children) visit(c);
    }
  };
  visit(index.root);
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
  // Replay capture is sidecar — only attached for scanner-backed charts
  // (the bundled demo has no stable chartPath, so a saved replay
  // wouldn't bind back to anything). The lanes set is captured by
  // value here so a config change mid-run doesn't retroactively
  // mutate the capture's autoplay set.
  const autoLanes = new Set<LaneValue>(autoPlayToLanes(getConfig().autoPlay));
  const capture = chart ? createReplayCapture(autoLanes) : null;
  const startOpts: Parameters<Game['loadAndStart']>[1] = {
    onRestart: () => {
      // Same call on desktop and VR — Game.showSongSelect both (a)
      // hides the playfield (no-op on desktop) and (b) lights up the
      // canvas plane / DOM canvas. The caller-supplied onExit is
      // session.end() which is a no-op outside an XRSession, so the
      // desktop "Esc" path still relies on overlay.style.display.
      if (!game.inXR) {
        overlay.style.display = 'grid';
        setStatus('Pick another chart or change folder.');
        refreshXrButton();
      }
      showSongSelectForActive(fs);
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
            const practice = isPracticeRun(getConfig(), didLoop);
            if (practice) {
              console.info('[result] practice run — skipping best-score write');
            } else {
              persistChartResult(chart, chartPath, snap);
            }
            // Replay capture mirrors the practice gate: practice runs
            // (loop or non-1 rate) are dropped; real runs persist via
            // saveReplay. Errors are swallowed with a console log —
            // a failed replay save shouldn't block the result-screen
            // transition the player is waiting on.
            if (capture) {
              if (practice) capture.discard();
              else {
                capture.finish(snap).catch((e) =>
                  console.warn('[replay] saveReplay failed', e),
                );
              }
            }
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
    autoPlayLanes: autoLanes,
    ...(capture
      ? {
          onHitProcessed: capture.onHit,
          onTickPose: capture.onPose,
        }
      : {}),
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
    game.hideSongSelect();
    await game.loadAndStart(dtxText, startOpts);
    overlay.style.display = 'none';
    refreshXrButton();
    // Replay capture must start AFTER loadAndStart resolves so the
    // chart's parsed title / artist / durationMs are available via
    // `game.chartMeta()`. Pre-start emissions (auto-fire on the very
    // first tick, etc.) are silently dropped by the Recorder.
    if (capture && chart) {
      const meta = game.chartMeta();
      if (meta) {
        capture.start(
          {
            chartPath: chart.chartPath,
            title: meta.title,
            artist: meta.artist,
            durationMs: meta.durationMs,
          },
          {
            audioOffsetMs: loadAudioOffsetMs(),
            autoPlayLanes: [...autoLanes],
          },
        );
      }
    }
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

function showSongSelectForActive(fs?: GameFsContext): void {
  if (!activeGame || !library) return;
  const lib = library;
  // Footer mode is keyed off inXR rather than baked into desktop boot:
  // a desktop session that enters and exits VR needs the footer to
  // come and go each time, and a desktop boot then upgraded to VR
  // would otherwise stay footer-less inside the headset.
  songSelect?.setDesktopMode(!activeGame.inXR);
  activeGame.showSongSelect(
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
        activeGame.hideSongSelect();
        activeGame.showVrCalibrate((offsetMs) => {
          if (offsetMs !== null) {
            saveAudioOffsetMs(offsetMs);
            showToast(`Latency offset: ${Math.round(offsetMs)} ms`);
          }
          activeGame?.hideVrCalibrate();
          showSongSelectForActive(fs);
        });
      },
      onConfig: () => {
        if (!activeGame) return;
        schedulePreview(null);
        activeGame.hideSongSelect();
        activeGame.showVrConfig(() => {
          activeGame?.hideVrConfig();
          showSongSelectForActive(fs);
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
    // Re-bring up the desktop canvas: Game.enterXR's onEnded already
    // hid songSelect (so the in-VR footer wouldn't flash on the
    // desktop overlay during teardown). showSongSelectForActive both
    // re-shows it and flips desktopMode back on.
    if (library && !game.hasChart) showSongSelectForActive();
  });
  overlay.style.display = 'none';
  setStatus('Entering VR…');
  enterPromise
    .then(() => {
      console.info('[xr] session started');
      setStatus('In VR — use controllers to play.');
      if (library && !game.hasChart) showSongSelectForActive();
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

async function safeQueryPermission(
  h: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'read'
): Promise<PermissionState | 'unknown'> {
  try {
    return await h.queryPermission({ mode });
  } catch {
    return 'unknown';
  }
}

async function safeRequestPermission(
  h: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'read'
): Promise<PermissionState | 'unknown'> {
  try {
    return await h.requestPermission({ mode });
  } catch {
    return 'unknown';
  }
}

/**
 * Re-grant access to a saved folder on a user gesture. The app only *needs*
 * read (the scanner never writes); 'readwrite' is preferred so we can also
 * persist the durable folder-cache file. So: ask for readwrite first, and if
 * the user declines the write upgrade, fall back to a read grant rather than
 * locking them out of a library we can serve read-only. Returns 'granted'
 * when at least read access is available.
 */
async function regrantFolderAccess(h: FileSystemHandle): Promise<PermissionState | 'unknown'> {
  const rw = await safeRequestPermission(h, 'readwrite');
  if (rw === 'granted') return 'granted';
  // Write declined/unavailable — an existing read grant (returning user) is
  // enough and needs no second prompt; otherwise ask specifically for read.
  const read = await safeQueryPermission(h, 'read');
  if (read === 'granted') return 'granted';
  return safeRequestPermission(h, 'read');
}

/**
 * Ask the browser to keep our IndexedDB origin data as *persistent* rather
 * than *best-effort* storage. Best-effort data (the default) is evicted by
 * the Quest / Chromium-Android browser under storage pressure or after
 * inactivity, which wipes the directory handle + scan cache and is the
 * dominant cause of the "it rescans every session" bug. Idempotent and
 * best-effort — a denied or unavailable request changes nothing.
 */
async function requestPersistentStorage(): Promise<void> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return;
    if (await storage.persisted()) return;
    const granted = await storage.persist();
    console.info(`[storage] persistent storage ${granted ? 'granted' : 'not granted'}`);
  } catch {
    /* Storage API unavailable — IDB stays best-effort, folder cache still helps. */
  }
}
