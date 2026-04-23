/**
 * Pure on-screen log store.
 *
 * Shared by the desktop DOM panel (`on-screen-log.ts`) and an in-VR
 * CanvasTexture view (`vr-on-screen-log.ts`). The DOM panel is useless
 * inside an immersive WebXR session, so the VR path needs its own
 * rendering surface that reads from the same ring buffer — otherwise
 * each side would see a partial log.
 *
 * The console hook itself is also installed from here, once, so we
 * don't double-wrap if both views subscribe.
 */

const MAX_ROWS = 80;

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** performance.now()-style timestamp (absolute ms since navigation
   * start). View code converts to `HH:MM:SS.mmm` for display. */
  timestamp: number;
  level: LogLevel;
  text: string;
}

let buffer: LogEntry[] = [];
const listeners = new Set<(entries: readonly LogEntry[]) => void>();
let hookInstalled = false;

/** Append a row and notify every subscriber. Views don't need to
 * read the buffer themselves unless they want historical scrollback. */
export function appendLog(level: LogLevel, args: unknown[]): void {
  const text = args.map(stringify).join(' ');
  buffer.push({ timestamp: Date.now(), level, text });
  if (buffer.length > MAX_ROWS) buffer.splice(0, buffer.length - MAX_ROWS);
  for (const cb of listeners) cb(buffer);
}

/** Current ring-buffer snapshot. Callers must treat as read-only. */
export function getLog(): readonly LogEntry[] {
  return buffer;
}

/** Subscribe to log updates. Returns an unsubscribe function. */
export function subscribeLog(cb: (entries: readonly LogEntry[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Monkey-patch the global console methods + window error handlers so
 * every log line flows through `appendLog`. Safe to call multiple
 * times (only the first call installs). View code should call this
 * at startup before any other module emits diagnostics.
 */
export function installConsoleHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  const methods: LogLevel[] = ['log', 'info', 'warn', 'error'];
  for (const level of methods) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      appendLog(level, args);
    };
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      appendLog('error', [
        'window.onerror:',
        e.message,
        e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
      ]);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      appendLog('error', [
        'unhandledrejection:',
        reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      ]);
    });
  }
}

/** Test-only: blow away the singleton + listener state so tests don't
 * bleed entries into each other. */
export function resetLogForTest(): void {
  buffer = [];
  listeners.clear();
  hookInstalled = false;
}

export const LOG_MAX_ROWS = MAX_ROWS;

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Format an entry for single-line display. Shared by both views so
 * timestamp precision, padding, and level labelling are identical. */
export function formatLogEntry(entry: LogEntry): string {
  const ts = new Date(entry.timestamp).toISOString().slice(11, 23); // HH:MM:SS.mmm
  return `${ts} ${entry.level.padEnd(5)} ${entry.text}`;
}

/** Palette both views share. DOM uses the CSS colour directly; the VR
 * canvas uses it as a `fillStyle`. */
export const LOG_LEVEL_COLOR: Record<LogLevel, string> = {
  log: '#9ca3af',
  info: '#60a5fa',
  warn: '#fbbf24',
  error: '#f87171',
};
