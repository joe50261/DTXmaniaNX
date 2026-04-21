/// <reference types="vite/client" />
import { installOnScreenLog } from './on-screen-log.js';
installOnScreenLog();

import { dirname, SongScanner, type ChartEntry, type SongEntry } from '@dtxmania/dtx-core';
import { Game, type GameFsContext } from './game.js';
import { SongWheel } from './song-wheel.js';
import { HandleFileSystemBackend } from './fs/handle-backend.js';
import { clearRootHandle, loadRootHandle, saveRootHandle } from './fs/handle-store.js';
import { loadSkin } from './skin.js';
import type { SkinTextures } from './renderer.js';
import { loadAudioOffsetMs, runCalibration, saveAudioOffsetMs } from './calibrate.js';
import { AudioEngine } from '@dtxmania/audio-engine';

const canvas = requireEl<HTMLCanvasElement>('game');
const overlay = requireEl<HTMLDivElement>('overlay');
const statusEl = requireEl<HTMLDivElement>('status');
const pickBtn = requireEl<HTMLButtonElement>('pick-folder');
const demoBtn = requireEl<HTMLButtonElement>('start-demo');
const forgetBtn = requireEl<HTMLButtonElement>('forget-folder');
const calibrateBtn = requireEl<HTMLButtonElement>('calibrate');
const autoKickBtn = requireEl<HTMLButtonElement>('toggle-autokick');
const xrBtn = requireEl<HTMLButtonElement>('enter-xr');
const wheelEl = requireEl<HTMLDivElement>('song-wheel');
const statusPanelEl = requireEl<HTMLDivElement>('status-panel');
const scanErrorsEl = requireEl<HTMLDivElement>('scan-errors');

const songWheel = new SongWheel(wheelEl, statusPanelEl, {
  onStart: (chart) => run(() => startChart(chart)),
  formatLevel,
  isActive: () => overlay.style.display !== 'none',
});
songWheel.attachKeyboard();

// Preload skin PNGs once at boot. Games created later reuse these textures.
const skinPromise: Promise<SkinTextures> = loadSkin(import.meta.env.BASE_URL);

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
} catch (e) {
  // WebGL unavailable — page still usable for non-game actions if any.
  console.warn('Game init failed', e);
}

interface Library {
  handle: FileSystemDirectoryHandle;
  backend: HandleFileSystemBackend;
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
    library = null;
    songWheel.setSongs([]);
    forgetBtn.style.display = 'none';
    pickBtn.textContent = 'Pick folder';
    onPick = pickAndScan;
    setStatus('Pick your Songs folder to begin.');
    refreshXrButton();
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

// Auto-kick (DTXmania bAutoPlay.BD + bAutoPlay.LBD equivalent). Persist via
// localStorage; URL param ?autokick=1 / 0 lets users lock a state without
// touching the UI (handy for demos / recordings). The stored state wins
// over the default OFF when the URL param isn't present.
const AUTOKICK_KEY = 'dtxmania.autokick';
{
  const qs = new URLSearchParams(window.location.search).get('autokick');
  if (qs === '1') localStorage.setItem(AUTOKICK_KEY, '1');
  else if (qs === '0') localStorage.removeItem(AUTOKICK_KEY);
}
function isAutoKickEnabled(): boolean {
  return localStorage.getItem(AUTOKICK_KEY) === '1';
}
function refreshAutoKickLabel(): void {
  autoKickBtn.textContent = `Auto-kick: ${isAutoKickEnabled() ? 'ON' : 'OFF'}`;
}
autoKickBtn.addEventListener('click', () => {
  const next = !isAutoKickEnabled();
  if (next) localStorage.setItem(AUTOKICK_KEY, '1');
  else localStorage.removeItem(AUTOKICK_KEY);
  refreshAutoKickLabel();
  activeGame?.setAutoKick(next);
});
refreshAutoKickLabel();

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
  await scanIntoLibrary(handle);
}

async function scanIntoLibrary(handle: FileSystemDirectoryHandle): Promise<void> {
  setStatus(`Scanning "${handle.name}"…`);
  const backend = new HandleFileSystemBackend(handle);
  const scanner = new SongScanner(backend);
  const index = await scanner.scan('');
  library = { handle, backend, songs: index.songs };
  pickBtn.textContent = 'Change folder';
  forgetBtn.style.display = 'inline-block';
  setStatus(`Found ${index.songs.length} song(s) in "${handle.name}".`);
  songWheel.setSongs(index.songs);
  renderScanErrors(index.errors);
  refreshXrButton();
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

async function startChart(chart: ChartEntry): Promise<void> {
  if (!library) throw new Error('no library loaded');
  const text = await library.backend.readText(chart.chartPath);
  await launchGame(text, { backend: library.backend, folder: dirname(chart.chartPath) });
}

async function playDemo(): Promise<void> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo.dtx`);
  if (!res.ok) throw new Error(`failed to load demo.dtx: ${res.status}`);
  // Demo ships without accompanying WAVs, so no fs context.
  await launchGame(await res.text());
}

async function launchGame(dtxText: string, fs?: GameFsContext): Promise<void> {
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
    autoKick: isAutoKickEnabled(),
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
  activeGame.showVrMenu(
    library.songs,
    (pick) => {
      run(async () => {
        const text = await library!.backend.readText(pick.chart.chartPath);
        await launchGame(text, {
          backend: library!.backend,
          folder: dirname(pick.chart.chartPath),
        });
      });
      // Silence unused warning; fs is carried through the new launchGame call.
      void fs;
    },
    () => {
      // Exit button → end the XR session; enterXR's onEnded handler cleans up.
      const session = (activeGame as Game).display.webgl.xr.getSession();
      session?.end().catch(() => {});
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
