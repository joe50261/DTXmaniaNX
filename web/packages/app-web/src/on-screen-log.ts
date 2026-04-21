/**
 * On-screen console log panel.
 *
 * Quest Browser has no DevTools, so the console.info / console.warn we
 * sprinkled through the XR lifecycle can't be read without a USB debugger
 * the player likely doesn't have. This mirrors console output to a DOM
 * panel pinned to the bottom-left of the viewport so diagnostics are
 * visible in-page (and screenshottable).
 *
 * Hooks:
 *   - console.log / info / warn / error: delegate to the real console,
 *     then append a coloured row.
 *   - window error: any uncaught exception.
 *   - window unhandledrejection: any rejected promise that nothing caught.
 *
 * Ring buffer capped at 80 rows — oldest entries fall off the top.
 */

const MAX_ROWS = 80;

type Level = 'log' | 'info' | 'warn' | 'error';

const LEVEL_COLOR: Record<Level, string> = {
  log: '#9ca3af',
  info: '#60a5fa',
  warn: '#fbbf24',
  error: '#f87171',
};

let installed = false;

export function installOnScreenLog(): void {
  if (installed) return;
  installed = true;

  const panel = document.createElement('div');
  panel.id = 'on-screen-log';
  document.body.appendChild(panel);

  const hookMethods: Level[] = ['log', 'info', 'warn', 'error'];
  for (const level of hookMethods) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      append(panel, level, args);
    };
  }

  window.addEventListener('error', (e) => {
    append(panel, 'error', [
      'window.onerror:',
      e.message,
      e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
    ]);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    append(panel, 'error', [
      'unhandledrejection:',
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
    ]);
  });

  append(panel, 'info', ['[log] on-screen console installed']);
}

function append(panel: HTMLDivElement, level: Level, args: unknown[]): void {
  const row = document.createElement('div');
  row.style.color = LEVEL_COLOR[level];
  row.style.whiteSpace = 'pre-wrap';
  row.style.wordBreak = 'break-word';
  row.style.lineHeight = '1.35';
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  row.textContent = `${ts} ${level.padEnd(5)} ${args.map(stringify).join(' ')}`;
  panel.appendChild(row);
  while (panel.childElementCount > MAX_ROWS) {
    panel.firstElementChild?.remove();
  }
  panel.scrollTop = panel.scrollHeight;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
