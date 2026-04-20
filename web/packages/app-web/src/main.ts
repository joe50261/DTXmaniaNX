/// <reference types="vite/client" />
import { dirname, SongScanner, type ChartEntry, type SongEntry } from '@dtxmania/dtx-core';
import { Game, type GameFsContext } from './game.js';
import { HandleFileSystemBackend } from './fs/handle-backend.js';
import { clearRootHandle, loadRootHandle, saveRootHandle } from './fs/handle-store.js';

const canvas = requireEl<HTMLCanvasElement>('game');
const overlay = requireEl<HTMLDivElement>('overlay');
const statusEl = requireEl<HTMLDivElement>('status');
const pickBtn = requireEl<HTMLButtonElement>('pick-folder');
const demoBtn = requireEl<HTMLButtonElement>('start-demo');
const forgetBtn = requireEl<HTMLButtonElement>('forget-folder');
const songListEl = requireEl<HTMLDivElement>('song-list');
const scanErrorsEl = requireEl<HTMLDivElement>('scan-errors');

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
    songListEl.replaceChildren();
    forgetBtn.style.display = 'none';
    pickBtn.textContent = 'Pick folder';
    onPick = pickAndScan;
    setStatus('Pick your Songs folder to begin.');
  })
);

void init();

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
  renderSongList(index.songs);
  renderScanErrors(index.errors);
}

function renderSongList(songs: SongEntry[]): void {
  songListEl.replaceChildren();
  if (songs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'song-title';
    empty.style.opacity = '0.5';
    empty.textContent = 'No .dtx charts found in this folder.';
    songListEl.appendChild(empty);
    return;
  }
  for (const song of songs) {
    const row = document.createElement('div');
    row.className = 'song';
    const title = document.createElement('div');
    title.className = 'song-title';
    title.textContent = song.title;
    row.appendChild(title);

    const charts = document.createElement('div');
    charts.className = 'chart-row';
    for (const chart of song.charts) {
      const btn = document.createElement('button');
      btn.className = 'chart-btn';
      btn.textContent = chart.label;
      btn.addEventListener('click', () => run(() => startChart(chart)));
      charts.appendChild(btn);
    }
    row.appendChild(charts);
    songListEl.appendChild(row);
  }
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
  overlay.style.display = 'none';
  const game = new Game(canvas);
  const startOpts: Parameters<Game['loadAndStart']>[1] = {
    onRestart: () => {
      game.stop();
      overlay.style.display = 'grid';
    },
  };
  if (fs) startOpts.fs = fs;
  await game.loadAndStart(dtxText, startOpts);
}

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
